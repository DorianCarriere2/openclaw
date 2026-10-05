import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ToolCard } from "../../lib/chat/chat-types.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";

/** The session's direct children as the pane holds them. */
export type SubagentRoster = {
  subagentSessions?: readonly GatewaySessionRow[];
  /** True once the pane's own child query answered; seeded rows can be partial. */
  subagentSessionsHydrated?: boolean;
};

/** What a launch row needs to show its subagent's session and open it. */
export type SubagentRowContext = Pick<SubagentRoster, "subagentSessions"> & {
  onOpenSession?: (sessionKey: string) => void;
};

export type SpawnedSubagent = {
  /** The short name the launch call gave the subagent. */
  label: string;
  /** Its session, when the roster holds it; `runtimeMs` only once it finished. */
  session?: { key: string; running: boolean; runtimeMs: number | null };
};

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** The name a `sessions_spawn` call gave its subagent, shown instead of its assignment. */
export function spawnedSubagentLabel(card: Pick<ToolCard, "name" | "args">): string | undefined {
  return card.name.trim().toLowerCase() === "sessions_spawn"
    ? text(asRecord(card.args)?.label)
    : undefined;
}

/** A subagent that handed off to its own subagents is still at work. */
export function isUnfinishedSubagent(row: GatewaySessionRow): boolean {
  return isSessionRunActive(row) || row.hasActiveSubagentRun === true;
}

function finishedRuntimeMs(row: GatewaySessionRow): number | null {
  const { runtimeMs, startedAt, endedAt } = row;
  if (typeof runtimeMs === "number" && Number.isFinite(runtimeMs) && runtimeMs >= 0) {
    return runtimeMs;
  }
  return typeof startedAt === "number" && typeof endedAt === "number" && endedAt >= startedAt
    ? endedAt - startedAt
    : null;
}

/**
 * Only the session its own result names is this launch's subagent. A launch
 * still in flight, or one that was refused, has none: its label alone can
 * belong to an earlier subagent or to a retry.
 */
export function resolveSpawnedSubagent(
  card: Pick<ToolCard, "name" | "args" | "details" | "outputText">,
  rows: readonly GatewaySessionRow[] | undefined,
): SpawnedSubagent | null {
  const label = spawnedSubagentLabel(card);
  if (!label) {
    return null;
  }
  // History keeps the result as text; only a live result still carries its details.
  const childKey =
    text(asRecord(card.details)?.childSessionKey) ??
    text(safeParseJsonRecord(card.outputText ?? "")?.childSessionKey);
  const row = childKey
    ? rows?.find((candidate) => areUiSessionKeysEquivalent(candidate.key, childKey))
    : undefined;
  if (!row) {
    return { label };
  }
  const running = isUnfinishedSubagent(row);
  return {
    label,
    session: { key: row.key, running, runtimeMs: running ? null : finishedRuntimeMs(row) },
  };
}

const rosterKeys = new WeakMap<readonly GatewaySessionRow[], string>();

/**
 * Everything launch rows draw from the roster. Settled rows repaint when a
 * subagent starts or finishes, not when its activity patches or the roster's
 * order change.
 */
export function spawnedSubagentsRenderKey(rows: readonly GatewaySessionRow[] | undefined): string {
  if (!rows || rows.length === 0) {
    return "";
  }
  let key = rosterKeys.get(rows);
  if (key === undefined) {
    key = rows
      .map((row) => {
        const running = isUnfinishedSubagent(row);
        return JSON.stringify([row.key, running, running ? null : finishedRuntimeMs(row)]);
      })
      .toSorted()
      .join("\n");
    rosterKeys.set(rows, key);
  }
  return key;
}
