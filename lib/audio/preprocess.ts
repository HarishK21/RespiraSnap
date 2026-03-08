export type BreathQuality = "Good" | "Fair" | "Noisy";

export type BreathInterruption = {
  tStart: number;
  tEnd: number;
  confidence: number;
};

export type BreathPreprocessDebug = {
  time: number[];
  rmsSmooth: number[];
  threshold: number[];
  silenceMask: number[];
  interruptions: BreathInterruption[];
};

export type BreathPreprocessSeries = {
  time: number[];
  rmsSmooth: number[];
  threshold: number[];
  silenceMask: boolean[];
};

export type BreathPreprocessSummary = {
  quality: BreathQuality;
  qualityNoiseFloor: number;
  noiseFloor: number;
  mad: number;
  threshold: number;
  breathMean: number;
  breathStd: number;
  windowSeconds: number;
  hopSeconds: number;
  interruptions: BreathInterruption[];
  series: BreathPreprocessSeries;
  debug: BreathPreprocessDebug;
};

type PreprocessOptions = {
  highpassHz?: number;
  lowpassHz?: number;
  windowSeconds?: number;
  hopSeconds?: number;
  smoothingFrames?: number;
  gateK?: number;
  spikeWindowSeconds?: number;
  spikeHopSeconds?: number;
  spikeSmoothingFrames?: number;
  spikeMadK?: number;
  debugBins?: number;
};

type PreprocessInternals = {
  duration: number;
  rms: number[];
  rmsSmooth: number[];
  time: number[];
  noiseFloor: number;
  mad: number;
  threshold: number;
  silenceMask: boolean[];
  breathMean: number;
  breathStd: number;
  quality: BreathQuality;
  spikeTime: number[];
  spikeRms: number[];
  spikeBaseline: number;
  spikeMad: number;
  spikeTrigger: number;
  interruptions: BreathInterruption[];
};

