"use client";

import AppShell from "@/components/layout/AppShell";
import { fadeIn, fadeUp, hoverGlow, staggerChildren } from "@/components/motion/presets";
import { Divider, GlassCard, GlowButton, HintText, Pill, SectionTitle } from "@/components/ui/primitives";
import { useDemoMode } from "@/hooks/useDemoMode";
import { useReducedMotionPref } from "@/hooks/useReducedMotionPref";
import { useSessionVideo } from "@/hooks/useSessionVideo";
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

type BreathingCue = {
  atMs: number;
  text: string;
};

const BREATHING_CUES: BreathingCue[] = [
  { atMs: 0, text: "Inhale..." },
  { atMs: 5000, text: "Hold..." },
  { atMs: 8000, text: "Exhale..." }
];

function modeToLabel(mode: string) {
  if (mode === "breathing") return "Breathing Snapshot";
  return "Breathing Snapshot";
}

function formatClock(seconds: number) {
  return `00:${String(Math.max(0, seconds)).padStart(2, "0")}`;
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

export default function RecordPageClient({ mode }: RecordPageClientProps) {
  const router = useRouter();
  const modeLabel = modeToLabel(mode);

  const { reducedMotion, hasOverride, toggleReducedMotion } = useReducedMotionPref();
  const { demoMode, toggleDemoMode } = useDemoMode();
  const { sessionVideo, setSessionVideo, clearSessionVideo } = useSessionVideo();

  const [inputMode, setInputMode] = useState<InputMode>(sessionVideo?.source ?? null);
  const [isRecording, setIsRecording] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(CAPTURE_SECONDS);
  const [permissionState, setPermissionState] = useState<PermissionState>(
    canRecordInBrowser() ? "idle" : "unsupported"
  );
  const [voiceCoachEnabled, setVoiceCoachEnabled] = useState(true);
  const [statusMessage, setStatusMessage] = useState("Choose Record or Upload to begin.");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [coachMessage, setCoachMessage] = useState<string | null>(null);
  const [analyzeMessage, setAnalyzeMessage] = useState<string | null>(null);
  const [agentsOpen, setAgentsOpen] = useState(false);

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

  const flowStep = sessionVideo ? 3 : inputMode ? 2 : 1;
  const progressPercent = ((CAPTURE_SECONDS - secondsLeft) / CAPTURE_SECONDS) * 100;

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

  const stopMediaTracks = useCallback(() => {
    const stream = mediaStreamRef.current;
    if (!stream) return;

    stream.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
  }, []);

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
          // Keep fallback message.
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

    const scheduled = BREATHING_CUES.map((cue) =>
      setTimeout(() => {
        void playVoiceCue(cue.text);
      }, cue.atMs)
    );

    cueTimeoutsRef.current = scheduled;
  }, [playVoiceCue, stopVoiceCoach, voiceCoachEnabled]);

  const finalizeRecording = useCallback(
    (reason: RecorderStopReason, recorderMimeType?: string) => {
      clearRecordingTimers();
      stopVoiceCoach();
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

      setStatusMessage("15 second recording ready for analysis.");
      setAnalyzeMessage(null);
      setErrorMessage(null);
    },
    [clearRecordingTimers, setSessionVideo, stopMediaTracks, stopVoiceCoach]
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

      if (recorder.state !== "inactive") {
        recorder.stop();
      } else {
        finalizeRecording(reason, recorder.mimeType);
      }
    },
    [clearRecordingTimers, finalizeRecording, stopVoiceCoach]
  );

  const startRecording = useCallback(async () => {
    if (!canRecordInBrowser()) {
      setPermissionState("unsupported");
      setErrorMessage("This browser does not support in-browser video recording.");
      return;
    }

    setInputMode("record");
    setErrorMessage(null);
    setAnalyzeMessage(null);
    setCoachMessage(null);
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
  }, [clearSessionVideo, finalizeRecording, stopMediaTracks, stopRecording]);

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

      setInputMode("upload");
      setStatusMessage("Uploaded video ready for analysis.");
      setAnalyzeMessage(null);
      setErrorMessage(null);
    },
    [setSessionVideo]
  );

  const handleAnalyze = useCallback(() => {
    if (!sessionVideo) return;

    setAnalyzeMessage("Analysis handoff placeholder triggered. Judges: connect this to your agents pipeline.");
    setStatusMessage("Ready for next stage.");
    setAgentsOpen(true);
  }, [sessionVideo]);

  const handleReset = useCallback(() => {
    clearSessionVideo();
    setInputMode(null);
    setIsRecording(false);
    setSecondsLeft(CAPTURE_SECONDS);
    setAnalyzeMessage(null);
    setCoachMessage(null);
    setErrorMessage(null);
    setStatusMessage("Choose Record or Upload to begin.");
  }, [clearSessionVideo]);

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
    if (!sessionVideo?.source || isRecording) return;
    setInputMode(sessionVideo.source);
  }, [isRecording, sessionVideo?.source]);

  useEffect(() => {
    return () => {
      clearRecordingTimers();
      stopVoiceCoach();
      stopMediaTracks();
    };
  }, [clearRecordingTimers, stopMediaTracks, stopVoiceCoach]);

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
                <li>Run Analyze to continue</li>
              </ol>

              <div className={styles.chipRow}>
                <Pill className={styles.statusChip}>{permissionLabel}</Pill>
                <Pill className={styles.statusChip}>{sourceLabel}</Pill>
                <Pill className={styles.statusChip}>Voice Coach: {voiceCoachEnabled ? "On" : "Off"}</Pill>
              </div>

              <HintText className={styles.statusText}>{statusMessage}</HintText>
              {errorMessage ? <p className={styles.errorText}>{errorMessage}</p> : null}
              {coachMessage ? <p className={styles.warningText}>{coachMessage}</p> : null}
              {analyzeMessage ? <p className={styles.successText}>{analyzeMessage}</p> : null}
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

                    <HintText className={styles.previewHint}>
                      {isRecording
                        ? "Capture runs for exactly 15 seconds."
                        : flowStep === 3
                          ? "Preview ready. Press Analyze to continue."
                          : "Preview your clip before analysis."}
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
                Agents
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
                        Agents Drawer
                      </SectionTitle>
                      <HintText className={styles.agentsCopy}>
                        Placeholder for judge demos. Connect Analyze to your multi-agent workflow here.
                      </HintText>
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
              disabled={!sessionVideo || isRecording || demoMode}
            >
              Analyze
            </GlowButton>
          </motion.div>

          <motion.div variants={fadeUp}>
            <button type="button" className={styles.ghostButton} onClick={handleReset} disabled={isRecording}>
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
