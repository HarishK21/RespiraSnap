export type AudioFeatureTimeline = {
  envelope: number[];
  energy: number[];
  duration: number;
  sampleRate: number;
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

export async function extractAudioFeatureTimeline(blob: Blob, bins = 340): Promise<AudioFeatureTimeline> {
  const context = createAudioContextInstance();
  if (!context) {
    throw new Error("AudioContext is unavailable in this browser.");
  }

  try {
    const buffer = await blob.arrayBuffer();
    const audioBuffer = await context.decodeAudioData(buffer.slice(0));

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

    return {
      envelope: normalize(envelope),
      energy: normalize(energy),
      duration: audioBuffer.duration,
      sampleRate: audioBuffer.sampleRate
    };
  } finally {
    await context.close();
  }
}
