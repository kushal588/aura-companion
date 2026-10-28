import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MOUTH_PARAMS,
  base64ToBytes,
  bytesToBase64,
  float32ToPcm16,
  parseWav,
  pcm16ToFloat32,
  resampleLinear,
  rmsToMouth,
  rootMeanSquare,
  silenceRatio,
} from '../src/utils/pcm';
import { LipSyncController } from '../src/avatar/LipSyncController';

function buildWav(samples: Float32Array, sampleRate = 24000, channels = 1): ArrayBuffer {
  const dataLength = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const writeString = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataLength, true);
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(44 + i * 2, Math.round((samples[i] as number) * 32767), true);
  }
  return buffer;
}

describe('PCM and WAV helpers', () => {
  it('round-trips 16-bit PCM', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const bytes = float32ToPcm16(samples);
    const decoded = pcm16ToFloat32(bytes);
    expect(decoded).toHaveLength(samples.length);
    expect(decoded[1]).toBeCloseTo(0.5, 3);
    expect(decoded[2]).toBeCloseTo(-0.5, 3);
    expect(decoded[3]).toBeCloseTo(1, 3);
  });

  it('round-trips base64', () => {
    const bytes = new Uint8Array([1, 2, 3, 250]);
    expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([1, 2, 3, 250]);
  });

  it('parses a 24 kHz mono WAV returned by TTS', () => {
    const samples = new Float32Array([0.1, -0.2, 0.3, -0.4]);
    const wav = parseWav(buildWav(samples));
    expect(wav.sampleRate).toBe(24000);
    expect(wav.samples).toHaveLength(4);
    expect(wav.samples[0]).toBeCloseTo(0.1, 2);
  });

  it('downmixes stereo and rejects non-WAV data', () => {
    const interleaved = new Float32Array([0.5, 0.5, -0.5, -0.5]);
    const stereo = parseWav(buildWav(interleaved, 24000, 2));
    expect(stereo.samples).toHaveLength(2);
    expect(stereo.samples[0]).toBeCloseTo(0.5, 2);
    expect(() => parseWav(new ArrayBuffer(64))).toThrow();
  });

  it('resamples and measures level', () => {
    const input = new Float32Array([0, 1, 0, -1]);
    expect(resampleLinear(input, 16000, 32000)).toHaveLength(8);
    expect(resampleLinear(input, 16000, 16000)).toBe(input);
    expect(rootMeanSquare(new Float32Array([1, -1, 1, -1]))).toBeCloseTo(1, 5);
    expect(silenceRatio(new Float32Array([0, 0, 0.5, 0]), 0.01)).toBeCloseTo(0.75, 5);
  });
});

describe('rmsToMouth', () => {
  it('keeps the mouth closed below the noise gate', () => {
    const next = rmsToMouth(0.001, 0.8, DEFAULT_MOUTH_PARAMS);
    expect(next).toBeLessThan(0.8);
    expect(next).toBeCloseTo(0.8 * (1 - DEFAULT_MOUTH_PARAMS.release), 5);
  });

  it('opens on loud audio and saturates rather than exceeding the maximum', () => {
    const loud = rmsToMouth(1, 0.1, DEFAULT_MOUTH_PARAMS);
    expect(loud).toBeGreaterThan(0.1);
    expect(loud).toBeLessThanOrEqual(DEFAULT_MOUTH_PARAMS.maxOpen);
  });

  it('attacks faster than it releases so the jaw does not flap', () => {
    const open = rmsToMouth(0.3, 0, DEFAULT_MOUTH_PARAMS);
    const close = rmsToMouth(0.001, 1, DEFAULT_MOUTH_PARAMS);
    expect(open).toBeGreaterThan(1 - close);
  });
});

describe('LipSyncController', () => {
  it('follows the analyser level and closes when speech stops', () => {
    let level = 0.4;
    const controller = new LipSyncController();
    controller.attach({ currentLevel: () => level, bufferedMs: () => 0 });
    controller.setSpeaking(true);

    for (let i = 0; i < 20; i += 1) controller.update();
    const open = controller.openness;
    expect(open).toBeGreaterThan(0.2);

    level = 0;
    controller.setSpeaking(false);
    for (let i = 0; i < 200; i += 1) controller.update();
    expect(controller.openness).toBeLessThan(0.05);
  });

  it('produces a mouth value from raw samples without an analyser', () => {
    const controller = new LipSyncController();
    const samples = new Float32Array(256).fill(0.5);
    expect(controller.feedSamples(samples)).toBeGreaterThan(0.2);
    expect(controller.feedSamples(new Float32Array(256))).toBeLessThan(0.5);
  });
});
