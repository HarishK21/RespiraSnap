"use client";

import Waveform, { type WaveformMarker } from "@/components/audio/Waveform";
import AppShell from "@/components/layout/AppShell";
import { fadeIn, fadeUp, hoverGlow, staggerChildren } from "@/components/motion/presets";
import { Divider, GlassCard, GlowButton, HintText, Pill, SectionTitle } from "@/components/ui/primitives";
import { useBackboardIdentity } from "@/hooks/useBackboardIdentity";
import { useDemoMode } from "@/hooks/useDemoMode";
import { useReducedMotionPref } from "@/hooks/useReducedMotionPref";
import { useSessionVideo } from "@/hooks/useSessionVideo";
import { extractAudioFeatureTimeline, type AudioFeatureTimeline } from "@/lib/audioFeatures";
import { AnimatePresence, motion, type Variants } from "framer-motion";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import styles from "./page.module.css";

const CAPTURE_SECONDS = 15;
const UPLOAD_ACCEPT = ".mp4,.mov,.webm,video/mp4,video/quicktime,video/webm";

const ACCEPTED_MIME_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);
const ACCEPTED_EXTENSIONS = [".mp4", ".mov", ".webm"];

type RecordPageClientProps = {
  mode: string;
};

type InputMode = "record" | "upload" | null;
type PermissionState = "idle" | "granted" | "denied" | "unsupported";
type RecorderStopReason = "complete" | "cancel";
type AgentStatus = "queued" | "running" | "done" | "error";
type AgentKey = "segmentation" | "baselineTrend" | "clinicalSummary" | "coaching" | "followUp";

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
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4"
  ];

  if (typeof MediaRecorder === "undefined") return undefined;
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

