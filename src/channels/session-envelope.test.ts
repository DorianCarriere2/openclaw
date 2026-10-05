import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { prepareChannelInboundEnvelopeBuilder } from "./inbound-event/envelope.js";
import { resolveInboundSessionEnvelopeContext } from "./session-envelope.js";

describe("resolveInboundSessionEnvelopeContext", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-session-envelope-");

  it("reads the previous timestamp from SQLite without a sessions.json file", async () => {
    const storePath = path.join(sessionDirs.make(), "sessions.json");
    const sessionKey = "agent:main:telegram:dm:1";
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath },
      { sessionId: "session-1", updatedAt: 42 },
    );

    expect(
      resolveInboundSessionEnvelopeContext({
        cfg: { session: { store: storePath } },
        agentId: "main",
        sessionKey,
      }),
    ).toMatchObject({ storePath, previousTimestamp: 42 });
  });

  it("prepares existing and absent timestamps without caller-thread SQL or formatter fallback", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = path.join(state.sessionsDir("main"), "sessions.json");
      const sessionKey = "agent:main:telegram:dm:prepared";
      await replaceSessionEntry(
        { agentId: "main", sessionKey, storePath },
        { sessionId: "prepared", updatedAt: 60_000 },
      );
      await closeOpenClawAgentDatabaseByPathAsync(
        resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
        "main",
      );
      const sql = observeHostDataSql();
      try {
        for (const [key, expected] of [
          [sessionKey, "[Telegram Alice +1m Thu 1970-01-01T00:02:00Z] hello"],
          ["agent:main:telegram:dm:absent", "[Telegram Alice Thu 1970-01-01T00:02:00Z] hello"],
        ] as const) {
          const format = await prepareChannelInboundEnvelopeBuilder({
            cfg: { agents: { defaults: { userTimezone: "UTC" } }, session: { store: storePath } },
            route: { agentId: "main", sessionKey: key },
          });
          expect(
            format({ channel: "Telegram", from: "Alice", body: "hello", timestamp: 120_000 }),
          ).toBe(expected);
        }
      } finally {
        sql.restore();
      }
      expect(sql.queries).toEqual([]);
    });
  });
});
