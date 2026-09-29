// Voice Call tests cover telephony audio plugin behavior.
import { mulawToPcm } from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it } from "vitest";
import { convertPcmToMulaw8k, createDtmfMulaw } from "./telephony-audio.js";

function makeSinePcm(
  sampleRate: number,
  frequencyHz: number,
  durationSeconds: number,
  amplitude = 12_000,
): Buffer {
  const samples = Math.floor(sampleRate * durationSeconds);
  const output = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const value = Math.round(Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate) * amplitude);
    output.writeInt16LE(value, i * 2);
  }
  return output;
}

function unalignedCopy(buffer: Buffer): Buffer {
  const padded = Buffer.alloc(buffer.length + 1);
  buffer.copy(padded, 1);
  return padded.subarray(1);
}

function tonePower(muLaw: Buffer, frequencyHz: number): number {
  const pcm = mulawToPcm(muLaw);
  let real = 0;
  let imaginary = 0;
  for (let index = 0; index < muLaw.length; index += 1) {
    const angle = (2 * Math.PI * frequencyHz * index) / 8_000;
    const sample = pcm.readInt16LE(index * 2);
    real += sample * Math.cos(angle);
    imaginary -= sample * Math.sin(angle);
  }
  return real * real + imaginary * imaginary;
}

describe("telephony-audio convertPcmToMulaw8k", () => {
  it("matches the typed-array path for unaligned pcm buffers", () => {
    const input = makeSinePcm(8_000, 1_000, 0.2);
    const mulaw = convertPcmToMulaw8k(input, 8_000);
    const unalignedMulaw = convertPcmToMulaw8k(unalignedCopy(input), 8_000);
    expect(unalignedMulaw.equals(mulaw)).toBe(true);
  });
});

describe("createDtmfMulaw", () => {
  it("renders standard keys as 120ms tones with 100ms gaps", () => {
    const audio = createDtmfMulaw("123456789*0#");

    expect(audio.length).toBe(12 * 960 + 11 * 800);
    expect(audio.subarray(960, 1760).every((sample) => sample === 0xff)).toBe(true);
    expect(new Set(audio.subarray(0, 960)).size).toBeGreaterThan(8);
  });

  it.each([
    ["1", 697, 1209],
    ["2", 697, 1336],
    ["3", 697, 1477],
    ["4", 770, 1209],
    ["5", 770, 1336],
    ["6", 770, 1477],
    ["7", 852, 1209],
    ["8", 852, 1336],
    ["9", 852, 1477],
    ["*", 941, 1209],
    ["0", 941, 1336],
    ["#", 941, 1477],
  ] as const)("uses the standard frequency pair for %s", (key, row, column) => {
    const audio = createDtmfMulaw(key);
    const rowPowers = [697, 770, 852, 941].map((frequency) => tonePower(audio, frequency));
    const columnPowers = [1209, 1336, 1477].map((frequency) => tonePower(audio, frequency));

    expect(rowPowers.indexOf(Math.max(...rowPowers))).toBe([697, 770, 852, 941].indexOf(row));
    expect(columnPowers.indexOf(Math.max(...columnPowers))).toBe(
      [1209, 1336, 1477].indexOf(column),
    );
  });

  it("renders supported pause tokens without falling back to TwiML", () => {
    const audio = createDtmfMulaw("1w2W3p4P5,6");

    expect(audio.length).toBeGreaterThan(6 * 960);
    expect(audio.includes(0xff)).toBe(true);
  });
});
