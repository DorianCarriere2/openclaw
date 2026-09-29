import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { VoiceCallCommandInputError } from "./command-service.js";
import type { VoiceCallRuntime } from "./runtime.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function resolveActiveVoiceCallToolScope(params: {
  action: unknown;
  binding: unknown;
  requestedCallId: unknown;
  runtime: VoiceCallRuntime;
  signal?: AbortSignal;
}): Promise<{ callId: string; execution: { runtime: VoiceCallRuntime } } | undefined> {
  if (!isRecord(params.binding)) {
    return undefined;
  }
  const binding = params.binding;
  const callId = normalizeOptionalString(binding.callId);
  if (binding.kind !== "active-call" || !callId) {
    return undefined;
  }
  if (params.action !== "send_dtmf" && params.action !== "end_call") {
    throw new VoiceCallCommandInputError("This realtime consult may only send_dtmf and end_call.");
  }
  const requestedCallId = normalizeOptionalString(params.requestedCallId);
  if (requestedCallId && requestedCallId !== callId) {
    throw new VoiceCallCommandInputError(`This realtime consult is bound to call ${callId}.`);
  }
  // Admit call control before awaiting lookup. The service owns accepted actions;
  // cancelling the consult must not interrupt their delivery or settlement.
  params.signal?.throwIfAborted();
  const activeCall = await params.runtime.manager.getCallForStream(callId);
  if (!activeCall || activeCall.callId !== callId) {
    throw new VoiceCallCommandInputError("The bound realtime call is no longer active.");
  }
  return { callId, execution: { runtime: params.runtime } };
}
