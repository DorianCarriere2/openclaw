import path from "node:path";
import type { BoundAgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { withOpenClawAgentDatabaseRuntime } from "../../state/openclaw-agent-db.js";
import type { PlacementTurnClaimAuthority } from "./placement-turn-authority.js";

type WorkerTranscriptTurn = Pick<
  SessionPlacementTurnParams,
  "agentId" | "sessionId" | "sessionKey" | "sessionTarget"
>;

function captureWorkerTurnTranscriptTarget(turn: WorkerTranscriptTurn): BoundAgentRunSessionTarget {
  if (
    !turn.sessionTarget?.agentId ||
    !turn.sessionTarget.sessionId ||
    !turn.sessionTarget.sessionKey ||
    !turn.sessionTarget.storePath
  ) {
    throw new Error("Cloud worker turn is missing its transcript identity");
  }
  if (turn.sessionTarget.sessionId !== turn.sessionId) {
    throw new Error("Cloud worker transcript identity does not match the active turn");
  }
  const targetKeyAgentId = parseAgentSessionKey(turn.sessionTarget.sessionKey)?.agentId;
  if (
    (turn.agentId && turn.sessionTarget.agentId !== turn.agentId) ||
    (turn.sessionKey && turn.sessionTarget.sessionKey !== turn.sessionKey) ||
    (targetKeyAgentId && targetKeyAgentId !== turn.sessionTarget.agentId)
  ) {
    throw new Error("Cloud worker transcript identity does not match the active turn");
  }
  return {
    agentId: turn.sessionTarget.agentId,
    sessionId: turn.sessionId,
    sessionKey: turn.sessionTarget.sessionKey,
    storePath: turn.sessionTarget.storePath,
    expectedLifecycleRevision: turn.sessionTarget.expectedLifecycleRevision,
    expectedWriterRunId: turn.sessionTarget.expectedWriterRunId,
  };
}

export function resolveWorkerTurnTranscriptTarget(
  turn: WorkerTranscriptTurn,
): BoundAgentRunSessionTarget {
  const target = captureWorkerTurnTranscriptTarget(turn);
  const currentEntry = loadSessionEntry(target);
  if (
    currentEntry?.sessionId !== target.sessionId ||
    (target.expectedLifecycleRevision !== undefined &&
      currentEntry.lifecycleRevision !== target.expectedLifecycleRevision) ||
    (target.expectedWriterRunId !== undefined &&
      currentEntry.activeWriterRunId !== target.expectedWriterRunId)
  ) {
    throw new Error("Cloud worker transcript identity is no longer current");
  }
  return target;
}

/** Keep native compatibility guards on the worker-admitted handle through turn settlement. */
export async function withWorkerTurnTranscriptDatabase<T>(
  turn: WorkerTranscriptTurn,
  controls: {
    assertCurrent(): void;
    prepareAuthority(): Promise<Pick<PlacementTurnClaimAuthority, "isCurrent" | "release">>;
    signal?: AbortSignal;
  },
  run: (target: BoundAgentRunSessionTarget) => Promise<T>,
): Promise<T> {
  const captured = captureWorkerTurnTranscriptTarget(turn);
  const target = { ...captured, storePath: path.resolve(captured.storePath) };
  let executing = false;
  let authority: Awaited<ReturnType<typeof controls.prepareAuthority>> | undefined;
  const assertPreparing = () => {
    // Execution owns subsequent liveness and can settle after releasing its placement claim.
    if (executing) {
      return;
    }
    controls.signal?.throwIfAborted();
    if (authority && !authority.isCurrent()) {
      throw new Error("Cloud worker placement authority changed during preparation");
    }
    const current = captureWorkerTurnTranscriptTarget(turn);
    if (
      current.agentId !== target.agentId ||
      current.sessionId !== target.sessionId ||
      current.sessionKey !== target.sessionKey ||
      path.resolve(current.storePath) !== target.storePath ||
      current.expectedLifecycleRevision !== target.expectedLifecycleRevision ||
      current.expectedWriterRunId !== target.expectedWriterRunId
    ) {
      throw new Error("Cloud worker transcript target changed during preparation");
    }
  };
  const runAdmitted = (pinned: BoundAgentRunSessionTarget) => {
    controls.assertCurrent();
    const current = resolveWorkerTurnTranscriptTarget({ ...pinned, sessionTarget: pinned });
    executing = true;
    return run(current);
  };
  controls.assertCurrent();
  return withSessionEntryReadOnlyInWorker(target, assertPreparing, async (read, owner) => {
    controls.assertCurrent();
    if (!read.ok) {
      throw read.error;
    }
    if (!read.value || read.value.sessionId !== target.sessionId) {
      throw new Error("Cloud worker transcript identity is no longer current");
    }
    authority = await controls.prepareAuthority();
    try {
      controls.assertCurrent();
      const scope = owner.scope;
      if (!scope) {
        assertPreparing();
        return await runAdmitted(target);
      }
      const pinned = { ...target, storePath: scope.storePath };
      const assertAdmission = () => {
        owner.assertCurrent();
        assertPreparing();
      };
      return await withOpenClawAgentDatabaseRuntime(
        { agentId: scope.databaseAgentId, path: scope.storePath, env: scope.env },
        () => {
          assertAdmission();
          return runAdmitted(pinned);
        },
        assertAdmission,
        controls.signal,
      );
    } finally {
      authority.release();
      authority = undefined;
    }
  });
}
