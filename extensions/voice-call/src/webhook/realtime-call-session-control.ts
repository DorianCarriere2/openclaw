import { randomUUID } from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  buildRealtimeVoiceSpeakExactMessage,
  calculateMulawRms,
  type RealtimeVoiceAudioSink,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceSessionHarness,
} from "openclaw/plugin-sdk/realtime-voice";
import { CallBriefSchema } from "../call-brief.js";
import { validateDtmfDigits } from "../dtmf.js";
import { DEFAULT_VOICEMAIL_HOLD_OPENING_MAX_MS } from "../errand-config.js";
import { createDtmfInterSequenceGapMulaw, createDtmfMulaw } from "../telephony-audio.js";
import type { CallRecord } from "../types.js";
import type { RealtimeAudioPacer } from "./realtime-audio-pacer.js";

export const OUTBOUND_GREETING_FALLBACK_MS = 3_000;
export const REALTIME_MEDIA_INACTIVITY_TIMEOUT_MS = 30_000;
export const REALTIME_DISCONNECT_HANGUP_GRACE_MS = 2_000;
const ASSISTANT_SPEECH_RMS_THRESHOLD = 0.035;

export type RealtimeCallControlResult = {
  success: boolean;
  error?: string;
  streamActive?: boolean;
};

export function speakOnRealtimeBridge(
  bridges: ReadonlyMap<string, Pick<RealtimeVoiceBridgeSession, "triggerGreeting">>,
  callId: string,
  instructions: string,
): RealtimeCallControlResult {
  const bridge = bridges.get(callId);
  if (!bridge) {
    return { success: false, error: "No active realtime bridge for call" };
  }
  try {
    bridge.triggerGreeting(instructions);
    return { success: true };
  } catch (error) {
    return { success: false, error: formatErrorMessage(error) };
  }
}

export function sendRealtimeDtmf(
  bindings: ReadonlyMap<string, { providerName: string; sendDtmf: (digits: string) => void }>,
  callId: string,
  digits: string,
): RealtimeCallControlResult {
  const binding = bindings.get(callId);
  if (!binding) {
    return { success: false, error: "No active realtime bridge for call", streamActive: false };
  }
  if (binding.providerName !== "twilio") {
    return {
      success: false,
      error: "No active Twilio realtime stream for call",
      streamActive: false,
    };
  }
  const validationError = validateDtmfDigits(digits);
  if (validationError) {
    return { success: false, error: validationError, streamActive: true };
  }
  try {
    binding.sendDtmf(digits);
    return { success: true, streamActive: true };
  } catch (error) {
    return { success: false, error: formatErrorMessage(error), streamActive: true };
  }
}

export function buildForcedConsultSpeechPrompt(result: string): string {
  return [
    "Internal OpenClaw consult result is ready.",
    "Do not call tools for this internal result.",
    "Speak the following answer to the caller now, briefly and naturally:",
    result,
  ].join("\n");
}

export function buildGreetingInstructions(
  baseInstructions: string | undefined,
  greeting: string | undefined,
): string | undefined {
  const trimmedGreeting = greeting?.trim();
  if (!trimmedGreeting) {
    return undefined;
  }
  const exactGreeting = [
    "For your first spoken reply, the first words must be the exact Answer below, verbatim and in its original language, with nothing before or after it.",
    "Then stop and listen.",
    buildRealtimeVoiceSpeakExactMessage({ text: trimmedGreeting, surfaceLabel: "the callee" }),
  ].join("\n");
  return baseInstructions ? `${baseInstructions}\n\n${exactGreeting}` : exactGreeting;
}

