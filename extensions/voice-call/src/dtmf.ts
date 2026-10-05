import { convertPcmToMulaw8k } from "openclaw/plugin-sdk/realtime-voice";

const DTMF_SAMPLE_RATE = 8_000;
const DTMF_TONE_MS = 120;
const DTMF_GAP_MS = 100;
const DTMF_FREQUENCIES: Readonly<Record<string, readonly [number, number]>> = {
  "1": [697, 1209],
  "2": [697, 1336],
  "3": [697, 1477],
  "4": [770, 1209],
  "5": [770, 1336],
  "6": [770, 1477],
  "7": [852, 1209],
  "8": [852, 1336],
  "9": [852, 1477],
  "*": [941, 1209],
  "0": [941, 1336],
  "#": [941, 1477],
};
const DTMF_PAUSE_MS: Readonly<Record<string, number>> = {
  w: 500,
  W: 1_000,
  p: 500,
  P: 1_000,
  ",": 2_000,
};

function mulawSilence(durationMs: number): Buffer {
  return Buffer.alloc(Math.round((DTMF_SAMPLE_RATE * durationMs) / 1_000), 0xff);
}

export function createDtmfInterSequenceGapMulaw(): Buffer {
  return mulawSilence(DTMF_GAP_MS);
}

function renderDtmfTone(frequencies: readonly [number, number]): Buffer {
  const sampleCount = Math.round((DTMF_SAMPLE_RATE * DTMF_TONE_MS) / 1_000);
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const elapsed = index / DTMF_SAMPLE_RATE;
    const sample =
      8_000 * Math.sin(2 * Math.PI * frequencies[0] * elapsed) +
      8_000 * Math.sin(2 * Math.PI * frequencies[1] * elapsed);
    pcm.writeInt16LE(Math.round(sample), index * 2);
  }
  return convertPcmToMulaw8k(pcm, DTMF_SAMPLE_RATE);
}

/** Render an in-band 8 kHz G.711 mu-law DTMF sequence for a live media stream. */
export function createDtmfMulaw(digits: string): Buffer {
  const chunks: Buffer[] = [];
  let previousWasTone = false;
  for (const raw of digits) {
    const frequencies = DTMF_FREQUENCIES[raw];
    if (frequencies) {
      if (previousWasTone) {
        chunks.push(mulawSilence(DTMF_GAP_MS));
      }
      chunks.push(renderDtmfTone(frequencies));
      previousWasTone = true;
      continue;
    }
    const pauseMs = DTMF_PAUSE_MS[raw];
    if (pauseMs !== undefined) {
      chunks.push(mulawSilence(pauseMs));
      previousWasTone = false;
    }
  }
  return Buffer.concat(chunks);
}

/** Validate the DTMF alphabet accepted by every voice-call transport. */
export function validateDtmfDigits(digits: string): string | null {
  return /^[0-9*#wWpP,]+$/.test(digits)
    ? null
    : "digits may only contain digits, *, #, comma, w, p";
}
