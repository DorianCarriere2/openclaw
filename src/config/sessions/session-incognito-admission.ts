import { isDeepStrictEqual } from "node:util";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import type { SqliteWorkerAdmissionFactory } from "../../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerStore } from "../../infra/sqlite-worker-store.js";
import type { AgentDatabaseIncognitoOperations } from "../../state/openclaw-agent-execution-contract.js";
import type {
  IncognitoSessionAuthority,
  IncognitoSessionFacts,
  IncognitoSessionOperations,
} from "./session-incognito-contract.js";
import type { PendingInputHistoryGrant } from "./session-pending-input-history.types.js";

export function readIncognitoGrantFacts(
  received: unknown,
  identity: IncognitoSessionFacts["identity"],
): IncognitoSessionFacts[] {
  if (
    !Array.isArray(received) ||
    received.some(
      (facts: unknown) =>
        !isRecord(facts) ||
        !isDeepStrictEqual(facts.identity, identity) ||
        typeof facts.sessionKey !== "string" ||
        !Number.isSafeInteger(facts.revision),
    )
  ) {
    throw new Error("Incognito session grant differs from its captured target");
  }
  // SAFETY: The paired kernel supplies these actor-bound publication facts.
  return received as IncognitoSessionFacts[];
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

type Scope = Pick<SqliteWorkerStore<AgentDatabaseIncognitoOperations>, "execute">;

export type IncognitoSessionRunner = <T>(
  authority: IncognitoSessionAuthority,
  operation: (scope: Scope) => Promise<T>,
  signal?: AbortSignal,
  admission?: SqliteWorkerAdmissionFactory,
  cleanup?: boolean,
) => Promise<T>;

export function incognitoPendingHistoryPublication(
  captured: IncognitoSessionOperations["session.pendingInputs.interruptHistory"]["input"],
  admitCustody: (stage: "transaction" | "commit", facts: PendingInputHistoryGrant) => void,
) {
  const ids = new Set(captured.ids);
  return {
    authorize(stage: "transaction" | "commit", facts: unknown) {
      if (
        !isRecord(facts) ||
        facts.kind !== "pending-input-history-custody" ||
        !Array.isArray(facts.candidates) ||
        facts.candidates.some(
          (row: unknown) =>
            !isRecord(row) ||
            typeof row.input_id !== "string" ||
            !ids.has(row.input_id) ||
            row.session_key !== captured.sessionKey ||
            row.session_id !== captured.sessionId,
        )
      ) {
        throw new Error("Incognito pending input history omitted its custody facts");
      }
      // SAFETY: The paired bounded kernel owns this validated custody envelope.
      admitCustody(stage, facts as PendingInputHistoryGrant);
    },
    decodeReceipt(receipt: unknown) {
      if (
        !isRecord(receipt) ||
        !Array.isArray(receipt.facts) ||
        !isRecord(receipt.value) ||
        receipt.value.kind !== "pending-input-history-interrupted" ||
        !Array.isArray(receipt.value.ids) ||
        receipt.value.ids.some((id: unknown) => typeof id !== "string" || !ids.has(id))
      ) {
        throw new SqliteWorkerError(
          "Incognito pending input history omitted its committed receipt",
          "outcome-unknown",
        );
      }
      // SAFETY: Session facts are compared with the exact commit grant before publication.
      return receipt as IncognitoSessionOperations["session.pendingInputs.interruptHistory"]["output"];
    },
  };
}
