import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import type { SqliteWorkerAdmissionRequest } from "../../infra/sqlite-worker-operation-admission.js";
import type {
  IncognitoSessionAuthority,
  IncognitoSessionFacts,
  IncognitoSessionOperations,
} from "./session-incognito-contract.js";
import type { IncognitoEntryCreationOperations } from "./session-incognito-entry-creation-contract.js";
import type { IncognitoEntryPatchOperations } from "./session-incognito-entry-patch-contract.js";

export type IncognitoEntryOperations = IncognitoEntryCreationOperations &
  IncognitoEntryPatchOperations;

/** Entry receipts publish the paired kernel's acknowledged result without replay. */
export function incognitoEntryPublication<Key extends keyof IncognitoEntryOperations>(
  type: Key,
  authorizePrepared?: () => void,
) {
  return {
    factsKey: "entry" as const,
    authorize(_stage: "transaction" | "commit", facts: unknown) {
      if (isRecord(facts) && facts.guarded === true) {
        authorizePrepared?.();
      }
    },
    decodeReceipt(receipt: unknown): IncognitoSessionOperations[Key]["output"] {
      if (!isRecord(receipt) || !Array.isArray(receipt.facts) || !isRecord(receipt.value)) {
        throw new SqliteWorkerError(
          `Incognito ${type} omitted its committed receipt`,
          "outcome-unknown",
        );
      }
      // SAFETY: The paired kernel sends this command's result; facts must match its exact grant.
      return receipt as IncognitoSessionOperations[Key]["output"];
    },
  };
}

export function authorizeSessionFacts(
  authority: IncognitoSessionAuthority,
  stage: "transaction" | "commit",
  facts: IncognitoSessionFacts,
) {
  const authorization: unknown = authority.authorize?.(stage, structuredClone(facts));
  if (isPromiseLike(authorization)) {
    void Promise.resolve(authorization).catch(() => undefined);
    throw new Error("Incognito session grants must remain synchronous");
  }
}

/** A patch checks cancellation before its predicate, then guards the validated row before writing. */
export function isIncognitoEntryValidationGrant(
  type: string,
  phase: "prepare" | "transaction" | "commit",
  request: SqliteWorkerAdmissionRequest,
  previousGuarded: unknown,
): boolean {
  return (
    type === "session.entry.patch.commit" &&
    phase === "transaction" &&
    request.stage === "transaction" &&
    previousGuarded === false &&
    isRecord(request.facts) &&
    isRecord(request.facts.entry) &&
    request.facts.entry.guarded === true
  );
}
