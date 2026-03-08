import { preprocessBreathSamples, type BreathPreprocessSummary } from "@/lib/audio/preprocess";

export type AudioFeatureTimeline = {
  envelope: number[];
  energy: number[];
  duration: number;
  sampleRate: number;
  preprocess?: BreathPreprocessSummary | null;
};

function normalize(values: number[]) {
  const max = values.reduce((peak, value) => Math.max(peak, value), 0);
  if (max <= 0) return values.map(() => 0);
  return values.map((value) => value / max);
}

function createAudioContextInstance() {
  if (typeof window === "undefined") return null;

  const MaybeWebkitContext = (
    window as Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext }
  ).webkitAudioContext;

  const AudioContextCtor = window.AudioContext || MaybeWebkitContext;
  if (!AudioContextCtor) return null;

  return new AudioContextCtor();
}

function mixChannels(buffer: AudioBuffer) {
  const length = buffer.length;
  const channels = Math.max(1, buffer.numberOfChannels);
  const output = new Float32Array(length);

  for (let index = 0; index < length; index += 1) {
    let mixed = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      mixed += buffer.getChannelData(channel)[index] ?? 0;
    }
    output[index] = mixed / channels;
  }

  return output;
}

function downsample(values: number[], bins: number) {
  if (!values.length || bins <= 0) return [];
  if (values.length <= bins) return values.slice();

  const result: number[] = [];
  const stride = values.length / bins;

  for (let index = 0; index < bins; index += 1) {
    const start = Math.floor(index * stride);
    const end = Math.min(values.length, Math.floor((index + 1) * stride));
    const slice = values.slice(start, end);
    result.push(slice.length ? slice.reduce((sum, value) => sum + value, 0) / slice.length : 0);
  }

  return result;
}

export async function extractAudioFeatureTimeline(blob: Blob, bins = 340): Promise<AudioFeatureTimeline> {
  const context = createAudioContextInstance();
  if (!context) {
    throw new Error("AudioContext is unavailable in this browser.");
  }

  try {
    const buffer = await blob.arrayBuffer();
    const audioBuffer = await context.decodeAudioData(buffer.slice(0));
    const mixedSamples = mixChannels(audioBuffer);
    let preprocess: BreathPreprocessSummary | null = null;
    try {
      preprocess = await preprocessBreathSamples(mixedSamples, audioBuffer.sampleRate);
    } catch {
      preprocess = null;
    }

    const totalSamples = audioBuffer.length;
    const channels = Math.max(1, audioBuffer.numberOfChannels);
    const samplesPerBin = Math.max(1, Math.floor(totalSamples / bins));

    const envelope: number[] = [];
    const energy: number[] = [];

    for (let start = 0; start < totalSamples; start += samplesPerBin) {
      const end = Math.min(start + samplesPerBin, totalSamples);
      let sumAbs = 0;
      let sumSquares = 0;
      let count = 0;

      for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
        let mixed = 0;

        for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
          mixed += audioBuffer.getChannelData(channelIndex)[sampleIndex] ?? 0;
        }

        mixed /= channels;
        sumAbs += Math.abs(mixed);
        sumSquares += mixed * mixed;
        count += 1;
      }

      if (count === 0) {
        envelope.push(0);
        energy.push(0);
        continue;
      }

      envelope.push(sumAbs / count);
      energy.push(Math.sqrt(sumSquares / count));
    }

    const preprocessEnvelope = preprocess?.debug?.rmsSmooth?.length
      ? downsample(preprocess.debug.rmsSmooth, bins)
      : [];
    const preprocessThreshold = preprocess?.debug?.threshold?.length
      ? downsample(preprocess.debug.threshold, bins)
      : [];

    const weightedEnvelope = envelope.map((value, index) => {
      const smooth = preprocessEnvelope[index] ?? value;
      return value * 0.4 + smooth * 0.6;
    });
    const weightedEnergy = energy.map((value, index) => {
      const threshold = preprocessThreshold[index] ?? 0;
      return value * 0.65 + threshold * 0.35;
    });

    return {
      envelope: normalize(weightedEnvelope),
      energy: normalize(weightedEnergy),
      duration: audioBuffer.duration,
      sampleRate: audioBuffer.sampleRate,
      preprocess
    };
  } finally {
    await context.close();
  }
}
