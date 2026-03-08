import type { BreathPreprocessSummary } from "@/lib/audio/preprocess";

export type AnalysisMarkerType = "event" | "irregular" | "rhythm" | "segment" | "interruption" | "hold";

export type AnalysisMarker = {
  id: string;
  time: number;
  label: string;
  type?: AnalysisMarkerType;
  detail?: string;
};

export type AnalysisSegment = {
  start: number;
  end: number;
  label: string;
  confidence?: number;
};

export type AnalysisWindow = {
  start: number;
  end: number;
  reason: string;
};

export type AnalysisHistoryEntry = {
  createdAt: string;
  score: number;
  envelope: number[];
  duration: number;
};

export type PillarTone = "good" | "warning" | "poor" | "neutral";
export type PillarConfidence = "high" | "med" | "low";

export type PhaseWindowStats = {
  start: number;
  end: number;
  meanRms: number;
  medianRms: number;
  varianceRms: number;
  percentAboveGate: number;
  activeDuration: number;
  totalDuration: number;
  sampleCount: number;
};

export type RhythmPillar = {
  shortLabel: "Rhythm";
  value: "Stable" | "Slightly Variable" | "Variable";
  tone: PillarTone;
  subtext: string;
  cycleCount: number;
  timingVariance: number | null;
  confidence: PillarConfidence;
};

export type ExhaleRatioPillar = {
  shortLabel: "Exhale Ratio";
  value: string;
  tone: PillarTone;
  subtext: string;
  ratio: number | null;
  uncertain: boolean;
  adherence: "On-target" | "Exhale short" | "Exhale long" | "Unknown";
  confidence: PillarConfidence;
};

export type InterruptionsPillar = {
  shortLabel: "Interruptions";
  value: string;
  tone: PillarTone;
  subtext: string;
  count: number;
  quality: "Good" | "Fair" | "Poor" | "Noisy";
  timestamps: string[];
  seconds: number[];
  markerSeconds: number[];
  lowConfidence: boolean;
  confidence: PillarConfidence;
};

export type HoldDetectedPillar = {
  shortLabel: "Hold";
  value: "Yes" | "No" | "Unclear";
  tone: PillarTone;
  subtext: string;
  enabled: boolean;
  detected: boolean | null;
  durationSeconds: number | null;
  markerTime: number | null;
  confidence: PillarConfidence;
};

export type SessionPillars = {
  rhythm: RhythmPillar;
  exhaleRatio: ExhaleRatioPillar;
  interruptions: InterruptionsPillar;
  holdDetected: HoldDetectedPillar;
};

export type SessionAnalysis = {
  createdAt: string;
  mode: string;
  score: number;
  deltaLabel: string;
  confidenceLabel: "low" | "med" | "high";
  patternSummary: string;
  patternBullets: string[];
  explainabilitySummary: string;
  clinicianSummary: string;
  coachingTip: string;
  followUpPrompt: string;
  reportText: string;
  reportLines: string[];
  nextCheckInLabel: string;
  keyMomentTime: number;
  pillars: SessionPillars;
  phaseStats: {
    inhale: PhaseWindowStats;
    hold: PhaseWindowStats;
    exhale: PhaseWindowStats;
  };
  preprocessDebug: BreathPreprocessSummary["debug"] | null;
  waveform: {
    envelope: number[];
    energy: number[];
    duration: number;
  };
  baselineEnvelope: number[] | null;
  eventDensity: number[];
  markers: AnalysisMarker[];
  segments: AnalysisSegment[];
  irregularWindows: AnalysisWindow[];
  sourceResults: Record<string, unknown>;
};

