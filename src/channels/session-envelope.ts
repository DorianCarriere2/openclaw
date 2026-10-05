// Session-envelope context resolver for inbound channel turns.
import { resolveEnvelopeFormatOptions } from "../auto-reply/envelope.js";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import { readSessionUpdatedAtCore } from "../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Resolves envelope options and previous timestamp for one inbound channel session. */
export function resolveInboundSessionEnvelopeContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}) {
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  return {
    storePath,
    envelopeOptions: resolveEnvelopeFormatOptions(params.cfg),
    previousTimestamp: readSessionUpdatedAtCore({
      storePath,
      sessionKey: params.sessionKey,
    }),
  };
}

/** Prepare the stored timestamp before formatting an inbound message. */
export async function prepareInboundSessionEnvelopeContext(
  params: Parameters<typeof resolveInboundSessionEnvelopeContext>[0],
) {
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const envelopeOptions = resolveEnvelopeFormatOptions(params.cfg);
  const entry = await readSessionEntryReadOnlyInWorker({
    agentId: params.agentId,
    storePath,
    sessionKey: params.sessionKey,
    snapshotFields: [],
  });
  return { storePath, envelopeOptions, previousTimestamp: entry?.updatedAt };
}