const DEFAULTS = {
  highpassHz: 100,
  lowpassHz: 3000,
  windowSeconds: 0.025,
  hopSeconds: 0.0125,
  smoothingFrames: 7,
  gateK: 3,
  spikeWindowSeconds: 0.015,
  spikeHopSeconds: 0.0075,
  spikeSmoothingFrames: 3,
  spikeMadK: 8,
  debugBins: 280
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function mean(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values: number[]) {
  if (!values.length) return 0;
  const avg = mean(values);
  return values.reduce((sum, value) => {
    const diff = value - avg;
    return sum + diff * diff;
  }, 0) / values.length;
}

function std(values: number[]) {
  return Math.sqrt(variance(values));
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function medianAbsoluteDeviation(values: number[], center: number) {
  if (!values.length) return 0;
  const deviation = values.map((value) => Math.abs(value - center));
  return median(deviation);
}

function movingAverage(values: number[], frames: number) {
  if (!values.length) return [];
  const radius = Math.max(1, Math.floor(frames / 2));
  const result: number[] = [];

  for (let index = 0; index < values.length; index += 1) {
    let total = 0;
    let count = 0;
    const start = Math.max(0, index - radius);
    const end = Math.min(values.length - 1, index + radius);

    for (let cursor = start; cursor <= end; cursor += 1) {
      total += values[cursor] ?? 0;
      count += 1;
    }

    result.push(count ? total / count : 0);
  }

  return result;
}

function downsample(values: number[], target: number) {
  if (!values.length || target <= 0) return [];
  if (values.length <= target) return values.slice();

  const result: number[] = [];
  const stride = values.length / target;

  for (let index = 0; index < target; index += 1) {
    const start = Math.floor(index * stride);
    const end = Math.min(values.length, Math.floor((index + 1) * stride));
    const slice = values.slice(start, end);
    result.push(slice.length ? mean(slice) : 0);
  }

  return result;
}

function resampleBooleans(values: boolean[], target: number) {
  if (!values.length || target <= 0) return [];
  if (values.length <= target) return values.map((value) => (value ? 1 : 0));

  const result: number[] = [];
  const stride = values.length / target;

  for (let index = 0; index < target; index += 1) {
    const start = Math.floor(index * stride);
    const end = Math.min(values.length, Math.floor((index + 1) * stride));
    let total = 0;
    let count = 0;

    for (let cursor = start; cursor < end; cursor += 1) {
      total += values[cursor] ? 1 : 0;
      count += 1;
    }

    result.push(count ? total / count : 0);
  }

  return result;
}

function lowPassFilter(samples: Float32Array, sampleRate: number, cutoffHz: number) {
  const output = new Float32Array(samples.length);
  if (!samples.length) return output;

  const dt = 1 / Math.max(sampleRate, 1);
  const rc = 1 / (2 * Math.PI * Math.max(1, cutoffHz));
  const alpha = dt / (rc + dt);

  output[0] = samples[0] ?? 0;
  for (let index = 1; index < samples.length; index += 1) {
    output[index] = output[index - 1] + alpha * ((samples[index] ?? 0) - output[index - 1]);
  }

  return output;
}

function highPassFilter(samples: Float32Array, sampleRate: number, cutoffHz: number) {
  const output = new Float32Array(samples.length);
  if (!samples.length) return output;

  const dt = 1 / Math.max(sampleRate, 1);
  const rc = 1 / (2 * Math.PI * Math.max(1, cutoffHz));
  const alpha = rc / (rc + dt);

  output[0] = samples[0] ?? 0;
  for (let index = 1; index < samples.length; index += 1) {
    output[index] = alpha * (output[index - 1] + (samples[index] ?? 0) - (samples[index - 1] ?? 0));
  }

  return output;
}

function fallbackBandPass(samples: Float32Array, sampleRate: number, highpassHz: number, lowpassHz: number) {
  const hp = highPassFilter(samples, sampleRate, highpassHz);
  return lowPassFilter(hp, sampleRate, lowpassHz);
}

function getOfflineAudioContextCtor() {
  if (typeof window === "undefined") return null;

  const maybeWebkit = (
    window as Window & typeof globalThis & { webkitOfflineAudioContext?: typeof OfflineAudioContext }
  ).webkitOfflineAudioContext;

  return window.OfflineAudioContext || maybeWebkit || null;
}

async function bandPassFilter(
  samples: Float32Array,
  sampleRate: number,
  highpassHz: number,
  lowpassHz: number
) {
  const OfflineAudioContextCtor = getOfflineAudioContextCtor();
  if (!OfflineAudioContextCtor) {
    return fallbackBandPass(samples, sampleRate, highpassHz, lowpassHz);
  }

  try {
    const offline = new OfflineAudioContextCtor(1, samples.length, sampleRate);
    const buffer = offline.createBuffer(1, samples.length, sampleRate);

    const channelData = new Float32Array(samples.length);
    channelData.set(samples);

    if (typeof buffer.copyToChannel === "function") {
      buffer.copyToChannel(channelData, 0);
    } else {
      buffer.getChannelData(0).set(channelData);
    }

    const source = offline.createBufferSource();
    source.buffer = buffer;

    const highpass = offline.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = highpassHz;
    highpass.Q.value = 0.707;

    const lowpass = offline.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = lowpassHz;
    lowpass.Q.value = 0.707;

    source.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(offline.destination);
    source.start(0);

    const rendered = await offline.startRendering();
    return new Float32Array(rendered.getChannelData(0));
  } catch {
    return fallbackBandPass(samples, sampleRate, highpassHz, lowpassHz);
  }
}

function computeRmsWindows(
  samples: Float32Array,
  sampleRate: number,
  windowSeconds: number,
  hopSeconds: number
) {
  const windowSize = Math.max(1, Math.round(windowSeconds * sampleRate));
  const hopSize = Math.max(1, Math.round(hopSeconds * sampleRate));
  const rms: number[] = [];
  const peakAbs: number[] = [];
  const time: number[] = [];
  const duration = samples.length / Math.max(sampleRate, 1);

  for (let start = 0; start < samples.length; start += hopSize) {
    const end = Math.min(samples.length, start + windowSize);
    const count = end - start;
    if (count <= 0) break;

    let sumSquares = 0;
    let peak = 0;

    for (let index = start; index < end; index += 1) {
      const value = samples[index] ?? 0;
      const abs = Math.abs(value);
      sumSquares += value * value;
      if (abs > peak) peak = abs;
    }

    rms.push(Math.sqrt(sumSquares / count));
    peakAbs.push(peak);
    time.push(clamp((start + count * 0.5) / sampleRate, 0, duration));
  }

  return {
    windowSize,
    hopSize,
    duration,
    rms,
    peakAbs,
    time
  };
}

function computeGate(
  rmsSmooth: number[],
  gateK: number
): {
  noiseFloor: number;
  mad: number;
  threshold: number;
  silenceMask: boolean[];
} {
  if (!rmsSmooth.length) {
    return {
      noiseFloor: 0,
      mad: 0,
      threshold: 0,
      silenceMask: []
    };
  }

  const sorted = [...rmsSmooth].sort((left, right) => left - right);
  const quietCount = Math.max(1, Math.floor(sorted.length * 0.2));
  const quiet = sorted.slice(0, quietCount);
  const noiseFloor = median(quiet);

  const center = median(rmsSmooth);
  const absoluteDeviation = rmsSmooth.map((value) => Math.abs(value - center));
  const mad = Math.max(1e-7, median(absoluteDeviation));
  const threshold = noiseFloor + gateK * mad;
  const silenceMask = rmsSmooth.map((value) => value < threshold);

  return {
    noiseFloor,
    mad,
    threshold,
    silenceMask
  };
}

function computeQuality(input: {
  rmsSmooth: number[];
  silenceMask: boolean[];
  noiseFloor: number;
  threshold: number;
}) {
  const nonSilent = input.rmsSmooth.filter((_, index) => !input.silenceMask[index]);
  const source = nonSilent.length ? nonSilent : input.rmsSmooth;
  const breathMean = mean(source);
  const breathStd = std(source);

  const snrRatio = (breathMean - input.noiseFloor) / Math.max(input.noiseFloor, 1e-7);
  const thresholdRatio = input.threshold / Math.max(breathMean, 1e-7);
  const nonSilentRatio = nonSilent.length / Math.max(1, input.rmsSmooth.length);

  let quality: BreathQuality = "Good";
  if (snrRatio < 0.55 || thresholdRatio > 0.94 || nonSilentRatio > 0.94) {
    quality = "Noisy";
  } else if (snrRatio < 1.15 || thresholdRatio > 0.78 || nonSilentRatio > 0.86) {
    quality = "Fair";
  }

  return {
    quality,
    breathMean,
    breathStd
  };
}

function detectInterruptions(input: {
  spikeRms: number[];
  spikeTime: number[];
  duration: number;
  spikeWindowSeconds: number;
  spikeHopSeconds: number;
  nonSilentMask: boolean[];
  baseline: number;
  spread: number;
  trigger: number;
  triggerK: number;
  quality: BreathQuality;
}) {
  if (!input.spikeRms.length) return [] as BreathInterruption[];

  const spread = Math.max(input.spread, 1e-7);
  const trigger = Math.max(input.trigger, input.baseline + input.triggerK * spread);
  const leadingGuard = 0.4;
  const trailingGuard = Math.max(0, input.duration - 0.4);
  const active = input.spikeRms.map((value, index) => {
    const nonSilent = input.nonSilentMask[index] ?? true;
    return value > trigger && (nonSilent || value > trigger * 1.12);
  });

  const groups: Array<{ start: number; end: number }> = [];
  let start = -1;

  for (let index = 0; index < active.length; index += 1) {
    if (active[index] && start < 0) {
      start = index;
      continue;
    }

    if (!active[index] && start >= 0) {
      groups.push({ start, end: index - 1 });
      start = -1;
    }
  }

  if (start >= 0) {
    groups.push({ start, end: active.length - 1 });
  }

  const interruptions: BreathInterruption[] = [];

  groups.forEach((group) => {
    const tStart = clamp(input.spikeTime[group.start] - input.spikeWindowSeconds * 0.5, 0, input.duration);
    const tEnd = clamp(input.spikeTime[group.end] + input.spikeWindowSeconds * 0.5, tStart, input.duration);
    const duration = tEnd - tStart;
    if (duration < 0.05 || duration > 0.35) return;
    if (tStart < leadingGuard || tEnd > trailingGuard) return;

    const segmentValues = input.spikeRms.slice(group.start, group.end + 1);
    if (!segmentValues.length) return;

    const peak = Math.max(...segmentValues, 0);
    if (peak <= trigger) return;

    const localRadiusFrames = Math.max(3, Math.round(0.08 / Math.max(input.spikeHopSeconds, 1e-7)));
    const localStart = Math.max(0, group.start - localRadiusFrames);
    const localEnd = Math.min(input.spikeRms.length - 1, group.end + localRadiusFrames);
    const localValues = input.spikeRms.slice(localStart, localEnd + 1);
    const localBaseline = localValues.length ? median(localValues) : input.baseline;
    const prominence = peak - localBaseline;
    const minProminence = Math.max(spread * 5.5, (trigger - input.baseline) * 0.5);
    if (prominence < minProminence) return;

    let maxDerivative = 0;
    for (let index = Math.max(1, group.start); index <= group.end; index += 1) {
      const derivative =
        Math.abs((input.spikeRms[index] ?? 0) - (input.spikeRms[index - 1] ?? 0)) /
        Math.max(input.spikeHopSeconds, 1e-7);
      maxDerivative = Math.max(maxDerivative, derivative);
    }
    const derivativeFloor = Math.max(spread / Math.max(input.spikeHopSeconds, 1e-7), 0.08);
    if (maxDerivative < derivativeFloor * 1.35) return;

    const zScore = (peak - input.baseline) / spread;
    const burstScore = clamp((zScore - input.triggerK) / 4, 0, 1);
    const prominenceScore = clamp(prominence / Math.max(minProminence * 2, 1e-7), 0, 1);
    const derivativeScore = clamp(maxDerivative / Math.max(derivativeFloor * 2.5, 0.12), 0, 1);
    const durationScore = clamp(1 - Math.abs(duration - 0.16) / 0.2, 0, 1);

    let confidence = clamp(
      0.22 + burstScore * 0.42 + prominenceScore * 0.22 + derivativeScore * 0.14 + durationScore * 0.1,
      0.05,
      0.99
    );

    if (input.quality === "Noisy") {
      confidence *= 0.55;
    } else if (input.quality === "Fair") {
      confidence *= 0.82;
    }

    if (confidence < 0.22) return;

    interruptions.push({
      tStart: Number(tStart.toFixed(3)),
      tEnd: Number(tEnd.toFixed(3)),
      confidence: Number(clamp(confidence, 0, 0.99).toFixed(3))
    });
  });

  return interruptions;
}

function mapSilenceMaskByTime(input: {
  sourceTime: number[];
  sourceSilenceMask: boolean[];
  targetTime: number[];
}) {
  if (!input.targetTime.length) return [] as boolean[];
  if (!input.sourceTime.length || !input.sourceSilenceMask.length) {
    return input.targetTime.map(() => false);
  }

  let sourceIndex = 0;
  const mapped: boolean[] = [];

  input.targetTime.forEach((target) => {
    while (
      sourceIndex < input.sourceTime.length - 1 &&
      (input.sourceTime[sourceIndex + 1] ?? Number.POSITIVE_INFINITY) <= target
    ) {
      sourceIndex += 1;
    }
    mapped.push(Boolean(input.sourceSilenceMask[sourceIndex]));
  });

  return mapped;
}

function computePreprocessInternals(
  filtered: Float32Array,
  sampleRate: number,
  options: Required<PreprocessOptions>
) {
  const windows = computeRmsWindows(filtered, sampleRate, options.windowSeconds, options.hopSeconds);
  const rmsSmooth = movingAverage(windows.rms, options.smoothingFrames);
  const gate = computeGate(rmsSmooth, options.gateK);
  const quality = computeQuality({
    rmsSmooth,
    silenceMask: gate.silenceMask,
    noiseFloor: gate.noiseFloor,
    threshold: gate.threshold
  });

  const spikeWindows = computeRmsWindows(
    filtered,
    sampleRate,
    options.spikeWindowSeconds,
    options.spikeHopSeconds
  );
  const spikeRms = movingAverage(spikeWindows.rms, Math.min(Math.max(1, options.spikeSmoothingFrames), 3));
  const spikeSilenceMask = mapSilenceMaskByTime({
    sourceTime: windows.time,
    sourceSilenceMask: gate.silenceMask,
    targetTime: spikeWindows.time
  });
  const spikeNonSilentValues = spikeRms.filter((_, index) => !spikeSilenceMask[index]);
  const spikeSource = spikeNonSilentValues.length ? spikeNonSilentValues : spikeRms;
  const spikeBaseline = median(spikeSource);
  const spikeMad = Math.max(1e-7, medianAbsoluteDeviation(spikeSource, spikeBaseline));
  const spikeTrigger = spikeBaseline + options.spikeMadK * spikeMad;

  const interruptions = detectInterruptions({
    spikeRms,
    spikeTime: spikeWindows.time,
    duration: windows.duration,
    spikeWindowSeconds: options.spikeWindowSeconds,
    spikeHopSeconds: options.spikeHopSeconds,
    nonSilentMask: spikeSilenceMask.map((value) => !value),
    baseline: spikeBaseline,
    spread: spikeMad,
    trigger: spikeTrigger,
    triggerK: options.spikeMadK,
    quality: quality.quality
  });

  return {
    duration: windows.duration,
    rms: windows.rms,
    rmsSmooth,
    time: windows.time,
    noiseFloor: gate.noiseFloor,
    mad: gate.mad,
    threshold: gate.threshold,
    silenceMask: gate.silenceMask,
    breathMean: quality.breathMean,
    breathStd: quality.breathStd,
    quality: quality.quality,
    spikeTime: spikeWindows.time,
    spikeRms,
    spikeBaseline,
    spikeMad,
    spikeTrigger,
    interruptions
  } satisfies PreprocessInternals;
}

export async function preprocessBreathSamples(
  samples: Float32Array,
  sampleRate: number,
  rawOptions: PreprocessOptions = {}
) {
  const options = {
    ...DEFAULTS,
    ...rawOptions
  } satisfies Required<PreprocessOptions>;

  if (!samples.length || sampleRate <= 0) {
    return {
      quality: "Noisy" as BreathQuality,
      qualityNoiseFloor: 0,
      noiseFloor: 0,
      mad: 0,
      threshold: 0,
      breathMean: 0,
      breathStd: 0,
      windowSeconds: options.windowSeconds,
      hopSeconds: options.hopSeconds,
      interruptions: [],
      series: {
        time: [],
        rmsSmooth: [],
        threshold: [],
        silenceMask: []
      },
      debug: {
        time: [],
        rmsSmooth: [],
        threshold: [],
        silenceMask: [],
        interruptions: []
      }
    } satisfies BreathPreprocessSummary;
  }

  const filtered = await bandPassFilter(samples, sampleRate, options.highpassHz, options.lowpassHz);
  const internals = computePreprocessInternals(filtered, sampleRate, options);

  const targetBins = Math.max(80, options.debugBins);
  const time = downsample(internals.spikeTime, targetBins);
  const rmsSmooth = downsample(internals.spikeRms, targetBins);
  const threshold = Array.from({ length: rmsSmooth.length }, () => internals.spikeTrigger);
  const silenceMask = resampleBooleans(internals.silenceMask, targetBins);

  return {
    quality: internals.quality,
    qualityNoiseFloor: Number(internals.noiseFloor.toFixed(6)),
    noiseFloor: Number(internals.noiseFloor.toFixed(6)),
    mad: Number(internals.mad.toFixed(6)),
    threshold: Number(internals.threshold.toFixed(6)),
    breathMean: Number(internals.breathMean.toFixed(6)),
    breathStd: Number(internals.breathStd.toFixed(6)),
    windowSeconds: options.windowSeconds,
    hopSeconds: options.hopSeconds,
    interruptions: internals.interruptions,
    series: {
      time: internals.time.map((value) => Number(value.toFixed(6))),
      rmsSmooth: internals.rmsSmooth.map((value) => Number(value.toFixed(6))),
      threshold: Array.from({ length: internals.rmsSmooth.length }, () => Number(internals.threshold.toFixed(6))),
      silenceMask: internals.silenceMask.slice()
    },
    debug: {
      time: time.map((value) => Number(value.toFixed(4))),
      rmsSmooth: rmsSmooth.map((value) => Number(value.toFixed(6))),
      threshold: threshold.map((value) => Number(value.toFixed(6))),
      silenceMask: silenceMask.map((value) => Number(value.toFixed(6))),
      interruptions: internals.interruptions
    }
  } satisfies BreathPreprocessSummary;
}