type BuildBundleInput = {
  mode: string;
  results: Record<string, unknown>;
  waveform: {
    envelope: number[];
    energy: number[];
    duration: number;
  };
  markers: Array<{ time: number; label: string }>;
  history: AnalysisHistoryEntry[];
  preprocessing?: BreathPreprocessSummary | null;
  createdAt?: string;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeString(value: unknown, fallback = "") {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function safeNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function safeArray(value: unknown) {
  return Array.isArray(value) ? value : [];
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

function stdDev(values: number[]) {
  return Math.sqrt(variance(values));
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}

const PHASE_WINDOWS = {
  inhale: { start: 0, end: 5 },
  hold: { start: 5, end: 8 },
  exhale: { start: 8, end: 15 }
} as const;

function downsample(values: number[], target: number) {
  if (!values.length || target <= 0) return [];
  if (values.length <= target) {
    return values.map((value) => Number(clamp(value, 0, 1).toFixed(4)));
  }

  const result: number[] = [];
  const stride = values.length / target;

  for (let index = 0; index < target; index += 1) {
    const start = Math.floor(index * stride);
    const end = Math.min(values.length, Math.floor((index + 1) * stride));
    let total = 0;
    let count = 0;

    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      total += Math.abs(values[sampleIndex] ?? 0);
      count += 1;
    }

    result.push(Number((count ? total / count : 0).toFixed(4)));
  }

  return result;
}

function inferConfidence(historyCount: number): "low" | "med" | "high" {
  if (historyCount >= 8) return "high";
  if (historyCount >= 3) return "med";
  return "low";
}

function parseConfidence(value: unknown, historyCount: number): "low" | "med" | "high" {
  const normalized = safeString(value).toLowerCase();
  if (normalized === "low" || normalized === "med" || normalized === "high") return normalized;
  return inferConfidence(historyCount);
}

function downgradeConfidence(value: "low" | "med" | "high", steps = 1): "low" | "med" | "high" {
  const scale: Array<"low" | "med" | "high"> = ["low", "med", "high"];
  const index = scale.indexOf(value);
  return scale[Math.max(0, index - steps)];
}

function formatConfidence(value: "low" | "med" | "high") {
  if (value === "high") return "High";
  if (value === "med") return "Med";
  return "Low";
}

function normalizeSegmentLabel(label: string) {
  return label.trim().toLowerCase();
}

function isInhaleLabel(label: string) {
  return normalizeSegmentLabel(label).includes("inhale");
}

function isExhaleLabel(label: string) {
  return normalizeSegmentLabel(label).includes("exhale");
}

function parseSegments(source: unknown, duration: number): AnalysisSegment[] {
  const parsed: AnalysisSegment[] = [];

  safeArray(source).forEach((item) => {
    if (!isObject(item)) return;

    const start = clamp(safeNumber(item.start, 0), 0, Math.max(duration, 0));
    const rawEnd = clamp(safeNumber(item.end, start), start, Math.max(duration, start));
    const end = rawEnd > start ? rawEnd : Math.min(duration, start + 0.2);

    parsed.push({
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      label: safeString(item.label, "segment"),
      confidence: Number(clamp(safeNumber(item.confidence, 0.5), 0, 1).toFixed(3))
    });
  });

  return parsed.sort((left, right) => left.start - right.start);
}

function parseIrregularWindows(source: unknown, duration: number): AnalysisWindow[] {
  const parsed: AnalysisWindow[] = [];

  safeArray(source).forEach((item) => {
    if (!isObject(item)) return;

    const start = clamp(safeNumber(item.start, 0), 0, Math.max(duration, 0));
    const rawEnd = clamp(safeNumber(item.end, start), start, Math.max(duration, start));
    const end = rawEnd > start ? rawEnd : Math.min(duration, start + 0.2);

    parsed.push({
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      reason: safeString(item.reason, "irregular rhythm")
    });
  });

  return parsed.sort((left, right) => left.start - right.start);
}

function formatTimeLabel(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

type PhaseSeriesBucket = {
  values: number[];
  activeValues: number[];
  activeCount: number;
};

function emptyPhaseWindowStats(start: number, end: number): PhaseWindowStats {
  return {
    start,
    end,
    meanRms: 0,
    medianRms: 0,
    varianceRms: 0,
    percentAboveGate: 0,
    activeDuration: 0,
    totalDuration: Math.max(0, end - start),
    sampleCount: 0
  };
}

function buildPhaseWindowStats(input: {
  start: number;
  end: number;
  values: number[];
  activeValues: number[];
  activeCount: number;
  hopSeconds: number;
}) {
  if (!input.values.length) {
    return emptyPhaseWindowStats(input.start, input.end);
  }

  const meanRms = mean(input.values);
  const varianceRms = variance(input.values);
  const medianRms = median(input.values);
  const percentAboveGate = (input.activeCount / input.values.length) * 100;
  const activeDuration = input.activeCount * input.hopSeconds;

  return {
    start: input.start,
    end: input.end,
    meanRms: Number(meanRms.toFixed(6)),
    medianRms: Number(medianRms.toFixed(6)),
    varianceRms: Number(varianceRms.toFixed(6)),
    percentAboveGate: Number(percentAboveGate.toFixed(2)),
    activeDuration: Number(activeDuration.toFixed(3)),
    totalDuration: Number(Math.max(0, input.end - input.start).toFixed(3)),
    sampleCount: input.values.length
  } satisfies PhaseWindowStats;
}

function computePhaseStats(preprocessing: BreathPreprocessSummary | null | undefined, duration: number) {
  const inhaleStart = Math.min(PHASE_WINDOWS.inhale.start, duration);
  const inhaleEnd = Math.min(PHASE_WINDOWS.inhale.end, duration);
  const holdStart = Math.min(PHASE_WINDOWS.hold.start, duration);
  const holdEnd = Math.min(PHASE_WINDOWS.hold.end, duration);
  const exhaleStart = Math.min(PHASE_WINDOWS.exhale.start, duration);
  const exhaleEnd = Math.min(PHASE_WINDOWS.exhale.end, duration);

  const buckets: Record<"inhale" | "hold" | "exhale", PhaseSeriesBucket> = {
    inhale: { values: [], activeValues: [], activeCount: 0 },
    hold: { values: [], activeValues: [], activeCount: 0 },
    exhale: { values: [], activeValues: [], activeCount: 0 }
  };

  const hopSeconds = preprocessing?.hopSeconds ?? 0.0125;
  const time = preprocessing?.series?.time ?? [];
  const rmsSmooth = preprocessing?.series?.rmsSmooth ?? [];
  const thresholds = preprocessing?.series?.threshold ?? [];
  const silenceMask = preprocessing?.series?.silenceMask ?? [];

  if (time.length && rmsSmooth.length) {
    const length = Math.min(time.length, rmsSmooth.length);

    for (let index = 0; index < length; index += 1) {
      const t = time[index] ?? 0;
      const value = rmsSmooth[index] ?? 0;
      const threshold = thresholds[index] ?? preprocessing?.threshold ?? 0;
      const silent = silenceMask[index] ?? value < threshold;
      const active = !silent && value > threshold;

      const inInhale = t >= inhaleStart && t < inhaleEnd;
      const inHold = t >= holdStart && t < holdEnd;
      const inExhale = t >= exhaleStart && t <= exhaleEnd + 1e-6;

      if (inInhale) {
        buckets.inhale.values.push(value);
        if (active) {
          buckets.inhale.activeValues.push(value);
          buckets.inhale.activeCount += 1;
        }
      } else if (inHold) {
        buckets.hold.values.push(value);
        if (active) {
          buckets.hold.activeValues.push(value);
          buckets.hold.activeCount += 1;
        }
      } else if (inExhale) {
        buckets.exhale.values.push(value);
        if (active) {
          buckets.exhale.activeValues.push(value);
          buckets.exhale.activeCount += 1;
        }
      }
    }
  }

  return {
    inhale: buildPhaseWindowStats({
      start: inhaleStart,
      end: inhaleEnd,
      values: buckets.inhale.values,
      activeValues: buckets.inhale.activeValues,
      activeCount: buckets.inhale.activeCount,
      hopSeconds
    }),
    hold: buildPhaseWindowStats({
      start: holdStart,
      end: holdEnd,
      values: buckets.hold.values,
      activeValues: buckets.hold.activeValues,
      activeCount: buckets.hold.activeCount,
      hopSeconds
    }),
    exhale: buildPhaseWindowStats({
      start: exhaleStart,
      end: exhaleEnd,
      values: buckets.exhale.values,
      activeValues: buckets.exhale.activeValues,
      activeCount: buckets.exhale.activeCount,
      hopSeconds
    }),
    hopSeconds,
    buckets
  };
}

function detectEnergySpikes(energy: number[], duration: number) {
  if (!energy.length || duration <= 0) return [] as number[];

  const avg = mean(energy);
  const deviation = stdDev(energy);
  const threshold = avg + Math.max(0.07, deviation * 2.1);
  const raw: number[] = [];

  for (let index = 1; index < energy.length - 1; index += 1) {
    const value = energy[index] ?? 0;
    if (value < threshold || value < 0.34) continue;
    const previous = energy[index - 1] ?? 0;
    const next = energy[index + 1] ?? 0;
    if (value < previous || value < next) continue;

    const ratio = index / Math.max(1, energy.length - 1);
    raw.push(Number((ratio * duration).toFixed(3)));
  }

  const deduped: number[] = [];
  raw.forEach((time) => {
    const last = deduped[deduped.length - 1];
    if (typeof last === "number" && Math.abs(last - time) < 0.45) return;
    deduped.push(time);
  });

  return deduped.slice(0, 8);
}

function buildRhythmPillar(input: {
  preprocessing?: BreathPreprocessSummary | null;
  phaseStats: ReturnType<typeof computePhaseStats>;
  energy: number[];
}) {
  const combinedActive = [
    ...input.phaseStats.buckets.inhale.activeValues,
    ...input.phaseStats.buckets.exhale.activeValues
  ];
  const activeDuration = input.phaseStats.inhale.activeDuration + input.phaseStats.exhale.activeDuration;

  const coefficient = combinedActive.length >= 10
    ? clamp(stdDev(combinedActive) / Math.max(1e-7, mean(combinedActive)), 0, 2)
    : clamp(Math.sqrt(variance(input.energy)) * 1.9, 0, 1.6);

  let value: RhythmPillar["value"] = "Slightly Variable";
  let tone: PillarTone = "warning";
  if (coefficient <= 0.32) {
    value = "Stable";
    tone = "good";
  } else if (coefficient <= 0.58) {
    value = "Slightly Variable";
    tone = "warning";
  } else {
    value = "Variable";
    tone = "poor";
  }

  let confidence: PillarConfidence = "high";
  const quality = input.preprocessing?.quality;
  if (!input.preprocessing || activeDuration < 2 || quality === "Noisy") {
    confidence = "low";
  } else if (activeDuration < 4 || quality === "Fair") {
    confidence = "med";
  }

  return {
    shortLabel: "Rhythm",
    value,
    tone,
    subtext: `CV ${coefficient.toFixed(2)} in inhale/exhale window.`,
    cycleCount: Math.max(1, Math.round(activeDuration / 4)),
    timingVariance: Number(coefficient.toFixed(4)),
    confidence
  } satisfies RhythmPillar;
}

function buildExhaleRatioPillar(input: {
  preprocessing?: BreathPreprocessSummary | null;
  phaseStats: ReturnType<typeof computePhaseStats>;
}) {
  const inhaleActive = input.phaseStats.inhale.activeDuration;
  const exhaleActive = input.phaseStats.exhale.activeDuration;
  const quality = input.preprocessing?.quality;

  const canCompute = inhaleActive >= 0.75 && exhaleActive >= 0.75;
  if (!canCompute) {
    return {
      shortLabel: "Exhale Ratio" as const,
      value: "—",
      tone: "warning" as PillarTone,
      subtext: "Low confidence.",
      ratio: null,
      uncertain: true,
      adherence: "Unknown" as const,
      confidence: "low" as PillarConfidence
    };
  }

  const ratio = clamp(exhaleActive / Math.max(inhaleActive, 1e-7), 0, 4);
  const onTarget = ratio >= 1.12 && ratio <= 1.68;
  const adherence: ExhaleRatioPillar["adherence"] = onTarget
    ? "On-target"
    : ratio < 1.12
      ? "Exhale short"
      : "Exhale long";

  let confidence: PillarConfidence = "high";
  if (!input.preprocessing || quality === "Noisy" || inhaleActive < 1.2) {
    confidence = "low";
  } else if (quality === "Fair" || inhaleActive < 2) {
    confidence = "med";
  }

  if (confidence === "low") {
    return {
      shortLabel: "Exhale Ratio" as const,
      value: "—",
      tone: "warning" as PillarTone,
      subtext: quality === "Noisy" ? "Noisy capture." : "Low confidence.",
      ratio: Number(ratio.toFixed(3)),
      uncertain: true,
      adherence,
      confidence
    };
  }

  const tone: PillarTone = onTarget ? "good" : adherence === "Exhale short" ? "warning" : "poor";

  return {
    shortLabel: "Exhale Ratio" as const,
    value: `${ratio.toFixed(2)}x`,
    tone,
    subtext: adherence,
    ratio: Number(ratio.toFixed(3)),
    uncertain: false,
    adherence,
    confidence
  };
}

function buildInterruptionsPillar(input: {
  preprocessing?: BreathPreprocessSummary | null;
  irregularWindows: AnalysisWindow[];
  segments: AnalysisSegment[];
  energy: number[];
  duration: number;
}) {
  const preprocessQuality = input.preprocessing?.quality;
  if (input.preprocessing) {
    const candidates = (input.preprocessing.interruptions ?? [])
      .slice()
      .sort((left, right) => left.tStart - right.tStart);

    const confidence: PillarConfidence =
      preprocessQuality === "Noisy" ? "low" : preprocessQuality === "Fair" ? "med" : "high";
    const lowConfidence = confidence !== "high";
    const markerThreshold = confidence === "low" ? 0.22 : confidence === "med" ? 0.32 : 0.44;
    const countThreshold = confidence === "low" ? 0.26 : confidence === "med" ? 0.38 : 0.5;
    let counted = candidates.filter((item) => item.confidence >= countThreshold);
    if (!counted.length && candidates.length) {
      counted = candidates.filter((item) => item.confidence >= markerThreshold);
    }
    const markerEvents = counted.length
      ? counted
      : candidates.filter((item) => item.confidence >= markerThreshold);

    const count = counted.length;
    const quality: InterruptionsPillar["quality"] =
      preprocessQuality === "Noisy" ? "Noisy" : count <= 1 ? "Good" : count <= 3 ? "Fair" : "Poor";
    const tone: PillarTone = quality === "Poor" ? "poor" : quality === "Good" ? "good" : "warning";
    const subtext = lowConfidence ? "Low confidence." : `${quality} capture quality.`;

    return {
      shortLabel: "Interruptions" as const,
      value: String(count),
      tone,
      subtext,
      count,
      quality,
      timestamps: counted.map((item) => formatTimeLabel((item.tStart + item.tEnd) * 0.5)),
      seconds: counted.map((item) => Number(((item.tStart + item.tEnd) * 0.5).toFixed(3))),
      markerSeconds: markerEvents.map((item) => Number(((item.tStart + item.tEnd) * 0.5).toFixed(3))),
      lowConfidence,
      confidence
    };
  }

  // Fallback only when preprocess data is missing.
  const times = new Set<number>();
  input.irregularWindows.forEach((window) => {
    times.add(Number(window.start.toFixed(3)));
  });
  input.segments.forEach((segment) => {
    const normalized = normalizeSegmentLabel(segment.label);
    const isExpected = normalized.includes("inhale") || normalized.includes("exhale") || normalized.includes("hold");
    if (!isExpected) {
      times.add(Number(segment.start.toFixed(3)));
    }
  });
  detectEnergySpikes(input.energy, input.duration).forEach((time) => {
    times.add(time);
  });

  const deduped = Array.from(times).sort((a, b) => a - b);
  const count = deduped.length;
  const quality: "Good" | "Fair" | "Poor" = count <= 1 ? "Good" : count <= 3 ? "Fair" : "Poor";
  const tone: PillarTone = quality === "Good" ? "good" : quality === "Fair" ? "warning" : "poor";

  const fallbackConfidence: PillarConfidence = preprocessQuality === "Noisy" ? "low" : "med";

  return {
    shortLabel: "Interruptions" as const,
    value: String(count),
    tone,
    subtext: `${quality} capture quality.`,
    count,
    quality,
    timestamps: deduped.map((time) => formatTimeLabel(time)),
    seconds: deduped,
    markerSeconds: deduped,
    lowConfidence: true,
    confidence: fallbackConfidence
  };
}

function buildHoldPillar(input: {
  preprocessing?: BreathPreprocessSummary | null;
  phaseStats: ReturnType<typeof computePhaseStats>;
}): HoldDetectedPillar {
  const quality = input.preprocessing?.quality;
  const inhale = input.phaseStats.inhale;
  const hold = input.phaseStats.hold;
  const exhale = input.phaseStats.exhale;

  const hasWindowData =
    inhale.sampleCount > 0 &&
    hold.sampleCount > 0 &&
    exhale.sampleCount > 0 &&
    Math.min(inhale.totalDuration, hold.totalDuration, exhale.totalDuration) > 0;

  const inhaleEnergy = inhale.medianRms;
  const exhaleEnergy = exhale.medianRms;
  const holdEnergy = hold.medianRms;
  const holdVar = hold.varianceRms;
  const inhaleVar = Math.max(inhale.varianceRms, 1e-7);

  const noisyByFloor =
    !!input.preprocessing &&
    input.preprocessing.noiseFloor > Math.max(input.preprocessing.breathMean * 0.55, 0.02);
  const noisy = quality === "Noisy" || noisyByFloor;

  const energyFactor = noisy ? 0.65 : quality === "Fair" ? 0.6 : 0.55;
  const varianceFactor = noisy ? 0.45 : quality === "Fair" ? 0.55 : 0.6;

  const referenceEnergy = Math.max(1e-7, Math.min(inhaleEnergy, exhaleEnergy));
  const energyThreshold = referenceEnergy * energyFactor;
  const varianceThreshold = inhaleVar * varianceFactor;

  const detected =
    hasWindowData &&
    hold.sampleCount >= 8 &&
    holdEnergy < energyThreshold &&
    holdVar < varianceThreshold;

  const quietDuration = Math.max(0, hold.totalDuration - hold.activeDuration);
  const markerTime = hold.totalDuration > 0 ? (hold.start + hold.end) * 0.5 : 6.5;

  const uncertain =
    !hasWindowData ||
    hold.sampleCount < 8 ||
    referenceEnergy <= 1e-7 ||
    noisy ||
    (quality === "Fair" && !detected && holdEnergy < energyThreshold * 1.15);

  let value: HoldDetectedPillar["value"] = detected ? "Yes" : "No";
  let tone: PillarTone = detected ? "good" : "warning";
  let confidence: PillarConfidence = "high";
  let subtext = detected ? `Plateau ~${quietDuration.toFixed(1)}s.` : "No clear plateau.";

  if (uncertain) {
    value = "Unclear";
    tone = "warning";
    confidence = "low";
    subtext = "Unclear (noisy capture).";
  } else if (quality === "Fair") {
    confidence = "med";
  }

  return {
    shortLabel: "Hold",
    value,
    tone,
    subtext,
    enabled: true,
    detected: value === "Unclear" ? null : detected,
    durationSeconds: Number(quietDuration.toFixed(3)),
    markerTime: Number(markerTime.toFixed(3)),
    confidence
  };
}

function buildPillarMarkers(input: {
  inhaleSegments: AnalysisSegment[];
  exhaleSegments: AnalysisSegment[];
  holdPillar: HoldDetectedPillar;
  interruptionMarkerTimes: number[];
  providedMarkers: Array<{ time: number; label: string }>;
  duration: number;
}) {
  const markers: AnalysisMarker[] = [];

  const inhaleStarts = input.inhaleSegments.map((segment) => segment.start).slice(0, 8);
  inhaleStarts.forEach((time, index) => {
    markers.push({
      id: `rhythm-${index + 1}`,
      time: Number(clamp(time, 0, Math.max(input.duration, 0)).toFixed(3)),
      label: `R${index + 1}`,
      type: "rhythm",
      detail: "Cycle boundary"
    });
  });

  input.inhaleSegments.slice(0, 6).forEach((segment, index) => {
    markers.push({
      id: `segment-in-${index + 1}`,
      time: segment.start,
      label: "In",
      type: "segment",
      detail: "Inhale segment"
    });
  });

  input.exhaleSegments.slice(0, 6).forEach((segment, index) => {
    markers.push({
      id: `segment-ex-${index + 1}`,
      time: segment.start,
      label: "Ex",
      type: "segment",
      detail: "Exhale segment"
    });
  });

  input.interruptionMarkerTimes.slice(0, 8).forEach((time, index) => {
    markers.push({
      id: `interrupt-${index + 1}`,
      time: Number(clamp(time, 0, Math.max(input.duration, 0)).toFixed(3)),
      label: `I${index + 1}`,
      type: "interruption",
      detail: "Interruption marker"
    });
  });

  if (input.holdPillar.enabled && typeof input.holdPillar.markerTime === "number") {
    markers.push({
      id: "hold-window",
      time: Number(clamp(input.holdPillar.markerTime, 0, Math.max(input.duration, 0)).toFixed(3)),
      label: "H",
      type: "hold",
      detail: input.holdPillar.detected
        ? `Hold window (~${(input.holdPillar.durationSeconds ?? 0).toFixed(1)}s)`
        : "Hold window not detected"
    });
  }

  if (!markers.length) {
    input.providedMarkers.slice(0, 8).forEach((marker, index) => {
      const normalized = normalizeSegmentLabel(marker.label);
      const type: AnalysisMarkerType = normalized.includes("hold")
        ? "hold"
        : normalized.includes("inhale") || normalized.includes("exhale")
          ? "segment"
          : "event";
      markers.push({
        id: `marker-fallback-${index + 1}`,
        time: Number(clamp(marker.time, 0, Math.max(input.duration, 0)).toFixed(3)),
        label: marker.label.slice(0, 8) || `M${index + 1}`,
        type,
        detail: marker.label
      });
    });
  }

  markers.sort((left, right) => left.time - right.time);

  return markers.filter((marker, index, list) => {
    const previous = list[index - 1];
    if (!previous) return true;
    const sameTime = Math.abs(previous.time - marker.time) <= 0.06;
    const sameType = previous.type === marker.type;
    const sameLabel = previous.label === marker.label;
    return !(sameTime && sameType && sameLabel);
  });
}

function buildEventDensity(input: {
  duration: number;
  markers: AnalysisMarker[];
  segments: AnalysisSegment[];
  irregularWindows: AnalysisWindow[];
  bins?: number;
}) {
  const bins = input.bins ?? 24;
  if (!input.duration || input.duration <= 0) return Array.from({ length: bins }, () => 0);

  const density = Array.from({ length: bins }, () => 0);

  const add = (time: number, weight: number) => {
    const clamped = clamp(time, 0, input.duration);
    const index = Math.min(bins - 1, Math.floor((clamped / input.duration) * bins));
    density[index] += weight;
  };

  input.markers.forEach((marker) => {
    const weight = marker.type === "interruption" || marker.type === "irregular" ? 1.7 : marker.type === "rhythm" ? 0.6 : 0.9;
    add(marker.time, weight);
  });
  input.segments.forEach((segment) => add(segment.start, 0.55));
  input.irregularWindows.forEach((window) => add(window.start, 1.7));

  const max = density.reduce((peak, value) => Math.max(peak, value), 0);
  if (max <= 0) return density;

  return density.map((value) => Number((value / max).toFixed(4)));
}

function averageEnvelope(history: AnalysisHistoryEntry[], targetLength: number) {
  if (!history.length || targetLength <= 0) return null;

  const sourceEnvelopes = history
    .map((entry) => downsample(entry.envelope, targetLength))
    .filter((envelope) => envelope.length === targetLength);

  if (!sourceEnvelopes.length) return null;

  const baseline = Array.from({ length: targetLength }, (_, index) => {
    const avg = mean(sourceEnvelopes.map((envelope) => envelope[index] ?? 0));
    return Number(clamp(avg, 0, 1).toFixed(4));
  });

  return baseline;
}

function nextWeekLabel(createdAtIso: string) {
  const next = new Date(createdAtIso);
  next.setDate(next.getDate() + 7);

  return next.toLocaleString("en-CA", {
    weekday: "short",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

export function buildSessionAnalysisBundle(input: BuildBundleInput): SessionAnalysis {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const duration = Math.max(0, input.waveform.duration || 0);
  const envelope = downsample(input.waveform.envelope, 240);
  const energy = downsample(input.waveform.energy, 240);

  const segmentation = isObject(input.results.segmentation) ? input.results.segmentation : {};
  const baseline = isObject(input.results.baselineTrend) ? input.results.baselineTrend : {};
  const clinical = isObject(input.results.clinicalSummary) ? input.results.clinicalSummary : {};
  const coaching = isObject(input.results.coaching) ? input.results.coaching : {};
  const followUp = isObject(input.results.followUp) ? input.results.followUp : {};

  const segments = parseSegments(segmentation.segments, duration);
  const irregularWindows = parseIrregularWindows(segmentation.irregularWindows, duration);
  const phaseStats = computePhaseStats(input.preprocessing, duration);

  const inhaleSegments = segments.filter((segment) => isInhaleLabel(segment.label));
  const exhaleSegments = segments.filter((segment) => isExhaleLabel(segment.label));

  const rhythm = buildRhythmPillar({
    preprocessing: input.preprocessing,
    phaseStats,
    energy,
  });
  const exhaleRatio = buildExhaleRatioPillar({
    preprocessing: input.preprocessing,
    phaseStats
  });
  const interruptions = buildInterruptionsPillar({
    preprocessing: input.preprocessing,
    irregularWindows,
    segments,
    energy,
    duration
  });
  const holdDetected = buildHoldPillar({
    preprocessing: input.preprocessing,
    phaseStats
  });

  const markers = buildPillarMarkers({
    inhaleSegments,
    exhaleSegments,
    holdPillar: holdDetected,
    interruptionMarkerTimes: interruptions.markerSeconds,
    providedMarkers: input.markers,
    duration
  });

  const rhythmScore = rhythm.value === "Stable" ? 0.92 : rhythm.value === "Slightly Variable" ? 0.68 : 0.36;
  const guidedRatio = 1.4;
  const exhaleScore =
    exhaleRatio.ratio === null ? 0.45 : clamp(1 - Math.abs(exhaleRatio.ratio - guidedRatio) / guidedRatio, 0, 1);
  const interruptionPenalty = interruptions.count * 4.5;

  const score = clamp(Math.round(54 + rhythmScore * 34 + exhaleScore * 10 - interruptionPenalty), 0, 100);

  const historyScoreAvg = input.history.length ? mean(input.history.map((entry) => entry.score)) : score;
  const fallbackDelta = `${score >= historyScoreAvg ? "+" : ""}${(score - historyScoreAvg).toFixed(1)} vs baseline`;
  const deltaLabel = safeString(baseline.baselineDelta, fallbackDelta);

  let confidenceLabel = parseConfidence(baseline.confidence, input.history.length + 1);
  if (rhythm.confidence === "low") {
    confidenceLabel = downgradeConfidence(confidenceLabel, 1);
  }
  if (exhaleRatio.uncertain || exhaleRatio.confidence === "low") {
    confidenceLabel = downgradeConfidence(confidenceLabel, 1);
  }
  if (rhythm.cycleCount < 2 || rhythm.confidence === "med") {
    confidenceLabel = downgradeConfidence(confidenceLabel, 1);
  }
  if (interruptions.quality === "Noisy") {
    confidenceLabel = "low";
  } else if (interruptions.lowConfidence || interruptions.confidence === "med") {
    confidenceLabel = downgradeConfidence(confidenceLabel, 1);
  }
  if (holdDetected.value === "Unclear" || holdDetected.confidence === "low") {
    confidenceLabel = downgradeConfidence(confidenceLabel, 1);
  }

  const patternBullets = [
    `Rhythm: ${rhythm.value}`,
    `Exhale ratio: ${exhaleRatio.value}${exhaleRatio.adherence !== "Unknown" ? ` (${exhaleRatio.adherence.toLowerCase()})` : ""}`,
    interruptions.lowConfidence
      ? `Interruptions: ${interruptions.count} (low confidence)`
      : `Interruptions: ${interruptions.count} (quality: ${interruptions.quality.toLowerCase()})`
  ].slice(0, 3);

  const patternSummary = patternBullets.join(" | ");
  const explainabilitySummary = "Markers map to rhythm, inhale/exhale, interruptions, and hold.";

  const clinicianSummary = `Rhythm ${rhythm.value} | Exhale ${exhaleRatio.value} | Interruptions ${interruptions.count}${
    interruptions.lowConfidence ? " (low conf)" : ""
  } | Hold ${holdDetected.value}`;

  const coachingTip = safeString(coaching.microIntervention, "Keep the same posture and pace for the next check.");
  const followUpPrompt = safeString(followUp.nextWeekPrompt, "Repeat this 15s capture next week at a similar time.");

  const interruptionTimestampText = interruptions.timestamps.length ? interruptions.timestamps.join(", ") : "none";
  const holdDurationText = holdDetected.enabled
    ? holdDetected.durationSeconds !== null
      ? `${holdDetected.durationSeconds.toFixed(1)}s`
      : "n/a"
    : "n/a";

  const reportLines = [
    "RespiraSnap Breathing Snapshot (15s) - Indicator Only",
    `Rhythm consistency: ${rhythm.value}`,
    `Exhale ratio (Exhale ÷ Inhale): ${exhaleRatio.value}`,
    `Interruptions: ${interruptions.count} (timestamps: ${
      interruptions.timestamps.length ? interruptionTimestampText : "none"
    }${interruptions.lowConfidence ? "; low confidence" : ""})`,
    `Hold detected: ${holdDetected.value} (hold duration approx: ${holdDurationText})`,
    `Confidence: ${formatConfidence(confidenceLabel)} (based on number of sessions)`,
    "Note: Not a diagnosis. Share as context with a clinician if concerned."
  ];
  const reportText = reportLines.join("\n");

  const keyMomentTime =
    interruptions.markerSeconds[0] ??
    (holdDetected.enabled && typeof holdDetected.markerTime === "number" ? holdDetected.markerTime : undefined) ??
    markers[0]?.time ??
    clamp(duration * 0.32, 0, Math.max(0, duration));

  const baselineEnvelope = averageEnvelope(input.history, envelope.length);

  const eventDensity = buildEventDensity({
    duration,
    markers,
    segments,
    irregularWindows
  });

  return {
    createdAt,
    mode: input.mode,
    score,
    deltaLabel,
    confidenceLabel,
    patternSummary,
    patternBullets,
    explainabilitySummary,
    clinicianSummary,
    coachingTip,
    followUpPrompt,
    reportText,
    reportLines,
    nextCheckInLabel: nextWeekLabel(createdAt),
    keyMomentTime,
    pillars: {
      rhythm,
      exhaleRatio,
      interruptions,
      holdDetected
    },
    phaseStats: {
      inhale: phaseStats.inhale,
      hold: phaseStats.hold,
      exhale: phaseStats.exhale
    },
    preprocessDebug: input.preprocessing?.debug ?? null,
    waveform: {
      envelope,
      energy,
      duration
    },
    baselineEnvelope,
    eventDensity,
    markers,
    segments,
    irregularWindows,
    sourceResults: input.results
  };
}

export function appendAnalysisHistory(
  history: AnalysisHistoryEntry[],
  analysis: SessionAnalysis,
  maxEntries = 12
): AnalysisHistoryEntry[] {
  const entry: AnalysisHistoryEntry = {
    createdAt: analysis.createdAt,
    score: analysis.score,
    envelope: downsample(analysis.waveform.envelope, 120),
    duration: analysis.waveform.duration
  };

  const deduped = history.filter((item) => item.createdAt !== entry.createdAt);
  const next = [...deduped, entry];

  return next.slice(-maxEntries);
}
