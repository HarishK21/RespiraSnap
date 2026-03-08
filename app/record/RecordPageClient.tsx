"use client";

import Waveform, { type WaveformMarker } from "@/components/audio/Waveform";
import AppShell from "@/components/layout/AppShell";
import { fadeIn, fadeUp, hoverGlow, staggerChildren } from "@/components/motion/presets";
import { Divider, GlassCard, GlowButton, HintText, Pill, SectionTitle } from "@/components/ui/primitives";
import { useBackboardIdentity } from "@/hooks/useBackboardIdentity";
import { useDemoMode } from "@/hooks/useDemoMode";
import { useDemoScript } from "@/hooks/useDemoScript";
import { useReducedMotionPref } from "@/hooks/useReducedMotionPref";
import { useSessionAnalysis } from "@/hooks/useSessionAnalysis";
import { useSessionVideo } from "@/hooks/useSessionVideo";
import { appendAnalysisHistory, buildSessionAnalysisBundle } from "@/lib/analysisBundle";
import { extractAudioFeatureTimeline, type AudioFeatureTimeline } from "@/lib/audioFeatures";
import { clearCurrentSession } from "@/lib/currentSession";
import { archiveVideoBlob } from "@/lib/videoArchive";
import { AnimatePresence, motion, type Variants } from "framer-motion";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import styles from "./page.module.css";

const CAPTURE_SECONDS = 15;
const UPLOAD_ACCEPT = ".mp3,.wav,.m4a,.aac,.webm,.ogg,audio/mpeg,audio/wav,audio/mp4,audio/webm,audio/ogg,audio/aac";

const ACCEPTED_MIME_TYPES = new Set([
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/aac",
  "audio/x-m4a",
  "audio/webm",
  "audio/ogg"
]);
const ACCEPTED_EXTENSIONS = [".mp3", ".wav", ".m4a", ".aac", ".webm", ".ogg"];

type RecordPageClientProps = {
  mode: string;
};

type InputMode = "record" | "upload" | null;
type PermissionState = "idle" | "granted" | "denied" | "unsupported";
type RecorderStopReason = "complete" | "cancel";
type AgentStatus = "queued" | "running" | "done" | "error";
type AgentKey = "segmentation" | "baselineTrend" | "clinicalSummary" | "coaching" | "followUp";
type ProgressStepKey = "signal" | "segmentation" | "baselineTrend" | "clinicalSummary" | "coaching";
type ProgressStepStatus = "queued" | "running" | "done";
type AnalysisStatus = "idle" | "ready" | "running" | "complete" | "error";

type BreathingCue = {
  atMs: number;
  text: string;
};

type AgentState = {
  key: AgentKey;
  title: string;
  modelLabel: "A" | "B" | "C" | "D";
  status: AgentStatus;
  summary: string;
  message?: string;
};

type AnalyzeEvent =
  | {
      type: "init";
      assistantId: string;
      threadId: string;
    }
  | {
      type: "agent";
      key: AgentKey;
      title: string;
      modelLabel: "A" | "B" | "C" | "D";
      status: AgentStatus;
      message?: string;
      output?: {
        model?: string;
        result?: unknown;
      };
    }
  | {
      type: "complete";
      assistantId: string;
      threadId: string;
      results: Record<string, unknown>;
    }
  | {
      type: "fatal";
      message: string;
    };

type ProgressStepConfig = {
  key: ProgressStepKey;
  label: string;
};

const BREATHING_CUES: BreathingCue[] = [
  { atMs: 0, text: "Inhale..." },
  { atMs: 5000, text: "Hold..." },
  { atMs: 8000, text: "Exhale..." }
];

const AGENT_BLUEPRINT: Array<Pick<AgentState, "key" | "title" | "modelLabel">> = [
  { key: "segmentation", title: "Segmentation Agent", modelLabel: "A" },
  { key: "baselineTrend", title: "Baseline & Trend Agent", modelLabel: "B" },
  { key: "clinicalSummary", title: "Clinical Summary Agent", modelLabel: "C" },
  { key: "coaching", title: "Coaching Agent", modelLabel: "D" },
  { key: "followUp", title: "Follow-up Agent", modelLabel: "D" }
];

const PROGRESS_STEPS: ProgressStepConfig[] = [
  { key: "signal", label: "Signal" },
  { key: "segmentation", label: "Segmentation" },
  { key: "baselineTrend", label: "Baseline/Trend" },
  { key: "clinicalSummary", label: "Clinical Summary" },
  { key: "coaching", label: "Coaching" }
];

function createInitialAgentState(): AgentState[] {
  return AGENT_BLUEPRINT.map((agent) => ({
    ...agent,
    status: "queued",
    summary: "Queued"
  }));
}

function modeToLabel(mode: string) {
  if (mode === "breathing") return "Breathing Snapshot";
  return "Breathing Snapshot";
}

function formatClock(seconds: number) {
  return `00:${String(Math.max(0, seconds)).padStart(2, "0")}`;
}

function formatTimeLabel(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function canRecordInBrowser() {
  if (typeof window === "undefined") return false;
  return !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
}

function getSupportedRecorderMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
    "audio/mp4"
  ];

  if (typeof MediaRecorder === "undefined") return undefined;
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

function isAcceptableAudioFile(file: File) {
  const extension = ACCEPTED_EXTENSIONS.find((candidate) => file.name.toLowerCase().endsWith(candidate));
  return ACCEPTED_MIME_TYPES.has(file.type) || !!extension;
}

function cx(...classNames: Array<string | undefined | null | false>) {
  return classNames.filter(Boolean).join(" ");
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getAudioContextCtor() {
  if (typeof window === "undefined") return null;

  const webkitAudioContext = (
    window as Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext }
  ).webkitAudioContext;

  return window.AudioContext || webkitAudioContext || null;
}

