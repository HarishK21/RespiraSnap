"use client";

import Waveform, { type WaveformMarker } from "@/components/audio/Waveform";
import AppShell from "@/components/layout/AppShell";
import { fadeIn, fadeUp, hoverGlow, staggerChildren } from "@/components/motion/presets";
import { GlassCard, GlowButton, HintText, Pill, SectionTitle } from "@/components/ui/primitives";
import { useBackboardIdentity } from "@/hooks/useBackboardIdentity";
import { useDemoMode } from "@/hooks/useDemoMode";
import { useReducedMotionPref } from "@/hooks/useReducedMotionPref";
import { useSessionAnalysis } from "@/hooks/useSessionAnalysis";
import { useSessionVideo } from "@/hooks/useSessionVideo";
import type { SessionAnalysis } from "@/lib/analysisBundle";
import { readArchivedVideoBlob } from "@/lib/videoArchive";
import { AnimatePresence, motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./page.module.css";

type HistoryFilter = "7d" | "30d" | "all";

type TimelineItem = {
  id: string;
  source: "local" | "backboard";
  createdAt: string;
  score: number;
  confidence: "low" | "med" | "high";
  summary: string;
  reportText: string;
  envelope: number[];
  energy: number[];
  markers: WaveformMarker[];
  duration: number;
  baselineDelta: string;
  session: SessionAnalysis | null;
};

type BackboardHistoryResponse = {
  items?: Array<{
    id?: string;
    createdAt?: string;
    payload?: Record<string, unknown>;
  }>;
  sampleCount?: number;
};

function cx(...classNames: Array<string | undefined | null | false>) {
  return classNames.filter(Boolean).join(" ");
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function safeNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function safeString(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeConfidence(value: unknown, fallback: "low" | "med" | "high"): "low" | "med" | "high" {
  const normalized = safeString(value).toLowerCase();
  if (normalized === "low" || normalized === "med" || normalized === "high") return normalized;
  return fallback;
}

function formatTimestamp(isoString: string) {
  const date = new Date(isoString);
  return date.toLocaleString("en-CA", {
    weekday: "short",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function formatTime(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function confidenceLabel(confidence: "low" | "med" | "high") {
  if (confidence === "high") return "High confidence";
  if (confidence === "med") return "Medium confidence";
  return "Low confidence";
}

function buildSparklinePath(values: number[], width = 96, height = 30) {
  if (!values.length) return "";

  const points = values.slice(0, 28);

  return points
    .map((value, index) => {
      const x = points.length === 1 ? width / 2 : (index / (points.length - 1)) * width;
      const y = height - 3 - clamp(value, 0, 1) * (height - 6);
      return `${index === 0 ? "M" : "L"} ${x},${y}`;
    })
    .join(" ");
}

function downsample(values: number[], target = 28) {
  if (!values.length || target <= 0) return [];
  if (values.length <= target) return values.map((value) => clamp(value, 0, 1));

  const result: number[] = [];
  const step = values.length / target;

  for (let index = 0; index < target; index += 1) {
    const start = Math.floor(index * step);
    const end = Math.min(values.length, Math.floor((index + 1) * step));
    let total = 0;
    let count = 0;

    for (let i = start; i < end; i += 1) {
      total += Math.abs(values[i] ?? 0);
      count += 1;
    }

    result.push(count ? total / count : 0);
  }

  return result;
}

export default function HistoryPageClient() {
  const router = useRouter();
  const { reducedMotion, hasOverride, toggleReducedMotion } = useReducedMotionPref();
  const { demoMode, toggleDemoMode } = useDemoMode();
  const { deviceId, assistantId, isReady: identityReady } = useBackboardIdentity();
  const { sessionVideo } = useSessionVideo();
  const { sessionSnapshots } = useSessionAnalysis();

  const [activeFilter, setActiveFilter] = useState<HistoryFilter>("30d");
  const [selectedItem, setSelectedItem] = useState<TimelineItem | null>(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoError, setVideoError] = useState("");
  const [videoCurrentTime, setVideoCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [markerLabel, setMarkerLabel] = useState("");
  const [readAloudBusy, setReadAloudBusy] = useState(false);
  const [readAloudError, setReadAloudError] = useState("");
  const [sampleCount, setSampleCount] = useState(0);
  const [syncError, setSyncError] = useState("");
  const [backboardItems, setBackboardItems] = useState<TimelineItem[]>([]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const modalObjectUrlRef = useRef<string | null>(null);

  const localTimeline = useMemo<TimelineItem[]>(() => {
    return sessionSnapshots
      .map((session) => ({
        id: `local-${session.createdAt}`,
        source: "local" as const,
        createdAt: session.createdAt,
        score: session.score,
        confidence: session.confidenceLabel,
        summary: session.clinicianSummary,
        reportText: session.reportText,
        envelope: session.waveform.envelope,
        energy: session.waveform.energy,
        markers: session.markers.map((marker) => ({
          id: marker.id,
          time: marker.time,
          label: marker.label
        })),
        duration: session.waveform.duration,
        baselineDelta: session.deltaLabel,
        session
      }))
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  }, [sessionSnapshots]);

  useEffect(() => {
    if (!identityReady || !assistantId) return;

    let cancelled = false;

    const syncHistory = async () => {
      setSyncError("");

      try {
        const response = await fetch("/api/backboard/history", {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            assistantId,
            deviceId
          })
        });

        if (!response.ok) {
          let detail = "Unable to sync Backboard history.";
          try {
            const payload = (await response.json()) as { error?: string };
            if (payload.error) detail = payload.error;
          } catch {
            // Keep fallback.
          }
          throw new Error(detail);
        }

        const payload = (await response.json()) as BackboardHistoryResponse;
        if (cancelled) return;

        const nextSampleCount = safeNumber(payload.sampleCount, 0);
        setSampleCount(nextSampleCount);

        const remoteTimeline: TimelineItem[] = (payload.items ?? []).map((item, index) => {
          const body = item.payload ?? {};
          const featureStats = (body.featureStats ?? {}) as Record<string, unknown>;
          const generatedScore = clamp(
            Math.round(58 + safeNumber(featureStats.rhythmStability, 0) * 26 + safeNumber(featureStats.averageEnergy, 0) * 16),
            0,
            100
          );
          const score = clamp(Math.round(safeNumber(body.score, generatedScore)), 0, 100);
          const confidence = normalizeConfidence(
            body.confidence,
            nextSampleCount >= 8 ? "high" : nextSampleCount >= 3 ? "med" : "low"
          );

          const envelope = Array.isArray(body.envelope)
            ? body.envelope
                .map((point) => safeNumber(point, 0))
                .map((point) => clamp(point, 0, 1))
                .slice(0, 160)
            : downsample(
                [
                  safeNumber(featureStats.averageEnergy, 0),
                  safeNumber(featureStats.peakEnergy, 0),
                  safeNumber(featureStats.rhythmStability, 0.5),
                  safeNumber(featureStats.averageEnergy, 0)
                ],
                24
              );

          return {
            id: `backboard-${safeString(item.id, String(index))}`,
            source: "backboard",
            createdAt: safeString(body.capturedAt, item.createdAt ?? new Date().toISOString()),
            score,
            confidence,
            summary: safeString(body.clinicianSummary, "Backboard snapshot summary available."),
            reportText: safeString(body.clinicianSummary, "Backboard snapshot summary available."),
            envelope,
            energy: downsample(envelope, Math.max(20, Math.min(120, envelope.length))),
            markers: [],
            duration: Math.max(0, safeNumber(body.duration, 15)),
            baselineDelta: safeString(body.baselineDelta, "Baseline trend linked"),
            session: null
          };
        });

        setBackboardItems(remoteTimeline);
      } catch (error) {
        if (cancelled) return;
        setSyncError(error instanceof Error ? error.message : "Backboard history sync failed.");
      }
    };

    void syncHistory();

    return () => {
      cancelled = true;
    };
  }, [assistantId, deviceId, identityReady]);

  const timeline = useMemo(() => {
    const localTimes = localTimeline.map((item) => new Date(item.createdAt).getTime());

    const remoteOnly = backboardItems.filter((item) => {
      const remoteTime = new Date(item.createdAt).getTime();
      return !localTimes.some((localTime) => Math.abs(localTime - remoteTime) <= 90_000);
    });

    return [...localTimeline, ...remoteOnly].sort(
      (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
    );
  }, [backboardItems, localTimeline]);

  const filteredTimeline = useMemo(() => {
    if (activeFilter === "all") return timeline;

    const now = Date.now();
    const days = activeFilter === "7d" ? 7 : 30;
    const cutoff = now - days * 24 * 60 * 60 * 1000;

    return timeline.filter((item) => new Date(item.createdAt).getTime() >= cutoff);
  }, [activeFilter, timeline]);

  const selectedDuration = selectedItem?.duration || videoDuration || 0;

  const stopReadAloud = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }

    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }

    setReadAloudBusy(false);
  }, []);

  const closeModal = useCallback(() => {
    setSelectedItem(null);
    setMarkerLabel("");
    setVideoCurrentTime(0);
    setVideoDuration(0);
    setVideoError("");
    stopReadAloud();

    if (modalObjectUrlRef.current) {
      URL.revokeObjectURL(modalObjectUrlRef.current);
      modalObjectUrlRef.current = null;
    }

    setVideoUrl("");
  }, [stopReadAloud]);

  const seekVideo = useCallback(
    (nextTime: number, marker?: string) => {
      const duration = selectedDuration;
      const clampedTime = clamp(nextTime, 0, Math.max(0, duration));

      if (videoRef.current) {
        videoRef.current.currentTime = clampedTime;
      }

      setVideoCurrentTime(clampedTime);
      if (marker) {
        setMarkerLabel(`${marker} • ${formatTime(clampedTime)}`);
      }
    },
    [selectedDuration]
  );

  const openModal = useCallback(
    async (item: TimelineItem) => {
      setSelectedItem(item);
      setVideoLoading(true);
      setVideoError("");
      setVideoCurrentTime(0);
      setVideoDuration(0);
      setMarkerLabel("");

      if (modalObjectUrlRef.current) {
        URL.revokeObjectURL(modalObjectUrlRef.current);
        modalObjectUrlRef.current = null;
      }

      if (item.session && sessionVideo?.url && item.session.createdAt === sessionSnapshots[0]?.createdAt) {
        setVideoUrl(sessionVideo.url);
        setVideoLoading(false);
        return;
      }

      try {
        const blob = await readArchivedVideoBlob(item.createdAt);
        if (!blob) {
          setVideoError("Archived video unavailable for this snapshot.");
          setVideoUrl("");
          return;
        }

        const url = URL.createObjectURL(blob);
        modalObjectUrlRef.current = url;
        setVideoUrl(url);
      } catch {
        setVideoError("Unable to load archived replay.");
        setVideoUrl("");
      } finally {
        setVideoLoading(false);
      }
    },
    [sessionSnapshots, sessionVideo?.url]
  );

  const handleReadAloud = useCallback(async () => {
    if (!selectedItem) return;

    if (readAloudBusy) {
      stopReadAloud();
      return;
    }

    setReadAloudBusy(true);
    setReadAloudError("");

    try {
      const text = selectedItem.reportText || selectedItem.summary;
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          text: text.slice(0, 3200)
        })
      });

      if (!response.ok) {
        let detail = "Unable to read this summary.";
        try {
          const payload = (await response.json()) as { error?: string };
          if (payload.error) detail = payload.error;
        } catch {
          // Keep fallback.
        }
        throw new Error(detail);
      }

      const audioBlob = await response.blob();
      const url = URL.createObjectURL(audioBlob);
      audioUrlRef.current = url;

      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        stopReadAloud();
      };

      await audio.play();
    } catch (error) {
      setReadAloudError(error instanceof Error ? error.message : "Read aloud failed.");
      setReadAloudBusy(false);
    }
  }, [readAloudBusy, selectedItem, stopReadAloud]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const syncTime = () => {
      setVideoCurrentTime(Number.isFinite(video.currentTime) ? video.currentTime : 0);
    };

    const syncDuration = () => {
      setVideoDuration(Number.isFinite(video.duration) ? video.duration : 0);
    };

    video.addEventListener("timeupdate", syncTime);
    video.addEventListener("loadedmetadata", syncDuration);
    video.addEventListener("durationchange", syncDuration);
    video.addEventListener("seeking", syncTime);

    return () => {
      video.removeEventListener("timeupdate", syncTime);
      video.removeEventListener("loadedmetadata", syncDuration);
      video.removeEventListener("durationchange", syncDuration);
      video.removeEventListener("seeking", syncTime);
    };
  }, [selectedItem?.id]);

  useEffect(() => {
    return () => {
      stopReadAloud();
      if (modalObjectUrlRef.current) {
        URL.revokeObjectURL(modalObjectUrlRef.current);
        modalObjectUrlRef.current = null;
      }
    };
  }, [stopReadAloud]);

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
          <motion.div variants={fadeIn}>
            <GlassCard className={styles.headerCard}>
              <div className={styles.headerTop}>
                <SectionTitle as="h1" className={styles.title}>
                  Snapshot History
                </SectionTitle>
                <div className={styles.filterRow}>
                  <button
                    type="button"
                    className={cx(styles.filterButton, activeFilter === "7d" && styles.filterButtonActive)}
                    onClick={() => setActiveFilter("7d")}
                  >
                    7 days
                  </button>
                  <button
                    type="button"
                    className={cx(styles.filterButton, activeFilter === "30d" && styles.filterButtonActive)}
                    onClick={() => setActiveFilter("30d")}
                  >
                    30 days
                  </button>
                  <button
                    type="button"
                    className={cx(styles.filterButton, activeFilter === "all" && styles.filterButtonActive)}
                    onClick={() => setActiveFilter("all")}
                  >
                    All
                  </button>
                </div>
              </div>

              <div className={styles.metaRow}>
                <Pill className={styles.metaPill}>Snapshots: {timeline.length}</Pill>
                <Pill className={styles.metaPill}>Backboard Samples: {sampleCount}</Pill>
                <Pill className={styles.metaPill}>Cache: Local + Backboard</Pill>
              </div>

              {syncError ? <HintText className={styles.errorText}>{syncError}</HintText> : null}
            </GlassCard>
          </motion.div>

          <motion.div variants={fadeIn} className={styles.timelineWrap}>
            {filteredTimeline.length === 0 ? (
              <GlassCard className={styles.emptyCard}>
                <SectionTitle as="h2" className={styles.emptyTitle}>
                  No snapshots in this range
                </SectionTitle>
                <HintText className={styles.emptyHint}>
                  Capture and analyze a recording to populate your timeline.
                </HintText>
                <div className={styles.emptyActions}>
                  <GlowButton type="button" onClick={() => router.push("/record")}>
                    Go To Record
                  </GlowButton>
                  <button type="button" className={styles.ghostButton} onClick={() => router.push("/")}>
                    Home
                  </button>
                </div>
              </GlassCard>
            ) : (
              filteredTimeline.map((item) => {
                const spark = downsample(item.envelope, 30);
                const sparkPath = buildSparklinePath(spark);

                return (
                  <motion.button
                    key={item.id}
                    type="button"
                    className={styles.timelineItem}
                    variants={fadeUp}
                    onClick={() => {
                      void openModal(item);
                    }}
                  >
                    <span className={styles.itemTop}>
                      <span className={styles.itemDate}>{formatTimestamp(item.createdAt)}</span>
                      <span className={styles.itemBadges}>
                        <Pill className={styles.scorePill}>Score {item.score}</Pill>
                        <Pill className={cx(styles.confidencePill, styles[`confidence-${item.confidence}`])}>
                          {confidenceLabel(item.confidence)}
                        </Pill>
                      </span>
                    </span>

                    <span className={styles.itemBody}>
                      <span className={styles.itemSummary}>{item.summary}</span>
                      <span className={styles.sparkWrap}>
                        <svg viewBox="0 0 96 30" className={styles.sparkline} aria-hidden>
                          <path d={sparkPath} className={styles.sparklinePath} />
                        </svg>
                      </span>
                    </span>

                    <span className={styles.itemFooter}>
                      <span>{item.baselineDelta}</span>
                      <span>{item.source === "local" ? "Local cache" : "Backboard memory"}</span>
                    </span>
                  </motion.button>
                );
              })
            )}
          </motion.div>

          <motion.div variants={fadeUp} {...(reducedMotion ? {} : hoverGlow)} className={styles.footerActions}>
            <GlowButton type="button" onClick={() => router.push("/record")}>
              New Snapshot
            </GlowButton>
            <button type="button" className={styles.ghostButton} onClick={() => router.push("/results")}>
              Latest Results
            </button>
          </motion.div>
        </motion.section>

        <AnimatePresence>
          {selectedItem ? (
            <motion.div
              className={styles.modalOverlay}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={closeModal}
            >
              <motion.div
                className={styles.modal}
                variants={fadeUp}
                initial="hidden"
                animate="visible"
                exit="hidden"
                onClick={(event) => event.stopPropagation()}
              >
                <div className={styles.modalTop}>
                  <SectionTitle as="h2" className={styles.modalTitle}>
                    {formatTimestamp(selectedItem.createdAt)}
                  </SectionTitle>
                  <button type="button" className={styles.modalClose} onClick={closeModal}>
                    Close
                  </button>
                </div>

                <div className={styles.modalVideoWrap}>
                  {videoLoading ? <div className={styles.modalFallback}>Loading replay...</div> : null}
                  {!videoLoading && videoUrl ? (
                    <video ref={videoRef} className={styles.modalVideo} src={videoUrl} controls playsInline />
                  ) : null}
                  {!videoLoading && !videoUrl ? (
                    <div className={styles.modalFallback}>
                      <p>{videoError || "Video replay unavailable for this snapshot."}</p>
                    </div>
                  ) : null}
                </div>

                <Waveform
                  className={styles.modalWaveform}
                  envelope={selectedItem.envelope}
                  energy={selectedItem.energy}
                  duration={selectedDuration}
                  currentTime={videoCurrentTime}
                  interactive={!!videoUrl}
                  markers={selectedItem.markers}
                  onScrub={(time) => seekVideo(time)}
                  onMarkerClick={(marker) => seekVideo(marker.time, marker.label)}
                />

                <p className={styles.markerText}>
                  {markerLabel || `${formatTime(videoCurrentTime)} / ${formatTime(selectedDuration)} timeline`}
                </p>

                <div className={styles.summaryCard}>
                  <p className={styles.summaryLabel}>Clinician Summary</p>
                  <p className={styles.summaryText}>{selectedItem.summary}</p>
                  <div className={styles.summaryActions}>
                    <button type="button" className={styles.secondaryButton} onClick={handleReadAloud}>
                      {readAloudBusy ? "Stop Read Aloud" : "Read Aloud"}
                    </button>
                  </div>
                  {readAloudError ? <HintText className={styles.errorText}>{readAloudError}</HintText> : null}
                </div>
              </motion.div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </AppShell>
    </main>
  );
}
