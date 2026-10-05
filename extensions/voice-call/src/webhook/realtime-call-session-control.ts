import { randomUUID } from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  buildRealtimeVoiceSpeakExactMessage,
  type RealtimeVoiceAudioSink,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceSessionHarness,
} from "openclaw/plugin-sdk/realtime-voice";
import { createDtmfInterSequenceGapMulaw, createDtmfMulaw, validateDtmfDigits } from "../dtmf.js";
import type { RealtimeAudioPacer } from "./realtime-audio-pacer.js";

export const OUTBOUND_GREETING_FALLBACK_MS = 3_000;

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
}) {
  let claimed = !params.enabled;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const claim = () => {
    if (claimed) {
      return false;
    }
    claimed = true;
    clearTimer();
    return true;
  };
  return {
    claim,
    close: clearTimer,
    onReady(session: RealtimeVoiceBridgeSession) {
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
  mediaInactivityMs: number;
  mediaGraceMs: number;
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
    if (closed || !started || !params.idleHangupMs || consultsInFlight > 0) {
      return;
    }
    idleTimer = setTimeout(params.onIdle, params.idleHangupMs);
    idleTimer.unref?.();
  };
  return {
    beginConsult() {
      consultsInFlight += 1;
      clearIdle();
    },
    close() {
      closed = true;
      clearIdle();
      clearMedia();
    },
    endConsult() {
      consultsInFlight = Math.max(0, consultsInFlight - 1);
      if (consultsInFlight === 0) {
        resetIdle();
      }
    },
    isPaused: () => consultsInFlight > 0,
    noteMedia() {
      if (closed) {
        return;
      }
      clearMedia();
      mediaTimer = setTimeout(() => {
        params.onMediaWarning();
        mediaTimer = setTimeout(params.onMediaTimeout, params.mediaGraceMs);
        mediaTimer.unref?.();
      }, params.mediaInactivityMs);
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
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  const clearReleaseTimer = () => {
    if (releaseTimer) {
      clearTimeout(releaseTimer);
      releaseTimer = undefined;
    }
  };
  const release = (expectedGeneration: number) => {
    if (generation !== expectedGeneration) {
      return;
    }
    active = false;
    clearReleaseTimer();
  };
  return {
    close() {
      active = false;
      clearReleaseTimer();
    },
    isActive: () => active,
    send(digits: string) {
      const audio = createDtmfMulaw(digits);
      if (audio.length === 0) {
        throw new Error("DTMF sequence produced no audio");
      }
      generation += 1;
      const currentGeneration = generation;
      if (!active) {
        params.interruptModelOutput();
      } else {
        params.audioPacer.sendAudio(createDtmfInterSequenceGapMulaw());
      }
      active = true;
      clearReleaseTimer();
      params.audioPacer.sendAudio(audio);
      const markName = `openclaw-dtmf-${randomUUID()}`;
      params.pendingMarkAcks.set(markName, () => release(currentGeneration));
      params.audioPacer.sendMark(markName);
      releaseTimer = setTimeout(() => release(currentGeneration), audio.length / 8 + 1_000);
      releaseTimer.unref?.();
    },
  };
}

export function createRealtimeCallAudioController(params: {
  audioPacer: RealtimeAudioPacer;
  callId: string;
  harness: RealtimeVoiceSessionHarness;
  isDtmfActive: () => boolean;
  isOpen: () => boolean;
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
      if (params.isDtmfActive()) {
        return;
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