function isAcceptableVideoFile(file: File) {
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

export default function RecordPageClient({ mode }: RecordPageClientProps) {
  const router = useRouter();
  const modeLabel = modeToLabel(mode);

  const { reducedMotion, hasOverride, toggleReducedMotion } = useReducedMotionPref();
  const { demoMode, toggleDemoMode } = useDemoMode();
  const { sessionVideo, setSessionVideo, clearSessionVideo } = useSessionVideo();
  const { deviceId, assistantId, threadId, isReady: identityReady, setBackboardContext } = useBackboardIdentity();

  const [inputMode, setInputMode] = useState<InputMode>(sessionVideo?.source ?? null);
  const [isRecording, setIsRecording] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(CAPTURE_SECONDS);
  const [permissionState, setPermissionState] = useState<PermissionState>("idle");
  const [voiceCoachEnabled, setVoiceCoachEnabled] = useState(true);
  const [statusMessage, setStatusMessage] = useState("Choose Record or Upload to begin.");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [coachMessage, setCoachMessage] = useState<string | null>(null);
  const [analysisMessage, setAnalysisMessage] = useState<string | null>(null);
  const [agentsOpen, setAgentsOpen] = useState(false);

  const [waveformData, setWaveformData] = useState<AudioFeatureTimeline | null>(null);
  const [waveformLoading, setWaveformLoading] = useState(false);
  const [waveformError, setWaveformError] = useState<string | null>(null);
  const [liveWaveform, setLiveWaveform] = useState<{ envelope: number[]; energy: number[] }>({
    envelope: [],
    energy: []
  });

  const [videoCurrentTime, setVideoCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);

  const [analysisRunning, setAnalysisRunning] = useState(false);
  const [analysisResults, setAnalysisResults] = useState<Record<string, unknown> | null>(null);
  const [agentStates, setAgentStates] = useState<AgentState[]>(() => createInitialAgentState());

  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const flowStep = sessionVideo ? 3 : inputMode ? 2 : 1;
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
    const done = agentStates.filter((agent) => agent.status === "done").length;
    const running = agentStates.filter((agent) => agent.status === "running").length;
    const errors = agentStates.filter((agent) => agent.status === "error").length;

    return { total, done, running, errors };
  }, [agentStates]);

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
        type: recorderMimeType || "video/webm"
      });

      recordingChunksRef.current = [];

      if (!recordedBlob.size) {
        setErrorMessage("Recording finished, but no video data was captured. Please try again.");
        return;
      }

      const objectUrl = URL.createObjectURL(recordedBlob);
      setSessionVideo({
        blob: recordedBlob,
        url: objectUrl,
        source: "record",
        createdAt: Date.now()
      });

      setStatusMessage("15 second recording ready for Backboard analysis.");
      setAnalysisMessage(null);
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
      setErrorMessage("This browser does not support in-browser video recording.");
      return;
    }

    setInputMode("record");
    setErrorMessage(null);
    setAnalysisMessage(null);
    setCoachMessage(null);
    setWaveformError(null);
    setWaveformData(null);
    setVideoCurrentTime(0);
    setVideoDuration(0);
    setStatusMessage("Requesting camera and microphone access...");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: true
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
        setErrorMessage("Recording failed. Please check camera/mic permissions and try again.");
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
      setStatusMessage("Camera/microphone access was blocked.");
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Unable to access camera and microphone. Update browser permissions and retry."
      );
      stopMediaTracks();
    }
  }, [clearSessionVideo, finalizeRecording, startLiveWaveform, stopMediaTracks, stopRecording]);

  const chooseRecord = useCallback(() => {
    setInputMode("record");
    setErrorMessage(null);
    setStatusMessage("Press Start to capture exactly 15 seconds.");
  }, []);

  const triggerUploadPicker = useCallback(() => {
    setInputMode("upload");
    setErrorMessage(null);
    setStatusMessage("Select a video file to preview and analyze.");
    fileInputRef.current?.click();
  }, []);

  const handleUploadSelected = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";

      if (!file) return;

      if (!isAcceptableVideoFile(file)) {
        setErrorMessage("Unsupported file format. Please choose mp4, mov, or webm.");
        return;
      }

      const objectUrl = URL.createObjectURL(file);
      setSessionVideo({
        blob: file,
        url: objectUrl,
        source: "upload",
        fileName: file.name,
        createdAt: Date.now()
      });

      setWaveformData(null);
      setWaveformError(null);
      setVideoCurrentTime(0);
      setVideoDuration(0);
      setInputMode("upload");
      setStatusMessage("Uploaded video ready for Backboard analysis.");
      setAnalysisMessage(null);
      setErrorMessage(null);
    },
    [setSessionVideo]
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
        setStatusMessage(`Marker: ${markerLabel} at ${formatTimeLabel(clamped)}.`);
      }
    },
    [isRecording, sessionVideo, videoDuration, waveformDuration]
  );

  const handleAnalyze = useCallback(async () => {
    if (!sessionVideo || isRecording || analysisRunning || !identityReady) return;

    const envelopeForPipeline = downsample(waveformData?.envelope ?? displayedEnvelope, 96);
    const energyForPipeline = downsample(waveformData?.energy ?? displayedEnergy, 96);
    const featureStats = computeFeatureStats(energyForPipeline);

    setAgentsOpen(true);
    setAnalysisRunning(true);
    setAnalysisResults(null);
    setAnalysisMessage("Backboard multi-agent pipeline running...");
    setErrorMessage(null);
    setAgentStates(createInitialAgentState());

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

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const processEvent = (event: AnalyzeEvent) => {
        if (event.type === "init") {
          setBackboardContext({ assistantId: event.assistantId, threadId: event.threadId });
          return;
        }

        if (event.type === "agent") {
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
          return;
        }

        if (event.type === "complete") {
          setBackboardContext({ assistantId: event.assistantId, threadId: event.threadId });
          setAnalysisResults(event.results);
          setAnalysisMessage("Backboard pipeline complete.");
          setStatusMessage("Analysis complete. Review agent outputs.");
          return;
        }

        if (event.type === "fatal") {
          setErrorMessage(event.message);
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
      setErrorMessage(error instanceof Error ? error.message : "Backboard analysis failed.");
      setAnalysisMessage(null);
    } finally {
      setAnalysisRunning(false);
    }
  }, [
    analysisRunning,
    assistantId,
    deviceId,
    displayedEnergy,
    displayedEnvelope,
    eventMarkers,
    identityReady,
    isRecording,
    mode,
    reducedMotion,
    sessionVideo,
    setBackboardContext,
    threadId,
    updateAgentState,
    voiceCoachEnabled,
    waveformData?.energy,
    waveformData?.envelope,
    waveformDuration
  ]);

  const handleReset = useCallback(() => {
    clearSessionVideo();
    stopRecording("cancel");
    stopVoiceCoach();
    stopLiveWaveform();
    setInputMode(null);
    setIsRecording(false);
    setSecondsLeft(CAPTURE_SECONDS);
    setAnalysisMessage(null);
    setAnalysisResults(null);
    setAnalysisRunning(false);
    setAgentStates(createInitialAgentState());
    setCoachMessage(null);
    setErrorMessage(null);
    setWaveformData(null);
    setWaveformError(null);
    setWaveformLoading(false);
    setLiveWaveform({ envelope: [], energy: [] });
    setVideoCurrentTime(0);
    setVideoDuration(0);
    setStatusMessage("Choose Record or Upload to begin.");
  }, [clearSessionVideo, stopLiveWaveform, stopRecording, stopVoiceCoach]);

  useEffect(() => {
    if (!isRecording) return;

    if (voiceCoachEnabled) {
      startVoiceCoach();
      return;
    }

    stopVoiceCoach();
  }, [isRecording, startVoiceCoach, stopVoiceCoach, voiceCoachEnabled]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isRecording && mediaStreamRef.current) {
      video.srcObject = mediaStreamRef.current;
      video.muted = true;
      video.controls = false;
      void video.play().catch(() => {
        setErrorMessage("Live preview failed to autoplay. Tap the video to continue.");
      });
      return;
    }

    video.srcObject = null;

    if (sessionVideo?.url) {
      video.src = sessionVideo.url;
      video.muted = false;
      video.controls = true;
      video.preload = "metadata";
      video.playsInline = true;
      return;
    }

    video.removeAttribute("src");
    video.load();
  }, [isRecording, sessionVideo?.url]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const updateTime = () => {
      setVideoCurrentTime(Number.isFinite(video.currentTime) ? video.currentTime : 0);
    };

    const updateMeta = () => {
      const nextDuration = Number.isFinite(video.duration) ? video.duration : 0;
      setVideoDuration(nextDuration);
    };

    video.addEventListener("timeupdate", updateTime);
    video.addEventListener("loadedmetadata", updateMeta);
    video.addEventListener("durationchange", updateMeta);
    video.addEventListener("seeking", updateTime);

    return () => {
      video.removeEventListener("timeupdate", updateTime);
      video.removeEventListener("loadedmetadata", updateMeta);
      video.removeEventListener("durationchange", updateMeta);
      video.removeEventListener("seeking", updateTime);
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
        setWaveformError("Unable to decode audio from this video. Waveform unavailable.");
      })
      .finally(() => {
        if (cancelled) return;
        setWaveformLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isRecording, sessionVideo?.createdAt, sessionVideo?.blob]);

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
    if (permissionState === "granted") return "Permissions: Granted";
    if (permissionState === "denied") return "Permissions: Blocked";
    if (permissionState === "unsupported") return "Permissions: Unsupported";
    return "Permissions: Pending";
  }, [permissionState]);

  const sourceLabel = useMemo(() => {
    if (sessionVideo?.source === "upload") {
      return sessionVideo.fileName ? `Source: ${sessionVideo.fileName}` : "Source: Uploaded video";
    }

    if (sessionVideo?.source === "record") {
      return "Source: Live recording";
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
                <li>Preview your 15s breathing clip</li>
                <li>Run Analyze to start Backboard agents</li>
              </ol>

              <div className={styles.chipRow}>
                <Pill className={styles.statusChip}>{permissionLabel}</Pill>
                <Pill className={styles.statusChip}>{sourceLabel}</Pill>
                <Pill className={styles.statusChip}>Voice Coach: {voiceCoachEnabled ? "On" : "Off"}</Pill>
                <Pill className={styles.statusChip}>Backboard: {analysisRunning ? "Running" : "Ready"}</Pill>
                <Pill className={styles.statusChip}>Device: {deviceId ? `${deviceId.slice(0, 8)}...` : "Loading"}</Pill>
              </div>

              <HintText className={styles.statusText}>{statusMessage}</HintText>
              {errorMessage ? <p className={styles.errorText}>{errorMessage}</p> : null}
              {coachMessage ? <p className={styles.warningText}>{coachMessage}</p> : null}
              {analysisMessage ? <p className={styles.successText}>{analysisMessage}</p> : null}

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
                <Pill className={styles.timerPill}>
                  {isRecording ? `Recording ${formatClock(secondsLeft)}` : `Target ${CAPTURE_SECONDS}s`}
                </Pill>
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
                    <div className={styles.chooseGrid}>
                      <button type="button" className={styles.chooseCard} onClick={chooseRecord}>
                        <strong>Record</strong>
                        <span>Use camera + mic for an exact 15s capture.</span>
                      </button>

                      <button type="button" className={styles.chooseCard} onClick={triggerUploadPicker}>
                        <strong>Upload</strong>
                        <span>Bring an existing mp4, mov, or webm file.</span>
                      </button>
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
                      <video ref={videoRef} className={styles.previewVideo} playsInline />

                      {!sessionVideo && !isRecording ? (
                        <div className={styles.emptyState}>
                          <p>Start recording or upload a video to preview here.</p>
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
                          ? "Waveform synced to timeline. Analyze runs Backboard multi-agent pipeline."
                          : "Preview waveform before analysis."}
                    </HintText>
                  </motion.div>
                )}
              </AnimatePresence>
            </GlassCard>
          </motion.div>

          <motion.aside variants={fadeIn} className={styles.rightRail}>
            <div className={styles.agentsDock}>
              <button
                type="button"
                className={styles.agentsHandle}
                onClick={() => setAgentsOpen((open) => !open)}
                aria-expanded={agentsOpen}
              >
                Agents {agentProgress.done}/{agentProgress.total}
              </button>

              <AnimatePresence>
                {agentsOpen ? (
                  <motion.div
                    className={styles.agentsPanelWrap}
                    variants={stepTransition}
                    initial="hidden"
                    animate="visible"
                    exit="exit"
                  >
                    <GlassCard className={styles.agentsPanel}>
                      <SectionTitle as="h3" className={styles.agentsTitle}>
                        Backboard Multi-Agent Pipeline
                      </SectionTitle>
                      <HintText className={styles.agentsCopy}>
                        Live orchestration: queued - running - done. Models labeled A/B/C/D.
                      </HintText>

                      <div className={styles.agentRows}>
                        {agentStates.map((agent) => (
                          <button
                            key={agent.key}
                            type="button"
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
                            <span className={styles.agentStatus}>{agent.status}</span>
                            <span className={styles.agentSummary}>{agent.message || agent.summary}</span>
                          </button>
                        ))}
                      </div>

                      <div className={styles.agentMetaRow}>
                        <Pill className={styles.statusChip}>Running: {agentProgress.running}</Pill>
                        <Pill className={styles.statusChip}>Errors: {agentProgress.errors}</Pill>
                        <Pill className={styles.statusChip}>Thread: {threadId ? "linked" : "new"}</Pill>
                      </div>
                    </GlassCard>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>
          </motion.aside>
        </motion.section>

        <motion.footer
          className={styles.controlBar}
          variants={staggerChildren}
          initial={reducedMotion ? "visible" : "hidden"}
          animate="visible"
        >
          <motion.div variants={fadeUp} {...(reducedMotion ? {} : hoverGlow)}>
            <GlowButton
              type="button"
              className={styles.controlButton}
              onClick={startRecording}
              disabled={isRecording || demoMode}
            >
              Start
            </GlowButton>
          </motion.div>

          <motion.div variants={fadeUp}>
            <button
              type="button"
              className={cx(styles.secondaryButton, styles.stopButton)}
              onClick={() => stopRecording("cancel")}
              disabled={!isRecording}
            >
              Stop
            </button>
          </motion.div>

          <motion.div variants={fadeUp}>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={triggerUploadPicker}
              disabled={isRecording}
            >
              Upload
            </button>
          </motion.div>

          <motion.div variants={fadeUp}>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => setVoiceCoachEnabled((enabled) => !enabled)}
              aria-pressed={voiceCoachEnabled}
              disabled={demoMode}
            >
              Voice Coach: {voiceCoachEnabled ? "On" : "Off"}
            </button>
          </motion.div>

          <motion.div variants={fadeUp} {...(reducedMotion ? {} : hoverGlow)}>
            <GlowButton
              type="button"
              className={styles.controlButton}
              onClick={handleAnalyze}
              disabled={!sessionVideo || isRecording || demoMode || analysisRunning || !identityReady}
            >
              {analysisRunning ? "Analyzing..." : "Analyze"}
            </GlowButton>
          </motion.div>

          <motion.div variants={fadeUp}>
            <button
              type="button"
              className={styles.ghostButton}
              onClick={handleReset}
              disabled={isRecording || analysisRunning}
            >
              Reset
            </button>
          </motion.div>

          <motion.div variants={fadeUp}>
            <button type="button" className={styles.ghostButton} onClick={() => router.push("/")}>
              Back
            </button>
          </motion.div>
        </motion.footer>

        <input
          ref={fileInputRef}
          type="file"
          accept={UPLOAD_ACCEPT}
          className={styles.fileInput}
          onChange={handleUploadSelected}
        />
      </AppShell>
    </main>
  );
}
