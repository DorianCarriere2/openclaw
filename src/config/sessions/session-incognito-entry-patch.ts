import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import type { SqliteLifecycleTargetSnapshot } from "./session-accessor.sqlite-entry-equality.js";
import type {
  SessionEntryPatchCommit,
  SessionEntryPatchSelection,
} from "./session-entry-patch.types.js";
import type { IncognitoSessionActor } from "./session-incognito-actor.js";
import { publishIncognitoSessionEntry } from "./session-incognito-binding.js";
import type { IncognitoEntryPatchResult } from "./session-incognito-entry-patch-contract.js";
import type { InternalSessionEntry } from "./types.js";

/** Preparation retains its original actor; the worker rereads the exact rows at commit. */
export function patchIncognitoSessionEntry(params: {
  actor: IncognitoSessionActor;
  admissionSignal?: AbortSignal;
  sessionKey: string;
  selection: SessionEntryPatchSelection;
  assertCurrent(): void;
  assertCommitAllowed?: () => void;
  shouldCommit?: () => boolean;
  prepare(snapshot: SqliteLifecycleTargetSnapshot): Promise<SessionEntryPatchCommit | undefined>;
  onCommitted?: (entry: InternalSessionEntry) => void;
}): Promise<IncognitoEntryPatchResult> {
  const { actor, sessionKey } = params;
  const selection = structuredClone(params.selection);
  const assertCurrent = () => {
    actor.assertCurrent();
    params.assertCurrent();
  };
  assertCurrent();
  params.admissionSignal?.throwIfAborted();
  return actor.sessions.withSharedState(async () => {
    let snapshot: ReturnType<typeof actor.sessions.captureSnapshot> | undefined;
    const prepared = await actor.sessions.entry(
      { assertCurrent },
      { type: "session.entry.patch.prepare", input: { sessionKey, selection } },
      params.admissionSignal,
      undefined,
      () => {
        snapshot = actor.sessions.captureSnapshot(sessionKey);
      },
    );
    assertCurrent();
    snapshot?.assertCurrent();
    const input = await params.prepare(prepared);
    assertCurrent();
    if (!input) {
      return { entry: null, wrote: false };
    }
    let refused = false;
    try {
      return await actor.sessions.entry(
        {
          assertCurrent,
          authorize() {
            if (params.shouldCommit?.() === false) {
              refused = true;
              throw new Error("Incognito entry patch was cancelled before commit");
            }
          },
        },
        { type: "session.entry.patch.commit", input },
        undefined,
        (result) => {
          if (result.wrote && result.entry) {
            try {
              params.onCommitted?.(structuredClone(result.entry));
            } finally {
              publishIncognitoSessionEntry(actor, sessionKey, prepared[0]?.entry, result.entry);
            }
          }
        },
        undefined,
        params.assertCommitAllowed,
      );
    } catch (error) {
      if (refused && !hasSqliteWorkerOutcomeUnknown(error)) {
        assertCurrent();
        return { entry: null, wrote: false };
      }
      throw error;
    }
  });
}
