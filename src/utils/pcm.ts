/**
 * PCM/WAV helpers and the amplitude lip-sync maths (PLAN §7.2, §7.3).
 *
 * Gemini Live sends raw 16-bit little-endian PCM; TTS returns either a WAV
 * container or headerless L16. Everything here is pure so it can be unit tested
 * without an audio device.
 */

export const PCM16_MAX = 32768;

export function base64ToBytes(base64: string): Uint8Array {
  const normalized = base64.replace(/\s+/g, '');
  if (typeof atob === 'function') {
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  // Node/test fallback
  return Uint8Array.from(Buffer.from(normalized, 'base64'));
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i] as number);
    }
    return btoa(binary);
  }
  return Buffer.from(bytes).toString('base64');
}

/** 16-bit LE PCM → mono float samples in [-1, 1]. */
export function pcm16ToFloat32(bytes: Uint8Array): Float32Array {
  const sampleCount = Math.floor(bytes.length / 2);
  const samples = new Float32Array(sampleCount);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < sampleCount; i += 1) {
    samples[i] = view.getInt16(i * 2, true) / PCM16_MAX;
  }
  return samples;
}

/** Float samples → 16-bit LE PCM (used for mic capture). */
export function float32ToPcm16(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] as number));
    view.setInt16(i * 2, Math.round(clamped * (PCM16_MAX - 1)), true);
  }
  return bytes;
}

export interface WavData {
  samples: Float32Array;
  sampleRate: number;
}

/** Minimal RIFF/WAVE parser for the 16-bit PCM that TTS returns. */
export function parseWav(buffer: ArrayBuffer): WavData {
  const view = new DataView(buffer);
  if (buffer.byteLength < 44 || readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file');
  }
  let offset = 12;
  let sampleRate = 24000;
  let channels = 1;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataLength = 0;

  while (offset + 8 <= buffer.byteLength) {
    const chunkId = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (chunkId === 'fmt ') {
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (chunkId === 'data') {
      dataOffset = body;
      dataLength = Math.min(chunkSize, buffer.byteLength - body);
    }
    offset = body + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0) throw new Error('WAVE file has no data chunk');
  if (bitsPerSample !== 16) throw new Error(`Unsupported WAV bit depth: ${bitsPerSample}`);

  const bytes = new Uint8Array(buffer, dataOffset, dataLength);
  const interleaved = pcm16ToFloat32(bytes);
  const samples =
    channels > 1 ? downmix(interleaved, channels) : interleaved;

  return { samples, sampleRate };
}

function downmix(interleaved: Float32Array, channels: number): Float32Array {
  const frames = Math.floor(interleaved.length / channels);
  const output = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += interleaved[frame * channels + channel] as number;
    }
    output[frame] = sum / channels;
  }
  return output;
}

function readAscii(view: DataView, offset: number, length: number): string {
  let output = '';
  for (let i = 0; i < length; i += 1) {
    output += String.fromCharCode(view.getUint8(offset + i));
  }
  return output;
}

/** Linear resampler — enough for mic capture and playback-rate alignment. */
export function resampleLinear(
  input: Float32Array,
  inputRate: number,
  outputRate: number,
): Float32Array {
  if (inputRate === outputRate || input.length === 0) return input;
  const ratio = outputRate / inputRate;
  const outputLength = Math.max(1, Math.round(input.length * ratio));
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const position = i / ratio;
    const index = Math.floor(position);
    const next = Math.min(index + 1, input.length - 1);
    const fraction = position - index;
    const a = input[index] ?? 0;
    const b = input[next] ?? 0;
    output[i] = a + (b - a) * fraction;
  }
  return output;
}

export function rootMeanSquare(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] as number;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

export interface MouthParams {
  /** Below this RMS the mouth stays closed (noise gate). */
  gate: number;
  /** RMS mapped to a fully open mouth. */
  ceiling: number;
  /** Rising response (0..1) — lower opens faster. */
  attack: number;
  /** Falling response (0..1) — lower closes faster. */
  release: number;
  /** Maximum mouth openness. */
  maxOpen: number;
}

export const DEFAULT_MOUTH_PARAMS: MouthParams = {
  gate: 0.02,
  ceiling: 0.32,
  attack: 0.55,
  release: 0.18,
  maxOpen: 0.95,
};

/**
 * Amplitude → mouth openness with a noise gate and asymmetric smoothing so the
 * jaw does not flap on every sample. This is approximate lip sync, not
 * phoneme-level alignment (PLAN §7.3).
 */
export function rmsToMouth(rms: number, previous: number, params: MouthParams): number {
  const { gate, ceiling, attack, release, maxOpen } = params;
  if (rms <= gate) {
    return previous * (1 - release);
  }
  const normalized = Math.min(1, (rms - gate) / Math.max(1e-6, ceiling - gate));
  const target = normalized * maxOpen;
  const coefficient = target > previous ? attack : release;
  return previous + (target - previous) * coefficient;
}

/** Longest run of samples below the gate — used to detect natural pauses. */
export function silenceRatio(samples: Float32Array, gate: number): number {
  if (samples.length === 0) return 1;
  let silent = 0;
  for (let i = 0; i < samples.length; i += 1) {
    if (Math.abs(samples[i] as number) < gate) silent += 1;
  }
  return silent / samples.length;
}