function downsample(values: number[], targetBins: number) {
  if (!values.length || targetBins <= 0) return [];
  if (values.length <= targetBins) return values.map((value) => Number(clamp(value, 0, 1).toFixed(4)));

  const result: number[] = [];
  const size = values.length / targetBins;

  for (let index = 0; index < targetBins; index += 1) {
    const start = Math.floor(index * size);
    const end = Math.min(values.length, Math.floor((index + 1) * size));

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

function computeFeatureStats(energy: number[]) {
  if (!energy.length) {
    return {
      averageEnergy: 0,
      peakEnergy: 0,
      energyVariance: 0,
      rhythmStability: 0
    };
  }

  const averageEnergy = energy.reduce((sum, value) => sum + value, 0) / energy.length;
  const peakEnergy = energy.reduce((peak, value) => Math.max(peak, value), 0);

  const variance =
    energy.reduce((sum, value) => {
      const diff = value - averageEnergy;
      return sum + diff * diff;
    }, 0) / energy.length;

  const rhythmStability = clamp(1 - variance * 8, 0, 1);

  return {
    averageEnergy: Number(averageEnergy.toFixed(4)),
    peakEnergy: Number(peakEnergy.toFixed(4)),
    energyVariance: Number(variance.toFixed(4)),
    rhythmStability: Number(rhythmStability.toFixed(4))
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function valueAsString(value: unknown, fallback = "") {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeProgressStatus(status: AgentStatus | undefined): ProgressStepStatus {
  if (status === "running") return "running";
  if (status === "done" || status === "error") return "done";
  return "queued";
}

function parseSegmentationSnapshot(segmentation: unknown) {
  if (!isObject(segmentation)) {
    return {
      inhaleDuration: 0,
      exhaleDuration: 0,
      holdDuration: 0,
      irregularCount: null as number | null,
      notes: ""
    };
  }

  let inhaleDuration = 0;
  let exhaleDuration = 0;
  let holdDuration = 0;

  const segments = Array.isArray(segmentation.segments) ? segmentation.segments : [];
  segments.forEach((segment) => {
    if (!isObject(segment)) return;

    const start = typeof segment.start === "number" && Number.isFinite(segment.start) ? segment.start : null;
    const end = typeof segment.end === "number" && Number.isFinite(segment.end) ? segment.end : null;
    if (start === null || end === null) return;

    const duration = Math.max(0, end - start);
    const label = valueAsString(segment.label).toLowerCase();

    if (label.includes("inhale")) inhaleDuration += duration;
    if (label.includes("exhale")) exhaleDuration += duration;
    if (label.includes("hold")) holdDuration += duration;
  });

  const irregularCount = Array.isArray(segmentation.irregularWindows) ? segmentation.irregularWindows.length : 0;

  return {
    inhaleDuration,
    exhaleDuration,
    holdDuration,
    irregularCount,
    notes: valueAsString(segmentation.notes)
  };
}

function resolveRhythmPreview(
  irregularCount: number | null,
  notes: string
): "Stable" | "Slightly Variable" | "Variable" | "Computing..." {
  const normalizedNotes = notes.toLowerCase();
  if (normalizedNotes.includes("stable") || normalizedNotes.includes("regular")) {
    return "Stable";
  }
  if (normalizedNotes.includes("minor") || normalizedNotes.includes("slight")) {
    return "Slightly Variable";
  }
  if (irregularCount === null) return "Computing...";
  if (irregularCount <= 1) return "Stable";
  if (irregularCount <= 3) return "Slightly Variable";
  return "Variable";
}

function formatMiniRatio(value: number) {
  return `${value.toFixed(2)}x`;
}

function ProgressStepIcon({ stepKey }: { stepKey: ProgressStepKey }) {
  if (stepKey === "signal") {
    return (
      <svg viewBox="0 0 16 16" className={styles.progressStepIcon} aria-hidden>
        <path d="M1.5 8h2.2l1.2-3.3 2.1 6 1.7-4h2.1l1.2 1.3h2" />
      </svg>
    );
  }

  if (stepKey === "segmentation") {
    return (
      <svg viewBox="0 0 16 16" className={styles.progressStepIcon} aria-hidden>
        <path d="M2.2 3.2h3.2v9.6H2.2zM6.9 5.2h3.2v7.6H6.9zM11.6 2.4h2.2v10.4h-2.2z" />
      </svg>
    );
  }

  if (stepKey === "baselineTrend") {
    return (
      <svg viewBox="0 0 16 16" className={styles.progressStepIcon} aria-hidden>
        <path d="M2 12.5h12M3.2 10.4l3-2.3 2.2 1.4 4.3-3.8" />
      </svg>
    );
  }

  if (stepKey === "clinicalSummary") {
    return (
      <svg viewBox="0 0 16 16" className={styles.progressStepIcon} aria-hidden>
        <path d="M4 2.8h8v10.4H4zM5.4 5.6h5.2M5.4 8h5.2M5.4 10.4h3.6" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 16 16" className={styles.progressStepIcon} aria-hidden>
      <path d="M8 1.8l1.7 3.4 3.8.6-2.7 2.6.6 3.8L8 10.5 4.6 12.2l.6-3.8L2.5 5.8l3.8-.6z" />
    </svg>
  );
}

function summarizeAgentResult(value: unknown) {
  if (isObject(value)) {
    if (typeof value.baselineDelta === "string") {
      return `${value.baselineDelta} (${value.confidence ?? "n/a"})`;
    }

    if (typeof value.summary === "string") {
      return value.summary;
    }

    if (typeof value.microIntervention === "string") {
      return value.microIntervention;
    }

    if (typeof value.nextWeekPrompt === "string") {
      return value.nextWeekPrompt;
    }

    if (Array.isArray(value.segments)) {
      return `${value.segments.length} segments detected`;
    }
  }

  const raw = JSON.stringify(value);
  if (!raw) return "Done";
  return raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
}

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildDemoAgentResults() {
  return {
    segmentation: {
      segments: [
        { start: 0.1, end: 2.1, label: "inhale", confidence: 0.93 },
        { start: 2.1, end: 3.05, label: "hold", confidence: 0.9 },
        { start: 3.05, end: 4.95, label: "exhale", confidence: 0.92 },
        { start: 5.05, end: 7.02, label: "inhale", confidence: 0.94 },
        { start: 7.02, end: 8.01, label: "hold", confidence: 0.9 },
        { start: 8.01, end: 9.96, label: "exhale", confidence: 0.93 },
        { start: 10.03, end: 12.02, label: "inhale", confidence: 0.92 },
        { start: 12.02, end: 12.95, label: "hold", confidence: 0.89 },
        { start: 12.95, end: 14.86, label: "exhale", confidence: 0.91 }
      ],
      irregularWindows: [{ start: 11.45, end: 11.95, reason: "minor cadence drift during transition" }],
      segmentCount: 9,
      notes: "Cycle timing is stable with one minor transition drift late in capture."
    },
    baselineTrend: {
      baselineDelta: "+4.1 vs baseline",
      confidence: "high",
      samplesUsed: 9,
      trendNote: "Rhythm consistency improved versus recent captures, especially on exhale pacing."
    },
    clinicalSummary: {
      summary:
        "Observed respiratory cadence is predominantly regular across the 15-second interval with one brief transition irregularity and preserved amplitude control.",
      nonDiagnosticNote: "This summary is informational and non-diagnostic."
    },
    coaching: {
      microIntervention: "Lengthen exhale by one count at each cycle to reduce late-transition drift.",
      nextRecordingTip: "Keep a steady mouth-to-microphone distance to stabilize signal quality."
    },
    followUp: {
      nextWeekPrompt: "Next week, repeat this capture at the same time and compare exhale smoothness.",
      preferredSettings: {
        voiceCoachEnabled: true,
        typicalCaptureTime: "08:30",
        reducedMotion: false
      },
      continuityNote: "Preferences and trend context retained for next session."
    }
  } satisfies Record<string, unknown>;
}

export default function RecordPageClient({ mode }: RecordPageClientProps) {
  const router = useRouter();
  const modeLabel = modeToLabel(mode);

  const { reducedMotion, hasOverride, toggleReducedMotion } = useReducedMotionPref();
  const { demoMode, toggleDemoMode } = useDemoMode();
  const demoScript = useDemoScript();
  const { sessionVideo, setSessionVideo, clearSessionVideo } = useSessionVideo();
  const { sessionAnalysis, analysisHistory, sessionSnapshots, setSessionAnalysis, setAnalysisHistory, clearSessionAnalysis } =
    useSessionAnalysis();
  const { deviceId, assistantId, threadId, isReady: identityReady, setBackboardContext } = useBackboardIdentity();

  const [inputMode, setInputMode] = useState<InputMode>(sessionVideo?.source ?? null);
  const [isRecording, setIsRecording] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(CAPTURE_SECONDS);
  const [permissionState, setPermissionState] = useState<PermissionState>("idle");
  const [voiceCoachEnabled, setVoiceCoachEnabled] = useState(true);
  const [statusMessage, setStatusMessage] = useState("Choose Record or Upload to begin.");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [coachMessage, setCoachMessage] = useState<string | null>(null);
  const [analysisStatus, setAnalysisStatus] = useState<AnalysisStatus>(sessionVideo ? "ready" : "idle");
  const [analysisSource, setAnalysisSource] = useState<"live" | "demo" | null>(null);
  const [agentsExpanded, setAgentsExpanded] = useState(false);

  const [waveformData, setWaveformData] = useState<AudioFeatureTimeline | null>(null);
  const [waveformLoading, setWaveformLoading] = useState(false);
  const [waveformError, setWaveformError] = useState<string | null>(null);
  const [liveWaveform, setLiveWaveform] = useState<{ envelope: number[]; energy: number[] }>({
    envelope: [],
    energy: []
  });

  const [videoCurrentTime, setVideoCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);

  const [analysisResults, setAnalysisResults] = useState<Record<string, unknown> | null>(null);
  const [agentStates, setAgentStates] = useState<AgentState[]>(() => createInitialAgentState());
  const [agentOutputs, setAgentOutputs] = useState<Partial<Record<AgentKey, unknown>>>({});
  const [analysisQueuedSessionId, setAnalysisQueuedSessionId] = useState<number | null>(null);

  const videoRef = useRef<HTMLAudioElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const agentsSectionRef = useRef<HTMLDivElement>(null);
  const analysisRunIdRef = useRef(0);

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingStopReasonRef = useRef<RecorderStopReason>("complete");

  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoStopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cueTimeoutsRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const cueAudioRef = useRef<HTMLAudioElement | null>(null);
  const cueBlobUrlsRef = useRef<string[]>([]);

  const liveWaveRafRef = useRef<number | null>(null);
  const liveWaveContextRef = useRef<AudioContext | null>(null);
  const liveWaveSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const liveWaveAnalyserRef = useRef<AnalyserNode | null>(null);
  const liveEnvelopeRef = useRef<number[]>([]);
  const liveEnergyRef = useRef<number[]>([]);

  const isAnalysisRunning = analysisStatus === "running";
  const isAnalysisComplete = analysisStatus === "complete";
  const isAnalysisError = analysisStatus === "error";

  const flowStep =
    isAnalysisRunning || isAnalysisComplete || isAnalysisError
      ? 3
      : sessionVideo || inputMode
        ? 2
        : 1;
  const progressPercent = ((CAPTURE_SECONDS - secondsLeft) / CAPTURE_SECONDS) * 100;

  const playbackCurrentTime = isRecording ? CAPTURE_SECONDS - secondsLeft : videoCurrentTime;
  const waveformDuration = isRecording
    ? CAPTURE_SECONDS
    : Math.max(waveformData?.duration ?? 0, Number.isFinite(videoDuration) ? videoDuration : 0);

  const displayedEnvelope = isRecording ? liveWaveform.envelope : waveformData?.envelope ?? [];
  const displayedEnergy = isRecording ? liveWaveform.energy : waveformData?.energy ?? [];

  const eventMarkers = useMemo<WaveformMarker[]>(() => {
    const baseDuration = waveformDuration || CAPTURE_SECONDS;
    if (baseDuration <= 0) return [];

    return [
      {
        id: "marker-inhale",
        time: clamp(baseDuration * 0.18, 0.5, Math.max(0.5, baseDuration - 0.5)),
        label: "Inhale"
      },
      {
        id: "marker-hold",
        time: clamp(baseDuration * 0.48, 0.5, Math.max(0.5, baseDuration - 0.5)),
        label: "Hold"
      },
      {
        id: "marker-exhale",
        time: clamp(baseDuration * 0.76, 0.5, Math.max(0.5, baseDuration - 0.5)),
        label: "Exhale"
      }
    ];
  }, [waveformDuration]);

  const baselineDelta = useMemo(() => {
    const baseline = isObject(analysisResults?.baselineTrend) ? analysisResults?.baselineTrend : null;
    return valueAsString(baseline?.baselineDelta, "Baseline: pending");
  }, [analysisResults]);

  const baselineConfidence = useMemo(() => {
    const baseline = isObject(analysisResults?.baselineTrend) ? analysisResults?.baselineTrend : null;
    return valueAsString(baseline?.confidence, "n/a");
  }, [analysisResults]);

  const clinicalSummary = useMemo(() => {
    const clinical = isObject(analysisResults?.clinicalSummary) ? analysisResults?.clinicalSummary : null;
    return valueAsString(clinical?.summary);
  }, [analysisResults]);

  const coachingTip = useMemo(() => {
    const coaching = isObject(analysisResults?.coaching) ? analysisResults?.coaching : null;
    return valueAsString(coaching?.microIntervention);
  }, [analysisResults]);

  const followUpPrompt = useMemo(() => {
    const followUp = isObject(analysisResults?.followUp) ? analysisResults?.followUp : null;
    return valueAsString(followUp?.nextWeekPrompt);
  }, [analysisResults]);

  const agentProgress = useMemo(() => {
    const total = agentStates.length;
    const doneCount = agentStates.filter((agent) => agent.status === "done").length;
    const runningCount = agentStates.filter((agent) => agent.status === "running").length;
    const errorCount = agentStates.filter((agent) => agent.status === "error").length;

    return { total, doneCount, runningCount, errorCount };
  }, [agentStates]);

  const timelineSteps = useMemo(() => {
    const statusFor = (key: AgentKey) => agentStates.find((agent) => agent.key === key)?.status;
    const followUpProgress = normalizeProgressStatus(statusFor("followUp"));
    const coachingProgress =
      followUpProgress === "running" || followUpProgress === "done"
        ? followUpProgress
        : normalizeProgressStatus(statusFor("coaching"));
    const signalReady = Boolean(
      sessionVideo &&
        (waveformData ||
          waveformError ||
          displayedEnvelope.length > 0 ||
          displayedEnergy.length > 0 ||
          isAnalysisRunning ||
          analysisResults ||
          sessionAnalysis)
    );

    return PROGRESS_STEPS.map((step) => {
      if (step.key === "signal") {
        return {
          ...step,
          status: signalReady ? "done" : isAnalysisRunning ? "running" : "queued"
        } satisfies ProgressStepConfig & { status: ProgressStepStatus };
      }

      if (step.key === "coaching") {
        return {
          ...step,
          status: coachingProgress
        } satisfies ProgressStepConfig & { status: ProgressStepStatus };
      }

      return {
        ...step,
        status: normalizeProgressStatus(statusFor(step.key as AgentKey))
      } satisfies ProgressStepConfig & { status: ProgressStepStatus };
    });
  }, [
    agentStates,
    analysisResults,
    displayedEnergy.length,
    displayedEnvelope.length,
    isAnalysisRunning,
    sessionAnalysis,
    sessionVideo,
    waveformData,
    waveformError
  ]);

  const finalResultsReady = useMemo(() => {
    if (!sessionAnalysis) return false;
    if (!Number.isFinite(sessionAnalysis.score)) return false;
    if (!sessionAnalysis.reportText?.trim()) return false;
    if (!sessionAnalysis.pillars) return false;
    return true;
  }, [sessionAnalysis]);

  const progressFraction = useMemo(() => {
    if (analysisStatus === "complete") return 1;
    if (analysisStatus === "error") return clamp(agentProgress.doneCount / Math.max(1, agentProgress.total), 0, 1);
    if (analysisStatus === "ready") return 0;

    const base = agentProgress.doneCount / Math.max(1, agentProgress.total);
    if (analysisStatus === "running" && agentProgress.runningCount > 0) {
      return clamp(base + 0.45 / Math.max(1, agentProgress.total), 0, 0.98);
    }

    return clamp(base, 0, 1);
  }, [agentProgress.doneCount, agentProgress.runningCount, agentProgress.total, analysisStatus]);

  const progressLabel = useMemo(() => {
    if (analysisStatus === "running") return `Analyzing... ${agentProgress.doneCount}/${agentProgress.total}`;
    if (analysisStatus === "complete") return "Complete";
    if (analysisStatus === "error") return "Error";
    if (analysisStatus === "ready") return "Ready";
    return "Idle";
  }, [agentProgress.doneCount, agentProgress.total, analysisStatus]);

  const pipelineCompleteMessage = useMemo(() => {
    if (analysisStatus !== "complete") return null;
    if (analysisSource === "demo") return "Demo pipeline complete.";
    return "Backboard pipeline complete.";
  }, [analysisSource, analysisStatus]);

  const livePillars = useMemo(() => {
    if (sessionAnalysis?.pillars) {
      return {
        rhythm: sessionAnalysis.pillars.rhythm.value,
        exhaleRatio: sessionAnalysis.pillars.exhaleRatio.value,
        interruptions: sessionAnalysis.pillars.interruptions.value,
        hold: sessionAnalysis.pillars.holdDetected.value
      };
    }

    const preview = {
      rhythm: "Computing...",
      exhaleRatio: "Computing...",
      interruptions: "Computing...",
      hold: "Computing..."
    };

    const segmentation = isObject(agentOutputs.segmentation) ? agentOutputs.segmentation : null;
    const segmentationStatus = agentStates.find((agent) => agent.key === "segmentation")?.status;

    if (segmentation) {
      const snapshot = parseSegmentationSnapshot(segmentation);
      preview.rhythm = resolveRhythmPreview(snapshot.irregularCount, snapshot.notes);

      if (snapshot.inhaleDuration > 0 && snapshot.exhaleDuration > 0) {
        preview.exhaleRatio = formatMiniRatio(snapshot.exhaleDuration / snapshot.inhaleDuration);
      } else if (segmentationStatus === "done") {
        preview.exhaleRatio = "--";
      }

      if (snapshot.irregularCount !== null) {
        preview.interruptions = String(snapshot.irregularCount);
      } else if (segmentationStatus === "done") {
        preview.interruptions = "--";
      }

      if (snapshot.holdDuration > 0.24) {
        preview.hold = "Yes";
      } else if (segmentationStatus === "done") {
        preview.hold = "No";
      }
    }

    if (preview.rhythm === "Computing...") {
      const baseline = isObject(agentOutputs.baselineTrend) ? agentOutputs.baselineTrend : null;
      const trendNote = valueAsString(baseline?.trendNote).toLowerCase();
      if (trendNote.includes("stable") || trendNote.includes("improved")) {
        preview.rhythm = "Stable";
      }
    }

    return preview;
  }, [agentOutputs.baselineTrend, agentOutputs.segmentation, agentStates, sessionAnalysis?.pillars]);

  const livePillarCards = useMemo(
    () => [
      { key: "rhythm", label: "Rhythm", value: livePillars.rhythm },
      { key: "exhaleRatio", label: "Exhale Ratio", value: livePillars.exhaleRatio },
      { key: "interruptions", label: "Interruptions", value: livePillars.interruptions },
      { key: "hold", label: "Hold", value: livePillars.hold }
    ],
    [livePillars.exhaleRatio, livePillars.hold, livePillars.interruptions, livePillars.rhythm]
  );

  const stepTransition: Variants = useMemo(() => {
    if (reducedMotion) {
      return {
        hidden: { opacity: 0 },
        visible: { opacity: 1, transition: { duration: 0.16 } },
        exit: { opacity: 0, transition: { duration: 0.12 } }
      };
    }

    return {
      hidden: { opacity: 0, y: 14 },
      visible: {
        opacity: 1,
        y: 0,
        transition: {
          duration: 0.48,
          ease: [0.22, 1, 0.36, 1]
        }
      },
      exit: {
        opacity: 0,
        y: -8,
        transition: {
          duration: 0.2,
          ease: [0.4, 0, 1, 1]
        }
      }
    };
  }, [reducedMotion]);

  const updateAgentState = useCallback(
    (
      key: AgentKey,
      patch: Partial<Omit<AgentState, "key" | "title" | "modelLabel">> & { status: AgentStatus }
    ) => {
      setAgentStates((previous) =>
        previous.map((agent) => {
          if (agent.key !== key) return agent;
          return {
            ...agent,
            ...patch,
            summary:
              patch.summary ??
              (patch.status === "queued"
                ? "Queued"
                : patch.status === "running"
                  ? "Running"
                  : patch.status === "error"
                    ? "Error"
                    : agent.summary)
          };
        })
      );
    },
    []
  );

  const isRunCurrent = useCallback((runId: number) => analysisRunIdRef.current === runId, []);

  const beginAnalysisRun = useCallback(
    (source: "live" | "demo") => {
      const runId = analysisRunIdRef.current + 1;
      analysisRunIdRef.current = runId;

      setAgentsExpanded(true);
      setAnalysisStatus("running");
      setAnalysisSource(source);
      setAnalysisResults(null);
      setSessionAnalysis(null);
      setErrorMessage(null);
      setAgentStates(createInitialAgentState());
      setAgentOutputs({});

      return runId;
    },
    [setSessionAnalysis]
  );

  const stopMediaTracks = useCallback(() => {
    const stream = mediaStreamRef.current;
    if (!stream) return;

    stream.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
  }, []);

  const stopLiveWaveform = useCallback(() => {
    if (liveWaveRafRef.current) {
      cancelAnimationFrame(liveWaveRafRef.current);
      liveWaveRafRef.current = null;
    }

    if (liveWaveSourceRef.current) {
      liveWaveSourceRef.current.disconnect();
      liveWaveSourceRef.current = null;
    }

    if (liveWaveAnalyserRef.current) {
      liveWaveAnalyserRef.current.disconnect();
      liveWaveAnalyserRef.current = null;
    }

    if (liveWaveContextRef.current) {
      void liveWaveContextRef.current.close();
      liveWaveContextRef.current = null;
    }
  }, []);

  const startLiveWaveform = useCallback(
    (stream: MediaStream) => {
      const AudioContextCtor = getAudioContextCtor();
      if (!AudioContextCtor) return;

      stopLiveWaveform();

      const context = new AudioContextCtor();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();

      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.82;

      source.connect(analyser);

      liveWaveContextRef.current = context;
      liveWaveSourceRef.current = source;
      liveWaveAnalyserRef.current = analyser;
      liveEnvelopeRef.current = [];
      liveEnergyRef.current = [];
      setLiveWaveform({ envelope: [], energy: [] });

      const sampleArray = new Uint8Array(analyser.fftSize);
      let lastCommit = 0;

      const tick = (timestamp: number) => {
        if (!liveWaveAnalyserRef.current) return;

        liveWaveAnalyserRef.current.getByteTimeDomainData(sampleArray);

        let sumAbs = 0;
        let sumSquares = 0;
        for (let i = 0; i < sampleArray.length; i += 1) {
          const normalized = (sampleArray[i] - 128) / 128;
          sumAbs += Math.abs(normalized);
          sumSquares += normalized * normalized;
        }

        const meanAbs = sumAbs / sampleArray.length;
        const rms = Math.sqrt(sumSquares / sampleArray.length);

        liveEnvelopeRef.current.push(meanAbs);
        liveEnergyRef.current.push(rms);

        if (liveEnvelopeRef.current.length > 280) {
          liveEnvelopeRef.current.shift();
        }
        if (liveEnergyRef.current.length > 280) {
          liveEnergyRef.current.shift();
        }

        if (timestamp - lastCommit > 70) {
          const envelopePeak = Math.max(...liveEnvelopeRef.current, 0.0001);
          const energyPeak = Math.max(...liveEnergyRef.current, 0.0001);

          setLiveWaveform({
            envelope: liveEnvelopeRef.current.map((value) => value / envelopePeak),
            energy: liveEnergyRef.current.map((value) => value / energyPeak)
          });

          lastCommit = timestamp;
        }

        liveWaveRafRef.current = requestAnimationFrame(tick);
      };

      liveWaveRafRef.current = requestAnimationFrame(tick);
    },
    [stopLiveWaveform]
  );

  const clearRecordingTimers = useCallback(() => {
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }

    if (autoStopTimeoutRef.current) {
      clearTimeout(autoStopTimeoutRef.current);
      autoStopTimeoutRef.current = null;
    }
  }, []);

  const stopVoiceCoach = useCallback(() => {
    cueTimeoutsRef.current.forEach((timeoutId) => clearTimeout(timeoutId));
    cueTimeoutsRef.current = [];

    if (cueAudioRef.current) {
      cueAudioRef.current.pause();
      cueAudioRef.current.currentTime = 0;
      cueAudioRef.current = null;
    }

    cueBlobUrlsRef.current.forEach((url) => {
      URL.revokeObjectURL(url);
    });
    cueBlobUrlsRef.current = [];
  }, []);

  const playVoiceCue = useCallback(async (text: string) => {
    try {
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({ text })
      });

      if (!response.ok) {
        let detail = "Voice coach unavailable.";

        try {
          const payload = (await response.json()) as { error?: string };
          if (payload.error) detail = payload.error;
        } catch {
          // Keep fallback.
        }

        setCoachMessage(detail);
        return;
      }

      const audioBlob = await response.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      cueBlobUrlsRef.current.push(audioUrl);

      if (cueAudioRef.current) {
        cueAudioRef.current.pause();
        cueAudioRef.current.currentTime = 0;
      }

      const audio = new Audio(audioUrl);
      audio.volume = 0.92;
      cueAudioRef.current = audio;
      await audio.play();
    } catch {
      setCoachMessage("Voice coach failed to play; recording continues silently.");
    }
  }, []);

  const startVoiceCoach = useCallback(() => {
    if (!voiceCoachEnabled) return;

    stopVoiceCoach();
    setCoachMessage(null);

    cueTimeoutsRef.current = BREATHING_CUES.map((cue) =>
      setTimeout(() => {
        void playVoiceCue(cue.text);
      }, cue.atMs)
    );
  }, [playVoiceCue, stopVoiceCoach, voiceCoachEnabled]);

  const finalizeRecording = useCallback(
    (reason: RecorderStopReason, recorderMimeType?: string) => {
      clearRecordingTimers();
      stopVoiceCoach();
      stopLiveWaveform();
      stopMediaTracks();

      setIsRecording(false);
      setSecondsLeft(CAPTURE_SECONDS);
      mediaRecorderRef.current = null;

      if (reason === "cancel") {
        recordingChunksRef.current = [];
        setStatusMessage("Recording canceled. You can start a new 15 second capture.");
        return;
      }

      const recordedBlob = new Blob(recordingChunksRef.current, {
        type: recorderMimeType || "audio/webm"
      });

      recordingChunksRef.current = [];

      if (!recordedBlob.size) {
        setErrorMessage("Recording finished, but no audio data was captured. Please try again.");
        return;
      }

      const objectUrl = URL.createObjectURL(recordedBlob);
      const createdAt = Date.now();
      setSessionVideo({
        blob: recordedBlob,
        url: objectUrl,
        source: "record",
        createdAt
      });
      setAnalysisQueuedSessionId(createdAt);
      setAnalysisStatus("ready");
      setAnalysisSource(null);

      setStatusMessage("Recording complete. Preparing analysis...");
      setErrorMessage(null);
    },
    [clearRecordingTimers, setSessionVideo, stopLiveWaveform, stopMediaTracks, stopVoiceCoach]
  );

  const stopRecording = useCallback(
    (reason: RecorderStopReason = "complete") => {
      const recorder = mediaRecorderRef.current;
      if (!recorder) {
        finalizeRecording(reason);
        return;
      }

      recordingStopReasonRef.current = reason;
      clearRecordingTimers();
      stopVoiceCoach();
      stopLiveWaveform();

      if (recorder.state !== "inactive") {
        recorder.stop();
      } else {
        finalizeRecording(reason, recorder.mimeType);
      }
    },
    [clearRecordingTimers, finalizeRecording, stopLiveWaveform, stopVoiceCoach]
  );

  const startRecording = useCallback(async () => {
    if (!canRecordInBrowser()) {
      setPermissionState("unsupported");
      setErrorMessage("This browser does not support in-browser audio recording.");
      return;
    }

    setInputMode("record");
    setErrorMessage(null);
    setAnalysisResults(null);
    setAnalysisStatus("idle");
    setAnalysisSource(null);
    setAgentStates(createInitialAgentState());
    setAgentOutputs({});
    clearSessionAnalysis();
    setCoachMessage(null);
    setWaveformError(null);
    setWaveformData(null);
    setVideoCurrentTime(0);
    setVideoDuration(0);
    setAnalysisQueuedSessionId(null);
    setStatusMessage("Requesting microphone access...");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: { ideal: 1 },
          echoCancellation: true,
          noiseSuppression: true
        }
      });

      const mimeType = getSupportedRecorderMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);

      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      recordingChunksRef.current = [];
      recordingStopReasonRef.current = "complete";

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          recordingChunksRef.current.push(event.data);
        }
      };

      recorder.onerror = () => {
        setErrorMessage("Recording failed. Please check microphone permissions and try again.");
      };

      recorder.onstop = () => {
        finalizeRecording(recordingStopReasonRef.current, recorder.mimeType);
      };

      recorder.start(250);
      clearSessionVideo();
      startLiveWaveform(stream);

      setPermissionState("granted");
      setIsRecording(true);
      setSecondsLeft(CAPTURE_SECONDS);
      setStatusMessage("Recording live for 15 seconds...");

      countdownIntervalRef.current = setInterval(() => {
        setSecondsLeft((previous) => Math.max(previous - 1, 0));
      }, 1000);

      autoStopTimeoutRef.current = setTimeout(() => {
        stopRecording("complete");
      }, CAPTURE_SECONDS * 1000);
    } catch (error) {
      setPermissionState("denied");
      setStatusMessage("Microphone access was blocked.");
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Unable to access microphone. Update browser permissions and retry."
      );
      stopMediaTracks();
    }
  }, [clearSessionVideo, clearSessionAnalysis, finalizeRecording, startLiveWaveform, stopMediaTracks, stopRecording]);

  const triggerUploadPicker = useCallback(() => {
    setInputMode("upload");
    setErrorMessage(null);
    setStatusMessage("Select an audio file. Analysis starts automatically after waveform extraction.");
    fileInputRef.current?.click();
  }, []);

  const handleUploadSelected = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";

      if (!file) return;

      if (!isAcceptableAudioFile(file)) {
        setErrorMessage("Unsupported file format. Please choose mp3, wav, m4a, aac, webm, or ogg.");
        return;
      }

      const objectUrl = URL.createObjectURL(file);
      const createdAt = Date.now();
      setSessionVideo({
        blob: file,
        url: objectUrl,
        source: "upload",
        fileName: file.name,
        createdAt
      });
      setAnalysisQueuedSessionId(createdAt);

      setWaveformData(null);
      setWaveformError(null);
      setVideoCurrentTime(0);
      setVideoDuration(0);
      setInputMode("upload");
      setStatusMessage("Uploaded audio loaded. Preparing analysis...");
      setAnalysisResults(null);
      setAnalysisStatus("ready");
      setAnalysisSource(null);
      setAgentStates(createInitialAgentState());
      setAgentOutputs({});
      clearSessionAnalysis();
      if (demoMode) {
        demoScript.completeStep("loadSample");
      }
      setErrorMessage(null);
    },
    [clearSessionAnalysis, demoMode, demoScript, setSessionVideo]
  );

  const seekVideo = useCallback(
    (nextTime: number, context: "scrub" | "marker", markerLabel?: string) => {
      const video = videoRef.current;

      if (!sessionVideo || !video || isRecording) {
        if (context === "marker" && markerLabel) {
          setStatusMessage(`Marker selected: ${markerLabel} (${formatTimeLabel(nextTime)}).`);
        }
        return;
      }

      const maxDuration = videoDuration > 0 ? videoDuration : waveformDuration;
      const clamped = clamp(nextTime, 0, Math.max(0, maxDuration));

      video.currentTime = clamped;
      setVideoCurrentTime(clamped);

      if (context === "scrub") {
        setStatusMessage(`Scrubbed to ${formatTimeLabel(clamped)}.`);
      } else if (markerLabel) {
        if (demoMode) {
          demoScript.completeStep("markers");
        }
        setStatusMessage(`Marker: ${markerLabel} at ${formatTimeLabel(clamped)}.`);
      }
    },
    [demoMode, demoScript, isRecording, sessionVideo, videoDuration, waveformDuration]
  );

  const commitAnalysisResults = useCallback(
    (
      results: Record<string, unknown>,
      fallbackWaveform: { envelope: number[]; energy: number[]; duration: number }
    ) => {
      setAnalysisResults(results);
      const analysisBundle = buildSessionAnalysisBundle({
        mode,
        results,
        waveform: {
          envelope: waveformData?.envelope ?? fallbackWaveform.envelope,
          energy: waveformData?.energy ?? fallbackWaveform.energy,
          duration: waveformDuration || fallbackWaveform.duration || CAPTURE_SECONDS
        },
        preprocessing: waveformData?.preprocess ?? null,
        markers: eventMarkers.map((marker) => ({
          time: marker.time,
          label: marker.label
        })),
        history: analysisHistory,
        sessions: sessionSnapshots
      });
      const nextHistory = appendAnalysisHistory(analysisHistory, analysisBundle);
      setAnalysisHistory(nextHistory);
      setSessionAnalysis(analysisBundle, nextHistory);

      void fetch("/api/user/snapshots", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          analysis: analysisBundle,
          deviceId,
          source: sessionVideo?.source ?? null,
          fileName: sessionVideo?.fileName
        })
      }).catch(() => {
        // Best effort persistence (anonymous / offline sessions can fail).
      });

      if (sessionVideo?.blob) {
        void archiveVideoBlob(analysisBundle.createdAt, sessionVideo.blob).catch(() => {
          // Ignore archive failures. Timeline still uses cached summaries.
        });
      }

      if (demoMode) {
        demoScript.completeStep("analyze");
      }
      setStatusMessage("Analysis complete. Open Results to review your breathing snapshot.");
    },
    [
      analysisHistory,
      demoMode,
      demoScript,
      eventMarkers,
      mode,
      deviceId,
      sessionVideo?.blob,
      sessionVideo?.source,
      sessionVideo?.fileName,
      sessionSnapshots,
      setAnalysisHistory,
      setSessionAnalysis,
      waveformData?.energy,
      waveformData?.envelope,
      waveformData?.preprocess,
      waveformDuration
    ]
  );

  const runDemoPipeline = useCallback(
    async (fallbackWaveform: { envelope: number[]; energy: number[]; duration: number }) => {
      const stepDelay = reducedMotion ? 45 : 360;
      const results = buildDemoAgentResults();

      const runId = beginAnalysisRun("demo");
      setStatusMessage(`Analyzing... 0/${AGENT_BLUEPRINT.length}`);

      try {
        for (const agent of AGENT_BLUEPRINT) {
          if (!isRunCurrent(runId)) return;

          updateAgentState(agent.key, {
            status: "running",
            summary: "Running"
          });
          await wait(stepDelay);
          if (!isRunCurrent(runId)) return;

          const output =
            (isObject(results[agent.key]) ? (results[agent.key] as Record<string, unknown>) : { ok: true }) ?? {
              ok: true
            };

          setAgentOutputs((previous) => ({
            ...previous,
            [agent.key]: output
          }));

          updateAgentState(agent.key, {
            status: "done",
            summary: summarizeAgentResult(output)
          });
          await wait(Math.max(20, Math.floor(stepDelay / 2)));
        }
        if (!isRunCurrent(runId)) return;

        commitAnalysisResults(results, fallbackWaveform);
        setAnalysisQueuedSessionId(null);
      } catch {
        if (!isRunCurrent(runId)) return;
        setErrorMessage("Demo pipeline failed unexpectedly.");
        setAnalysisStatus("error");
        setStatusMessage("Analysis failed. Capture another sample to retry.");
      }
    },
    [beginAnalysisRun, commitAnalysisResults, isRunCurrent, reducedMotion, updateAgentState]
  );

  const runAnalysis = useCallback(async () => {
    if (!sessionVideo || isRecording || analysisStatus !== "ready" || (!identityReady && !demoMode)) return;

    const envelopeForPipeline = downsample(waveformData?.envelope ?? displayedEnvelope, 96);
    const energyForPipeline = downsample(waveformData?.energy ?? displayedEnergy, 96);
    const featureStats = computeFeatureStats(energyForPipeline);
    const recentSessions = sessionSnapshots.slice(0, 4).map((session) => ({
      createdAt: session.createdAt,
      score: session.score,
      confidence: session.confidenceLabel,
      quality: session.pillars.interruptions.quality,
      pillars: {
        rhythmLabel: session.pillars.rhythm.value,
        exhaleRatio: session.pillars.exhaleRatio.ratio,
        interruptions: session.pillars.interruptions.count,
        holdDetected: session.pillars.holdDetected.detected
      }
    }));

    if (demoMode) {
      await runDemoPipeline({
        envelope: waveformData?.envelope ?? envelopeForPipeline,
        energy: waveformData?.energy ?? energyForPipeline,
        duration: waveformDuration || CAPTURE_SECONDS
      });
      return;
    }

    const runId = beginAnalysisRun("live");
    setStatusMessage(`Analyzing... 0/${AGENT_BLUEPRINT.length}`);

    try {
      const response = await fetch("/api/backboard/analyze", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          deviceId,
          assistantId,
          threadId,
          mode,
          session: {
            source: sessionVideo.source,
            duration: waveformDuration || CAPTURE_SECONDS,
            capturedAt: new Date().toISOString()
          },
          preferences: {
            voiceCoachEnabled,
            reducedMotion,
            typicalCaptureTime: new Date().toLocaleTimeString("en-CA", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false
            })
          },
          features: {
            envelope: envelopeForPipeline,
            energy: energyForPipeline,
            stats: featureStats,
            markers: eventMarkers.map((marker) => ({
              time: marker.time,
              label: marker.label
            }))
          },
          historyContext: {
            sessions: recentSessions
          }
        })
      });

      if (!response.ok || !response.body) {
        let detail = "Backboard request failed.";
        try {
          const payload = (await response.json()) as { error?: string };
          if (payload.error) detail = payload.error;
        } catch {
          // Keep fallback detail.
        }
        throw new Error(detail);
      }
      if (!isRunCurrent(runId)) return;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let runHadError = false;

      const processEvent = (event: AnalyzeEvent) => {
        if (!isRunCurrent(runId)) return;

        if (event.type === "init") {
          setBackboardContext({ assistantId: event.assistantId, threadId: event.threadId });
          return;
        }

        if (event.type === "agent") {
          if (event.output?.result !== undefined) {
            setAgentOutputs((previous) => ({
              ...previous,
              [event.key]: event.output?.result
            }));
          }

          updateAgentState(event.key, {
            status: event.status,
            message: event.message,
            summary:
              event.status === "done"
                ? summarizeAgentResult(event.output?.result)
                : event.status === "running"
                  ? "Running"
                  : event.status === "error"
                    ? "Error"
                    : "Queued"
          });
          if (event.status === "error") {
            runHadError = true;
            setAnalysisStatus("error");
            setStatusMessage("Analysis failed. Capture another sample to retry.");
          }
          return;
        }

        if (event.type === "complete") {
          if (runHadError) {
            setAnalysisStatus("error");
            return;
          }
          setBackboardContext({ assistantId: event.assistantId, threadId: event.threadId });
          setAgentOutputs(event.results as Partial<Record<AgentKey, unknown>>);
          setAgentStates((previous) =>
            previous.map((agent) => ({
              ...agent,
              status: agent.status === "error" ? "error" : "done",
              summary: agent.status === "error" ? agent.summary : "Done"
            }))
          );
          commitAnalysisResults(
            event.results,
            {
              envelope: envelopeForPipeline,
              energy: energyForPipeline,
              duration: waveformDuration || CAPTURE_SECONDS
            }
          );
          setAnalysisQueuedSessionId(null);
          return;
        }

        if (event.type === "fatal") {
          runHadError = true;
          setErrorMessage(event.message);
          setAnalysisStatus("error");
          setStatusMessage("Analysis failed. Capture another sample to retry.");
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const chunk = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);

          const dataLine = chunk
            .split("\n")
            .map((line) => line.trim())
            .find((line) => line.startsWith("data:"));

          if (dataLine) {
            const raw = dataLine.slice(5).trim();
            if (raw) {
              try {
                processEvent(JSON.parse(raw) as AnalyzeEvent);
              } catch {
                // Ignore malformed stream chunk.
              }
            }
          }

          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (!isRunCurrent(runId)) return;
      setErrorMessage(error instanceof Error ? error.message : "Backboard analysis failed.");
      setAnalysisStatus("error");
      setStatusMessage("Analysis failed. Capture another sample to retry.");
    }
  }, [
    analysisStatus,
    assistantId,
    beginAnalysisRun,
    commitAnalysisResults,
    deviceId,
    demoMode,
    displayedEnergy,
    displayedEnvelope,
    eventMarkers,
    identityReady,
    isRecording,
    isRunCurrent,
    mode,
    reducedMotion,
    runDemoPipeline,
    sessionVideo,
    setBackboardContext,
    sessionSnapshots,
    threadId,
    updateAgentState,
    voiceCoachEnabled,
    waveformData?.energy,
    waveformData?.envelope,
    waveformDuration
  ]);

  useEffect(() => {
    if (!isRecording) return;

    if (voiceCoachEnabled) {
      startVoiceCoach();
      return;
    }

    stopVoiceCoach();
  }, [isRecording, startVoiceCoach, stopVoiceCoach, voiceCoachEnabled]);

  useEffect(() => {
    const audio = videoRef.current;
    if (!audio) return;

    if (isRecording && mediaStreamRef.current) {
      audio.srcObject = mediaStreamRef.current;
      audio.muted = true;
      audio.controls = false;
      void audio.play().catch(() => {
        setErrorMessage("Live audio monitor failed to autoplay. Tap play to continue.");
      });
      return;
    }

    audio.srcObject = null;

    if (sessionVideo?.url) {
      audio.src = sessionVideo.url;
      audio.muted = false;
      audio.controls = true;
      audio.preload = "metadata";
      return;
    }

    audio.removeAttribute("src");
    audio.load();
  }, [isRecording, sessionVideo?.url]);

  useEffect(() => {
    const audio = videoRef.current;
    if (!audio) return;

    const updateTime = () => {
      setVideoCurrentTime(Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
    };

    const updateMeta = () => {
      const nextDuration = Number.isFinite(audio.duration) ? audio.duration : 0;
      setVideoDuration(nextDuration);
    };

    audio.addEventListener("timeupdate", updateTime);
    audio.addEventListener("loadedmetadata", updateMeta);
    audio.addEventListener("durationchange", updateMeta);
    audio.addEventListener("seeking", updateTime);

    return () => {
      audio.removeEventListener("timeupdate", updateTime);
      audio.removeEventListener("loadedmetadata", updateMeta);
      audio.removeEventListener("durationchange", updateMeta);
      audio.removeEventListener("seeking", updateTime);
    };
  }, [sessionVideo?.url, isRecording]);

  useEffect(() => {
    if (!sessionVideo || isRecording) return;

    let cancelled = false;

    setWaveformLoading(true);
    setWaveformError(null);

    extractAudioFeatureTimeline(sessionVideo.blob)
      .then((result) => {
        if (cancelled) return;
        setWaveformData(result);
      })
      .catch(() => {
        if (cancelled) return;
        setWaveformData(null);
        setWaveformError("Unable to decode this audio file. Waveform unavailable.");
        if (analysisStatus === "ready") {
          setAnalysisStatus("error");
          setStatusMessage("Analysis failed. Capture another sample to retry.");
        }
      })
      .finally(() => {
        if (cancelled) return;
        setWaveformLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [analysisStatus, isRecording, sessionVideo?.createdAt, sessionVideo?.blob]);

  useEffect(() => {
    if (sessionVideo) return;
    setAnalysisStatus("idle");
    setAnalysisSource(null);
    setAnalysisQueuedSessionId(null);
  }, [sessionVideo]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const freshRequested = new URLSearchParams(window.location.search).get("fresh") === "1";
    if (!freshRequested) return;

    clearCurrentSession();
    clearSessionVideo();
    clearSessionAnalysis();
    setInputMode(null);
    setWaveformData(null);
    setWaveformLoading(false);
    setWaveformError(null);
    setLiveWaveform({ envelope: [], energy: [] });
    setAnalysisResults(null);
    setAgentStates(createInitialAgentState());
    setAgentOutputs({});
    setAnalysisQueuedSessionId(null);
    setAnalysisStatus("idle");
    setAnalysisSource(null);
    setVideoCurrentTime(0);
    setVideoDuration(0);
    setErrorMessage(null);
    setCoachMessage(null);
    setStatusMessage("Choose Record or Upload to begin.");
    router.replace("/record");
  }, [clearSessionAnalysis, clearSessionVideo, router]);

  useEffect(() => {
    const sessionId = sessionVideo?.createdAt;
    if (!sessionId) return;
    if (analysisQueuedSessionId !== sessionId) return;
    if (analysisStatus !== "ready") return;
    if (isRecording || waveformLoading) return;
    const uploadNeedsDecodedWaveform = sessionVideo?.source === "upload";
    if (uploadNeedsDecodedWaveform && (waveformError || !waveformData)) return;
    if (!waveformData && !waveformError) return;
    if (!identityReady && !demoMode) return;

    setStatusMessage("Analyzing...");
    void runAnalysis();
  }, [
    analysisStatus,
    analysisQueuedSessionId,
    demoMode,
    identityReady,
    isRecording,
    runAnalysis,
    sessionVideo?.createdAt,
    waveformData,
    waveformError,
    waveformLoading
  ]);

  useEffect(() => {
    if (analysisStatus !== "running") return;

    if (agentProgress.errorCount > 0 || !!errorMessage) {
      setAnalysisStatus("error");
      setStatusMessage("Analysis failed. Capture another sample to retry.");
      return;
    }

    const allAgentsDone = agentProgress.total > 0 && agentProgress.doneCount === agentProgress.total;
    if (allAgentsDone && finalResultsReady) {
      setAnalysisStatus("complete");
      setStatusMessage("Analysis complete. Open Results to review your breathing snapshot.");
    }
  }, [
    agentProgress.doneCount,
    agentProgress.errorCount,
    agentProgress.total,
    analysisStatus,
    errorMessage,
    finalResultsReady
  ]);

  useEffect(() => {
    if (!isAnalysisRunning) return;
    setAgentsExpanded(true);

    if (agentsSectionRef.current) {
      agentsSectionRef.current.scrollIntoView({
        behavior: reducedMotion ? "auto" : "smooth",
        block: "start"
      });
    }
  }, [isAnalysisRunning, reducedMotion]);

  useEffect(() => {
    setPermissionState(canRecordInBrowser() ? "idle" : "unsupported");
  }, []);

  useEffect(() => {
    if (!sessionVideo?.source || isRecording) return;
    setInputMode(sessionVideo.source);
  }, [isRecording, sessionVideo?.source]);

  useEffect(() => {
    return () => {
      clearRecordingTimers();
      stopVoiceCoach();
      stopLiveWaveform();
      stopMediaTracks();
    };
  }, [clearRecordingTimers, stopLiveWaveform, stopMediaTracks, stopVoiceCoach]);

  const permissionLabel = useMemo(() => {
    if (permissionState === "granted") return "Microphone: Granted";
    if (permissionState === "denied") return "Microphone: Blocked";
    if (permissionState === "unsupported") return "Microphone: Unsupported";
    return "Microphone: Pending";
  }, [permissionState]);

  const sourceLabel = useMemo(() => {
    if (sessionVideo?.source === "upload") {
      return sessionVideo.fileName ? `Source: ${sessionVideo.fileName}` : "Source: Uploaded audio";
    }

    if (sessionVideo?.source === "record") {
      return "Source: Live audio recording";
    }

    return "Source: Not selected";
  }, [sessionVideo]);

  return (
    <main className={styles.main}>
      <AppShell
        reducedMotion={reducedMotion}
        onToggleReducedMotion={toggleReducedMotion}
        reducedMotionSource={hasOverride ? "manual" : "system"}
        demoMode={demoMode}
        onToggleDemoMode={toggleDemoMode}
        contentClassName={styles.content}
      >
        <motion.section
          className={styles.layout}
          variants={staggerChildren}
          initial={reducedMotion ? "visible" : "hidden"}
          animate="visible"
        >
          <motion.aside variants={fadeIn} className={styles.leftRail}>
            <GlassCard className={styles.sideCard}>
              <Pill className={styles.modePill}>{modeLabel}</Pill>
              <SectionTitle as="h1" className={styles.title}>
                3-Step Capture
              </SectionTitle>
              <HintText className={styles.modeMeta}>Step {flowStep} of 3</HintText>

              <Divider className={styles.sideDivider} />

              <ol className={styles.instructionList}>
                <li>Choose input: Record or Upload</li>
                <li>Preview your 15s breathing audio clip</li>
                <li>Analysis starts automatically after capture</li>
              </ol>

              <div className={styles.chipRow}>
                <Pill className={styles.statusChip}>{permissionLabel}</Pill>
                <Pill className={styles.statusChip}>{sourceLabel}</Pill>
                <Pill className={styles.statusChip}>Voice Coach: {voiceCoachEnabled ? "On" : "Off"}</Pill>
                <Pill className={styles.statusChip}>
                  Backboard:{" "}
                  {analysisStatus === "running"
                    ? "Running"
                    : analysisStatus === "complete"
                      ? "Complete"
                      : analysisStatus === "error"
                        ? "Error"
                        : analysisStatus === "ready"
                          ? "Ready"
                          : "Idle"}
                </Pill>
                <Pill className={styles.statusChip}>Device: {deviceId ? `${deviceId.slice(0, 8)}...` : "Loading"}</Pill>
                {demoMode ? <Pill className={styles.statusChip}>Demo Mode: ON</Pill> : null}
              </div>

              <HintText className={styles.statusText}>{statusMessage}</HintText>
              {errorMessage ? <p className={styles.errorText}>{errorMessage}</p> : null}
              {coachMessage ? <p className={styles.warningText}>{coachMessage}</p> : null}
              {pipelineCompleteMessage ? <p className={styles.successText}>{pipelineCompleteMessage}</p> : null}

              {analysisResults ? (
                <div className={styles.backboardSummary}>
                  <p className={styles.summaryLabel}>Backboard Output</p>
                  <p className={styles.summaryLine}>
                    Baseline: <span>{baselineDelta}</span>
                  </p>
                  <p className={styles.summaryLine}>
                    Confidence: <span>{baselineConfidence}</span>
                  </p>
                  {clinicalSummary ? (
                    <p className={styles.summaryBody}>
                      <strong>Clinical:</strong> {clinicalSummary}
                    </p>
                  ) : null}
                  {coachingTip ? (
                    <p className={styles.summaryBody}>
                      <strong>Coach:</strong> {coachingTip}
                    </p>
                  ) : null}
                  {followUpPrompt ? (
                    <p className={styles.summaryBody}>
                      <strong>Follow-up:</strong> {followUpPrompt}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </GlassCard>
          </motion.aside>

          <motion.div variants={fadeIn} className={styles.centerRail}>
            <GlassCard className={styles.previewCard}>
              <div className={styles.previewHeader}>
                <SectionTitle as="h2" className={styles.previewTitle}>
                  {flowStep === 1 ? "Choose Input" : flowStep === 2 ? "Capture / Preview" : "Analyze"}
                </SectionTitle>
                <div className={styles.previewHeaderRight}>
                  <AnimatePresence>
                    {isAnalysisRunning ? (
                      <motion.div variants={fadeUp} initial="hidden" animate="visible" exit="hidden">
                        <Pill className={styles.analyzingPill}>
                          Analyzing... {agentProgress.doneCount}/{agentProgress.total}
                        </Pill>
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                  <Pill className={styles.timerPill}>
                    {isRecording ? `Recording ${formatClock(secondsLeft)}` : `Target ${CAPTURE_SECONDS}s`}
                  </Pill>
                </div>
              </div>

              <AnimatePresence mode="wait">
                {flowStep === 1 ? (
                  <motion.div
                    key="step-choose"
                    className={styles.stageBody}
                    variants={stepTransition}
                    initial="hidden"
                    animate="visible"
                    exit="exit"
                  >
                    <div className={styles.idleInfo}>
                      <p>Use Start for a live 15-second capture, or Upload to analyze an existing audio file.</p>
                      <p>Analysis runs automatically once audio is ready.</p>
                    </div>
                  </motion.div>
                ) : (
                  <motion.div
                    key={`step-preview-${flowStep}`}
                    className={styles.stageBody}
                    variants={stepTransition}
                    initial="hidden"
                    animate="visible"
                    exit="exit"
                  >
                    <div className={styles.previewFrame}>
                      <audio ref={videoRef} className={styles.previewAudio} />

                      {!sessionVideo && !isRecording ? (
                        <div className={styles.emptyState}>
                          <p>Start recording or upload audio to preview here.</p>
                        </div>
                      ) : null}

                      <div className={styles.timerHud}>
                        <div className={styles.timerTrack}>
                          <div className={styles.timerFill} style={{ width: `${Math.max(0, Math.min(progressPercent, 100))}%` }} />
                        </div>
                      </div>
                    </div>

                    <Waveform
                      className={styles.waveformWrap}
                      envelope={displayedEnvelope}
                      energy={displayedEnergy}
                      duration={waveformDuration}
                      currentTime={playbackCurrentTime}
                      live={isRecording}
                      loading={!isRecording && waveformLoading}
                      error={!isRecording ? waveformError : null}
                      interactive={!isRecording && !!sessionVideo}
                      markers={eventMarkers}
                      onScrub={(nextTime) => seekVideo(nextTime, "scrub")}
                      onMarkerClick={(marker) => seekVideo(marker.time, "marker", marker.label)}
                    />

                    <HintText className={styles.previewHint}>
                      {isRecording
                        ? "Live waveform uses mic input."
                        : flowStep === 3
                          ? "Waveform synced to timeline. Backboard pipeline runs automatically."
                          : "Preview waveform before analysis."}
                    </HintText>

                    <motion.section
                      ref={agentsSectionRef}
                      className={styles.agentsSection}
                      variants={fadeUp}
                      initial={reducedMotion ? "visible" : "hidden"}
                      animate="visible"
                    >
                      <div className={styles.agentsHeader}>
                        <div className={styles.agentsHeaderMain}>
                          <SectionTitle as="h3" className={styles.agentsTitle}>
                            Backboard Multi-Agent Pipeline
                          </SectionTitle>
                          <Pill
                            className={cx(
                              styles.agentsProgressPill,
                              isAnalysisRunning
                                ? styles.agentsProgressRunning
                                : analysisStatus === "complete"
                                  ? styles.agentsProgressDone
                                  : undefined
                            )}
                          >
                            {progressLabel}
                          </Pill>
                        </div>
                        <button
                          type="button"
                          className={styles.agentsCollapseButton}
                          onClick={() => setAgentsExpanded((expanded) => !expanded)}
                          aria-expanded={agentsExpanded}
                        >
                          {agentsExpanded ? "Collapse" : "Expand"}
                        </button>
                      </div>

                      <HintText className={styles.agentsCopy}>
                        Live orchestration: queued - running - done. Models labeled A/B/C/D.
                      </HintText>

                      <AnimatePresence initial={false}>
                        {agentsExpanded ? (
                          <motion.div
                            className={styles.agentRows}
                            variants={staggerChildren}
                            initial="hidden"
                            animate="visible"
                            exit="exit"
                          >
                            {agentStates.map((agent) => (
                              <motion.button
                                key={agent.key}
                                type="button"
                                variants={fadeUp}
                                className={cx(
                                  styles.agentRow,
                                  agent.status === "running" && styles.agentRowRunning,
                                  agent.status === "done" && styles.agentRowDone,
                                  agent.status === "error" && styles.agentRowError
                                )}
                                onClick={() => {
                                  if (agent.key === "segmentation") {
                                    const firstMarker = eventMarkers[0];
                                    if (firstMarker) seekVideo(firstMarker.time, "marker", `${agent.title} marker`);
                                  }
                                }}
                              >
                                <span className={styles.agentTop}>
                                  <span className={styles.agentTitle}>{agent.title}</span>
                                  <span className={styles.agentModel}>Model {agent.modelLabel}</span>
                                </span>
                                <span className={styles.agentMetaRow}>
                                  <span
                                    className={cx(
                                      styles.agentStatus,
                                      agent.status === "running" && styles.agentStatusRunning,
                                      agent.status === "done" && styles.agentStatusDone,
                                      agent.status === "error" && styles.agentStatusError
                                    )}
                                  >
                                    {agent.status}
                                  </span>
                                </span>
                                <span className={styles.agentSummary}>{agent.message || agent.summary}</span>
                                {agent.status === "running" ? (
                                  <span className={styles.agentProgressTrack} aria-hidden>
                                    <span className={styles.agentProgressFill} />
                                  </span>
                                ) : null}
                              </motion.button>
                            ))}
                          </motion.div>
                        ) : null}
                      </AnimatePresence>

                      <div className={styles.agentFooter}>
                        <Pill className={styles.statusChip}>Running: {agentProgress.runningCount}</Pill>
                        <Pill className={styles.statusChip}>Errors: {agentProgress.errorCount}</Pill>
                        <Pill className={styles.statusChip}>Thread: {threadId ? "linked" : "new"}</Pill>
                      </div>
                    </motion.section>

                    <motion.section variants={fadeUp} initial={reducedMotion ? "visible" : "hidden"} animate="visible">
                      <GlassCard
                        className={cx(styles.analysisProgressCard, reducedMotion && styles.analysisProgressReducedMotion)}
                      >
                        <div className={styles.analysisProgressHeader}>
                          <SectionTitle as="h3" className={styles.analysisProgressTitle}>
                            {analysisStatus === "complete"
                              ? "Analysis complete"
                              : analysisStatus === "error"
                                ? "Analysis error"
                                : analysisStatus === "ready"
                                  ? "Analysis ready"
                                  : "Analysis Progress"}
                          </SectionTitle>
                          <Pill
                            className={cx(
                              styles.analysisProgressStatus,
                              analysisStatus === "complete" && styles.analysisProgressStatusDone
                            )}
                          >
                            {progressLabel}
                          </Pill>
                        </div>

                        <div className={styles.analysisProgressBarBlock}>
                          <p className={styles.analysisProgressLabel}>{progressLabel}</p>
                          {analysisStatus === "running" || analysisStatus === "complete" ? (
                            <div className={styles.analysisProgressTrack} aria-hidden>
                              <motion.span
                                className={styles.analysisProgressFill}
                                animate={{ width: `${Math.round(progressFraction * 100)}%` }}
                                transition={
                                  analysisStatus === "running"
                                    ? reducedMotion
                                      ? { duration: 0.12 }
                                      : {
                                          duration: 0.46,
                                          ease: [0.22, 1, 0.36, 1]
                                        }
                                    : { duration: 0.12 }
                                }
                              />
                            </div>
                          ) : null}
                        </div>

                        {analysisStatus === "running" || analysisStatus === "complete" ? (
                          <>
                            <motion.div className={styles.analysisTimeline} variants={staggerChildren}>
                              {timelineSteps.map((step) => (
                                <motion.div
                                  key={step.key}
                                  variants={fadeUp}
                                  className={cx(
                                    styles.analysisStep,
                                    step.status === "done" && styles.analysisStepDone,
                                    step.status === "running" && styles.analysisStepRunning
                                  )}
                                >
                                  <span className={styles.analysisStepIconWrap}>
                                    <ProgressStepIcon stepKey={step.key} />
                                  </span>
                                  <span className={styles.analysisStepName}>{step.label}</span>
                                </motion.div>
                              ))}
                            </motion.div>

                            <div className={styles.livePillarsRow}>
                              {livePillarCards.map((pillar) => (
                                <div key={pillar.key} className={styles.livePillarCard}>
                                  <span className={styles.livePillarLabel}>{pillar.label}</span>
                                  <AnimatePresence mode="wait" initial={false}>
                                    <motion.span
                                      key={`${pillar.key}-${pillar.value}`}
                                      className={styles.livePillarValue}
                                      variants={fadeUp}
                                      initial="hidden"
                                      animate="visible"
                                      exit="hidden"
                                    >
                                      {pillar.value}
                                    </motion.span>
                                  </AnimatePresence>
                                </div>
                              ))}
                            </div>
                          </>
                        ) : analysisStatus === "error" ? (
                          <HintText className={styles.previewHint}>Analysis failed. Capture again to retry.</HintText>
                        ) : analysisStatus === "ready" ? (
                          <HintText className={styles.previewHint}>Ready. Analysis starts automatically.</HintText>
                        ) : null}

                        <AnimatePresence>
                          {analysisStatus === "complete" ? (
                            <motion.div
                              className={styles.analysisResultsCta}
                              variants={fadeUp}
                              initial="hidden"
                              animate="visible"
                              exit="hidden"
                              {...(reducedMotion ? {} : hoverGlow)}
                            >
                              <GlowButton type="button" className={styles.controlButton} onClick={() => router.push("/results")}>
                                View Results
                              </GlowButton>
                            </motion.div>
                          ) : null}
                        </AnimatePresence>
                      </GlassCard>
                    </motion.section>
                  </motion.div>
                )}
              </AnimatePresence>
            </GlassCard>
          </motion.div>
        </motion.section>

        <motion.footer
          className={styles.controlBar}
          variants={staggerChildren}
          initial={reducedMotion ? "visible" : "hidden"}
          animate="visible"
        >
          <motion.div variants={fadeUp} {...(reducedMotion ? {} : hoverGlow)}>
            <AnimatePresence mode="wait">
              {isRecording ? (
                <motion.div key="stop" variants={fadeUp} initial="hidden" animate="visible" exit="hidden">
                  <GlowButton
                    type="button"
                    className={cx(styles.controlButton, styles.stopPrimary)}
                    onClick={() => stopRecording("cancel")}
                    disabled={isAnalysisRunning}
                  >
                    Stop
                  </GlowButton>
                </motion.div>
              ) : (
                <motion.div key="start" variants={fadeUp} initial="hidden" animate="visible" exit="hidden">
                  <GlowButton
                    type="button"
                    className={styles.controlButton}
                    onClick={startRecording}
                    disabled={isAnalysisRunning}
                  >
                    {isAnalysisRunning ? "Busy" : "Start"}
                  </GlowButton>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>

          <motion.div variants={fadeUp}>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={triggerUploadPicker}
              disabled={isRecording || isAnalysisRunning}
            >
              {isAnalysisRunning ? "Busy" : "Upload"}
            </button>
          </motion.div>

          <motion.div variants={fadeUp}>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => setVoiceCoachEnabled((enabled) => !enabled)}
              aria-pressed={voiceCoachEnabled}
            >
              Voice Coach: {voiceCoachEnabled ? "On" : "Off"}
            </button>
          </motion.div>

          <AnimatePresence>
            {isAnalysisRunning ? (
              <motion.div key="analyzing-indicator" variants={fadeUp} initial="hidden" animate="visible" exit="hidden">
                <Pill className={styles.analyzingControl}>Analyzing...</Pill>
              </motion.div>
            ) : null}
          </AnimatePresence>

        </motion.footer>

        <input
          ref={fileInputRef}
          type="file"
          accept={UPLOAD_ACCEPT}
          className={styles.fileInput}
          onChange={handleUploadSelected}
        />

        {demoMode && !demoScript.dismissed ? (
          <GlassCard className={styles.demoScript}>
            <div className={styles.demoScriptTop}>
              <p className={styles.demoScriptTitle}>Demo Script</p>
              <button type="button" className={styles.demoScriptDismiss} onClick={demoScript.dismiss}>
                Dismiss
              </button>
            </div>
            <ol className={styles.demoScriptList}>
              <li className={cx(styles.demoStep, demoScript.steps.loadSample && styles.demoStepDone)}>
                Upload file
              </li>
              <li className={cx(styles.demoStep, demoScript.steps.analyze && styles.demoStepDone)}>Auto analyze</li>
              <li className={cx(styles.demoStep, demoScript.steps.markers && styles.demoStepDone)}>
                Open explainability markers
              </li>
              <li className={cx(styles.demoStep, demoScript.steps.report && styles.demoStepDone)}>Generate clinician report</li>
              <li className={cx(styles.demoStep, demoScript.steps.readAloud && styles.demoStepDone)}>
                Play ElevenLabs read aloud
              </li>
            </ol>
            <HintText className={styles.demoScriptHint}>
              Progress {demoScript.completedCount}/{demoScript.totalCount}. Continue steps 4-5 on Results.
            </HintText>
            <button type="button" className={styles.demoScriptReset} onClick={demoScript.reset}>
              Reset Script
            </button>
          </GlassCard>
        ) : demoMode ? (
          <button type="button" className={styles.demoScriptShow} onClick={demoScript.show}>
            Show Demo Script
          </button>
        ) : null}
      </AppShell>
    </main>
  );
}