export function createOutboundGreetingController(params: {
  enabled: boolean;
  instructions?: string;
  fallbackMs?: number;
  holdOpeningMaxMs?: number;
  call?: Pick<CallRecord, "direction" | "metadata">;
  acknowledge?: (instructions: string) => void;
}) {
  const waitForAnsweringMachine =
    params.call?.direction === "outbound" &&
    params.call.metadata?.voicemailManagedByHost &&
    params.call.metadata?.mode !== "notify"
      ? () => params.call?.metadata?.answeredBy
      : undefined;
  let speechMs = 0;
  let silenceMs = 0;
  let acknowledged = false;
  let claimed = !params.enabled;
  let closed = false;
  let waitingForAmd = Boolean(waitForAnsweringMachine);
  let machineDetected = false;
  let readySession: RealtimeVoiceBridgeSession | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const triggerOpening = () => {
    if (!closed && readySession && params.instructions && claim()) {
      readySession.triggerGreeting(params.instructions);
    }
  };
  const isBlocked = (): boolean => {
    const answeredBy = waitForAnsweringMachine?.();
    if (
      typeof answeredBy === "string" &&
      (answeredBy.startsWith("machine_") || answeredBy === "fax")
    ) {
      machineDetected = true;
      clearTimer();
    }
    if (machineDetected) {
      return true;
    }
    if (waitingForAmd && (answeredBy === "human" || answeredBy === "unknown")) {
      waitingForAmd = false;
      clearTimer();
      triggerOpening();
    }
    return waitingForAmd;
  };
  const claim = (): boolean => {
    if (closed || isBlocked() || claimed) {
      return false;
    }
    claimed = true;
    clearTimer();
    return true;
  };
  return {
    claim,
    isBlocked,
    noteInputAudio(audio: Buffer) {
      if (closed || !readySession || !isBlocked() || machineDetected || acknowledged) return;
      if (calculateMulawRms(audio) >= ASSISTANT_SPEECH_RMS_THRESHOLD) {
        speechMs += audio.length / 8;
        silenceMs = 0;
      } else {
        silenceMs += audio.length / 8;
        if (silenceMs >= 240) speechMs = 0;
      }
      if (speechMs <= 3_000) return;
      acknowledged = true;
      const brief = CallBriefSchema.safeParse(params.call?.metadata?.brief);
      const language = brief.success ? brief.data.language : undefined;
      params.acknowledge?.(
        [
          `Say only a short acknowledgement${language ? ` in ${JSON.stringify(language)}` : ""}, then stop and wait. Do not call tools.`,
          /^(es(?:[-_]|$)|spanish|español)/i.test(language ?? "")
            ? "Sí, un momento"
            : "Yes, one moment.",
        ].join("\n"),
      );
    },
    close() {
      closed = true;
      clearTimer();
    },
    onReady(session: RealtimeVoiceBridgeSession) {
      readySession = session;
      if (closed || machineDetected) {
        return;
      }
      if (isBlocked()) {
        if (!timer && !machineDetected) {
          timer = setTimeout(() => {
            if (isBlocked() && !machineDetected && !closed) {
              waitingForAmd = false;
              triggerOpening();
            }
          }, params.holdOpeningMaxMs ?? DEFAULT_VOICEMAIL_HOLD_OPENING_MAX_MS);
          timer.unref?.();
        }
        return;
      }
      if (!params.enabled || !params.instructions || claimed) {
        return;
      }
      clearTimer();
      timer = setTimeout(() => {
        if (claim()) {
          session.triggerGreeting(params.instructions);
        }
      }, params.fallbackMs ?? OUTBOUND_GREETING_FALLBACK_MS);
      timer.unref?.();
    },
  };
}

export function createRealtimeCallActivityController(params: {
  idleHangupMs?: number;
  mediaInactivityMs?: number;
  mediaGraceMs?: number;
  /** While true (for example an answering-machine hold), speech idle is not timed. */
  isPaused?: () => boolean;
  onIdle: () => void;
  onMediaWarning: () => void;
  onMediaTimeout: () => void;
}) {
  let closed = false;
  let started = false;
  let consultsInFlight = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let mediaTimer: ReturnType<typeof setTimeout> | undefined;
  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };
  const clearMedia = () => {
    if (mediaTimer) {
      clearTimeout(mediaTimer);
      mediaTimer = undefined;
    }
  };
  const resetIdle = () => {
    clearIdle();
    if (
      closed ||
      !started ||
      !params.idleHangupMs ||
      consultsInFlight > 0 ||
      params.isPaused?.() === true
    ) {
      return;
    }
    idleTimer = setTimeout(params.onIdle, params.idleHangupMs);
    idleTimer.unref?.();
  };
  return {
    beginConsult(this: void) {
      consultsInFlight += 1;
      clearIdle();
    },
    close() {
      closed = true;
      clearIdle();
      clearMedia();
    },
    endConsult(this: void) {
      consultsInFlight = Math.max(0, consultsInFlight - 1);
      if (consultsInFlight === 0) {
        resetIdle();
      }
    },
    noteMedia(this: void) {
      if (closed) {
        return;
      }
      clearMedia();
      mediaTimer = setTimeout(() => {
        params.onMediaWarning();
        mediaTimer = setTimeout(
          params.onMediaTimeout,
          params.mediaGraceMs ?? REALTIME_DISCONNECT_HANGUP_GRACE_MS,
        );
        mediaTimer.unref?.();
      }, params.mediaInactivityMs ?? REALTIME_MEDIA_INACTIVITY_TIMEOUT_MS);
      mediaTimer.unref?.();
    },
    noteSpeech: resetIdle,
    start() {
      started = true;
      resetIdle();
    },
  };
}

