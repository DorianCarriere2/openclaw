import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import {
  replaceSessionEntry,
  replaceTranscriptEvents,
  waitForSessionTranscriptProjection,
} from "../../config/sessions/session-accessor.js";
import { historyLane } from "../../config/sessions/session-transcript-worker-resources.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { artifactsHandlers } from "./artifacts.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import type { RespondFn } from "./types.js";

it.each(["default", "custom"] as const)(
  "retains the artifact history reader across authorized lists with a %s store",
  async (store) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath =
        store === "custom" ? state.statePath("custom", "sessions.sqlite") : undefined;
      const config = {
        agents: { entries: { main: {} } },
        ...(storePath ? { session: { store: storePath } } : {}),
      };
      await state.writeConfig(config);
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:artifact-reader-lifetime",
        sessionId: "artifact-reader-lifetime",
        ...(storePath ? { storePath } : {}),
      };
      await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      await replaceTranscriptEvents(scope, [
        { type: "session", version: 3, id: scope.sessionId },
        {
          type: "message",
          id: "artifact",
          parentId: null,
          message: {
            role: "assistant",
            content: [{ type: "file", title: "result.txt", data: "aGVsbG8=" }],
          },
        },
      ]);
      await waitForSessionTranscriptProjection(scope);
      const context = await createHistoryReadContext({ getRuntimeConfig: () => config });
      const read = async () => {
        const respond = vi.fn<RespondFn>();
        await artifactsHandlers["artifacts.list"]!({
          params: { sessionKey: scope.sessionKey },
          context,
          client: null,
          req: { type: "req", id: "artifact-lifetime", method: "artifacts.list" },
          isWebchatConnect: () => false,
          respond,
        });
        expect(respond.mock.calls[0]?.[0]).toBe(true);
        return respond.mock.calls[0]?.[1];
      };
      const first = await read();
      expect(first).toMatchObject({
        artifacts: [{ title: "result.txt", sizeBytes: 5, sessionKey: scope.sessionKey }],
      });
      const close = vi.spyOn(historyLane.pool, "closeResources");
      try {
        expect(await read()).toEqual(first);
        expect(close).not.toHaveBeenCalled();
      } finally {
        close.mockRestore();
      }
    });
  },
);

it.runIf(process.env.OPENCLAW_DB_WORKER_BENCH === "1")(
  "measures artifacts.list over 500 files and persisted transcript metadata",
  async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:artifact-bench",
        sessionId: "artifact-bench",
      };
      await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const files = Array.from({ length: 500 }, (_, index) => ({
        type: "file",
        title: `result-${index}.txt`,
        url: state.statePath(`result-${index}.txt`),
        mimeType: "text/plain",
        sizeBytes: 4096,
      }));
      for (const file of files) {
        await fs.writeFile(file.url, "x".repeat(file.sizeBytes));
      }
      await replaceTranscriptEvents(scope, [
        { type: "session", version: 3, id: scope.sessionId },
        ...files.map((file, index) => ({
          type: "message",
          id: `message-${index}`,
          parentId: index === 0 ? null : `message-${index - 1}`,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "context ".repeat(2048) }, file],
          },
        })),
      ]);
      await waitForSessionTranscriptProjection(scope);
      const context = await createHistoryReadContext();
      const request = async () => {
        let response: Parameters<RespondFn> | undefined;
        await artifactsHandlers["artifacts.list"]!({
          params: { sessionKey: scope.sessionKey },
          context,
          client: null,
          req: { type: "req", id: "artifact-bench", method: "artifacts.list" },
          isWebchatConnect: () => false,
          respond: (...args) => {
            response = args;
          },
        });
        expect(response?.[0]).toBe(true);
        expect(response?.[1]).toMatchObject({ artifacts: expect.any(Array) });
        return JSON.stringify(response?.[1]);
      };
      const coldStart = performance.now();
      const golden = await request();
      const coldMs = performance.now() - coldStart;
      expect(JSON.parse(golden).artifacts).toHaveLength(500);
      const samples = [];
      for (let round = 0; round < 9; round++) {
        const start = performance.now();
        const cpu = process.threadCpuUsage();
        const response = await request();
        const elapsed = process.threadCpuUsage(cpu);
        const wallMs = performance.now() - start;
        expect(response).toBe(golden);
        if (round >= 2) {
          samples.push({ wallMs, mainThreadCpuMs: (elapsed.user + elapsed.system) / 1000 });
        }
      }
      console.log(
        JSON.stringify({
          method: "artifacts.list",
          files: files.length,
          coldMs,
          samples,
          medianWallMs: samples.map((s) => s.wallMs).toSorted((a, b) => a - b)[3],
          medianMainThreadCpuMs: samples.map((s) => s.mainThreadCpuMs).toSorted((a, b) => a - b)[3],
        }),
      );
    });
  },
);
