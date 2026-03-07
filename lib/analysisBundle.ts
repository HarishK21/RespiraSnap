export type AnalysisMarker = {
  id: string;
  time: number;
  label: string;
  type?: "event" | "irregular";
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

export type SessionAnalysis = {
  createdAt: string;
  mode: string;
  score: number;
  deltaLabel: string;
  confidenceLabel: "low" | "med" | "high";
  patternSummary: string;
  explainabilitySummary: string;
  clinicianSummary: string;
  coachingTip: string;
  followUpPrompt: string;
  reportText: string;
  nextCheckInLabel: string;
  keyMomentTime: number;
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

  return parsed;
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

  return parsed;
}

function buildMarkers(input: {
  providedMarkers: Array<{ time: number; label: string }>;
  irregularWindows: AnalysisWindow[];
  duration: number;
}): AnalysisMarker[] {
  const normalized: AnalysisMarker[] = input.providedMarkers.map((marker, index) => ({
    id: `marker-${index}-${marker.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    time: Number(clamp(marker.time, 0, Math.max(input.duration, 0)).toFixed(3)),
    label: marker.label,
    type: "event"
  }));

  input.irregularWindows.forEach((window, index) => {
    normalized.push({
      id: `irregular-${index}`,
      time: window.start,
      label: `Irregular ${index + 1}`,
      type: "irregular"
    });
  });

  normalized.sort((left, right) => left.time - right.time);

  return normalized.filter((marker, index, list) => {
    const previous = list[index - 1];
    if (!previous) return true;
    return Math.abs(previous.time - marker.time) > 0.05 || previous.label !== marker.label;
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

  input.markers.forEach((marker) => add(marker.time, marker.type === "irregular" ? 1.4 : 0.9));
  input.segments.forEach((segment) => add(segment.start, 0.7));
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

  const markers = buildMarkers({
    providedMarkers: input.markers,
    irregularWindows,
    duration
  });

  const energyAvg = mean(energy);
  const energyVar = variance(energy);
  const rhythmStability = clamp(1 - energyVar * 8.2, 0, 1);

  const score = clamp(
    Math.round(60 + rhythmStability * 24 + energyAvg * 14 - irregularWindows.length * 6),
    0,
    100
  );

  const historyScoreAvg = input.history.length
    ? mean(input.history.map((entry) => entry.score))
    : score;

  const fallbackDelta = `${score >= historyScoreAvg ? "+" : ""}${(score - historyScoreAvg).toFixed(1)} vs baseline`;
  const deltaLabel = safeString(baseline.baselineDelta, fallbackDelta);
  const confidenceLabel = parseConfidence(baseline.confidence, input.history.length + 1);

  const patternSummary = [
    safeString(segmentation.notes),
    safeString(baseline.trendNote)
  ]
    .filter(Boolean)
    .slice(0, 2)
    .join(" ") ||
    "Breathing cadence appears mostly stable with small timing variability in this snapshot.";

  const explainabilitySummary =
    `Markers highlight ${markers.length} salient points and ${irregularWindows.length} irregular window${
      irregularWindows.length === 1 ? "" : "s"
    } across the capture timeline.`;

  const clinicalSummary = [
    safeString(clinical.summary),
    safeString(clinical.nonDiagnosticNote)
  ]
    .filter(Boolean)
    .join(" ") ||
    "Observed breathing timing and envelope are summarized for trend tracking only and are not diagnostic.";

  const coachingTip = [
    safeString(coaching.microIntervention),
    safeString(coaching.nextRecordingTip)
  ]
    .filter(Boolean)
    .join(" ") ||
    "Keep shoulders relaxed and maintain consistent distance from the camera for the next capture.";

  const followUpPrompt =
    safeString(followUp.nextWeekPrompt) ||
    "Next week, repeat the same 15-second breathing snapshot under similar lighting and posture.";

  const keyMomentTime =
    irregularWindows[0]?.start ?? markers[0]?.time ?? clamp(duration * 0.32, 0, Math.max(0, duration));

  const baselineEnvelope = averageEnvelope(input.history, envelope.length);

  const eventDensity = buildEventDensity({
    duration,
    markers,
    segments,
    irregularWindows
  });

  const reportText = [
    `RespiraSnap Breathing Snapshot Report`,
    `Captured: ${new Date(createdAt).toLocaleString("en-CA")}`,
    `Score: ${score}/100 (${deltaLabel}, confidence ${confidenceLabel})`,
    "",
    `Pattern Summary: ${patternSummary}`,
    `Explainability: ${explainabilitySummary}`,
    `Clinician Summary: ${clinicalSummary}`,
    `Coaching: ${coachingTip}`,
    `Follow-up: ${followUpPrompt}`,
    "",
    `Non-diagnostic note: Indicator only, not a diagnosis.`
  ].join("\n");

  return {
    createdAt,
    mode: input.mode,
    score,
    deltaLabel,
    confidenceLabel,
    patternSummary,
    explainabilitySummary,
    clinicianSummary: clinicalSummary,
    coachingTip,
    followUpPrompt,
    reportText,
    nextCheckInLabel: nextWeekLabel(createdAt),
    keyMomentTime,
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