export function createRealtimeDtmfController(params: {
  audioPacer: Pick<RealtimeAudioPacer, "sendAudio" | "sendMark">;
  pendingMarkAcks: Map<string, () => void>;
  interruptModelOutput: () => void;
}) {
  let active = false;
  let generation = 0;
  const release = (expectedGeneration: number) => {
    if (generation !== expectedGeneration) {
      return;
    }
    active = false;
  };
  return {
    close() {
      active = false;
    },
    isActive: () => active,
    send(this: void, digits: string) {
      const audio = createDtmfMulaw(digits);
      if (audio.length === 0) {
        throw new Error("DTMF sequence produced no audio");
      }
      generation += 1;
      const currentGeneration = generation;
      if (!active) {
        active = true;
        try {
          params.interruptModelOutput();
        } catch (error) {
          active = false;
          throw error;
        }
      } else {
        params.audioPacer.sendAudio(createDtmfInterSequenceGapMulaw());
      }
      active = true;
      params.audioPacer.sendAudio(audio);
      const markName = `openclaw-dtmf-${randomUUID()}`;
      params.pendingMarkAcks.set(markName, () => release(currentGeneration));
      params.audioPacer.sendMark(markName);
    },
  };
}

export function createRealtimeCallAudioController(params: {
  audioPacer: RealtimeAudioPacer;
  callId: string;
  harness: RealtimeVoiceSessionHarness;
  isDtmfActive: () => boolean;
  isOpen: () => boolean;
  isBlocked?: () => boolean;
  onAudibleOutput?: () => void;
  pendingMarkAcks: Map<string, () => void>;
  providerCallId: string;
}) {
  const cancelOutputAudioForBargeIn = (
    source: "local" | "provider",
    interruptProvider?: (audioPlaybackActive: boolean) => void,
    clearedAudioBytes = 0,
  ): void => {
    const outputAudioActive = params.harness.talk.outputAudioActive;
    const pendingTelephonyAudio = params.audioPacer.hasPendingAudio();
    if (
      source === "provider" &&
      !outputAudioActive &&
      !pendingTelephonyAudio &&
      clearedAudioBytes === 0
    ) {
      return;
    }
    const interruptedTurnId = params.harness.talk.activeTurnId;
    if (outputAudioActive || pendingTelephonyAudio) {
      interruptProvider?.(true);
    }
    const shouldClearTelephony = source === "local" || pendingTelephonyAudio;
    const clearedBytes =
      clearedAudioBytes + (shouldClearTelephony ? params.audioPacer.clearAudio() : 0);
    console.log(
      `[voice-call] realtime outbound audio cleared by ${source} barge-in callId=${params.callId} providerCallId=${params.providerCallId} queuedBytes=${clearedBytes}`,
    );
    if (!outputAudioActive || !interruptedTurnId) {
      return;
    }
    const reason = `${source}-barge-in`;
    params.harness.finishOutputAudio(reason);
    params.harness.talk.cancelTurn({
      turnId: interruptedTurnId,
      payload: { callId: params.callId, providerCallId: params.providerCallId, reason },
    });
  };
  const audioSink: RealtimeVoiceAudioSink = {
    isOpen: params.isOpen,
    sendAudio: (muLaw, metadata) => {
      if (params.isDtmfActive() || params.isBlocked?.()) {
        return;
      }
      // Silent model frames do not count as the assistant speaking.
      if (muLaw.length > 0 && calculateMulawRms(muLaw) >= ASSISTANT_SPEECH_RMS_THRESHOLD) {
        params.onAudibleOutput?.();
      }
      params.harness.recordOutputAudio(muLaw);
      params.audioPacer.sendAudio(muLaw, metadata);
    },
    getPlaybackState: () => params.audioPacer.getPlaybackState(),
    clearAudio: (reason) => {
      params.harness.flushOutput(() => {
        if (params.isDtmfActive()) {
          params.harness.finishOutputAudio(reason ?? "clear");
          return;
        }
        const clearedBytes = params.audioPacer.clearAudio();
        if (reason === "barge-in") {
          cancelOutputAudioForBargeIn("provider", undefined, clearedBytes);
          return;
        }
        console.log(
          `[voice-call] realtime outbound audio clear requested callId=${params.callId} providerCallId=${params.providerCallId} queuedBytes=${clearedBytes}`,
        );
        params.harness.finishOutputAudio(reason ?? "clear");
      });
    },
    sendMark: (markName, acknowledge) => {
      params.audioPacer.sendMark(markName);
      if (markName && acknowledge) {
        params.pendingMarkAcks.set(markName, acknowledge);
      }
    },
  };
  return { audioSink, cancelOutputAudioForBargeIn };
}
