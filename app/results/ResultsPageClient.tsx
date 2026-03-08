"use client";

import Waveform, { type WaveformMarker } from "@/components/audio/Waveform";
import AppShell from "@/components/layout/AppShell";
import { fadeIn, fadeUp, hoverGlow, staggerChildren } from "@/components/motion/presets";
import { Divider, GlassCard, GlowButton, HintText, Pill, SectionTitle } from "@/components/ui/primitives";
import { useDemoMode } from "@/hooks/useDemoMode";
import { useDemoScript } from "@/hooks/useDemoScript";
import { useReducedMotionPref } from "@/hooks/useReducedMotionPref";
import { useSessionAnalysis } from "@/hooks/useSessionAnalysis";
import { useSessionVideo } from "@/hooks/useSessionVideo";
import type { SessionPillars } from "@/lib/analysisBundle";
import { AnimatePresence, motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./page.module.css";

type TileKey = "pattern" | "explainability" | "clinician";

const TREND_WIDTH = 360;
const TREND_HEIGHT = 112;
const REPORT_TITLE = "RespiraSnap Clinician Summary";
const DEBUG_WIDTH = 1000;
const DEBUG_HEIGHT = 120;

function cx(...classNames: Array<string | undefined | null | false>) {
  return classNames.filter(Boolean).join(" ");
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function formatTime(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatConfidenceLabel(value: "low" | "med" | "high") {
  if (value === "high") return "High confidence";
  if (value === "med") return "Medium confidence";
  return "Low confidence";
}

function fallbackPillars(score: number, markerCount: number): SessionPillars {
  const rhythmValue = score >= 82 ? "Stable" : score >= 68 ? "Slightly Variable" : "Variable";
  const interruptionCount = Math.max(0, Math.min(markerCount, 5));
  const quality = interruptionCount <= 1 ? "Good" : interruptionCount <= 3 ? "Fair" : "Poor";

  return {
    rhythm: {
      shortLabel: "Rhythm",
      value: rhythmValue,
      tone: rhythmValue === "Stable" ? "good" : rhythmValue === "Slightly Variable" ? "warning" : "poor",
      subtext: "Cycle timing estimate from waveform.",
      cycleCount: 3,
      timingVariance: null,
      confidence: "low"
    },
    exhaleRatio: {
      shortLabel: "Exhale Ratio",
      value: "—",
      tone: "warning",
      subtext: "Segmentation needed for ratio.",
      ratio: null,
      uncertain: true,
      adherence: "Unknown",
      confidence: "low"
    },
    interruptions: {
      shortLabel: "Interruptions",
      value: String(interruptionCount),
      tone: quality === "Good" ? "good" : quality === "Fair" ? "warning" : "poor",
      subtext: `${quality} capture quality.`,
      count: interruptionCount,
      quality,
      timestamps: [],
      seconds: [],
      markerSeconds: [],
      lowConfidence: true,
      confidence: "low"
    },
    holdDetected: {
      shortLabel: "Hold",
      value: "Unclear",
      tone: "warning",
      subtext: "Low confidence.",
      enabled: true,
      detected: null,
      durationSeconds: null,
      markerTime: null,
      confidence: "low"
    }
  };
}

function pillarToneClass(tone: SessionPillars["rhythm"]["tone"]) {
  if (tone === "good") return styles.pillarToneGood;
  if (tone === "warning") return styles.pillarToneWarning;
  if (tone === "poor") return styles.pillarTonePoor;
  return styles.pillarToneNeutral;
}

function buildFallbackPatternBullets(pillars: SessionPillars) {
  return [
    `Rhythm: ${pillars.rhythm.value}`,
    `Exhale ratio: ${pillars.exhaleRatio.value}`,
    `Interruptions: ${pillars.interruptions.value} (quality: ${pillars.interruptions.quality.toLowerCase()})`
  ];
}

function buildDebugLine(values: number[], maxValue: number) {
  if (values.length === 0) return "";

  return values
    .map((value, index) => {
      const x = values.length === 1 ? DEBUG_WIDTH / 2 : (index / (values.length - 1)) * DEBUG_WIDTH;
      const ratio = maxValue > 0 ? clamp(value / maxValue, 0, 1) : 0;
      const y = DEBUG_HEIGHT - ratio * (DEBUG_HEIGHT - 8) - 4;
      return `${index === 0 ? "M" : "L"} ${x},${y}`;
    })
    .join(" ");
}

export default function ResultsPageClient() {
  const router = useRouter();

  const { reducedMotion, hasOverride, toggleReducedMotion } = useReducedMotionPref();
  const { demoMode, toggleDemoMode } = useDemoMode();
  const demoScript = useDemoScript();
  const { sessionVideo } = useSessionVideo();
  const { sessionAnalysis, analysisHistory } = useSessionAnalysis();

  const [videoCurrentTime, setVideoCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [activeMarkerLabel, setActiveMarkerLabel] = useState("");

  const [openTiles, setOpenTiles] = useState<Record<TileKey, boolean>>({
    pattern: true,
    explainability: true,
    clinician: true
  });

  const [reportText, setReportText] = useState(sessionAnalysis?.reportText ?? "");
  const [reportBusy, setReportBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState("");
  const [readAloudError, setReadAloudError] = useState("");
  const [readAloudBusy, setReadAloudBusy] = useState(false);
  const [showDebug, setShowDebug] = useState(false);

  const videoRef = useRef<HTMLAudioElement>(null);
  const reportAudioRef = useRef<HTMLAudioElement | null>(null);
  const reportAudioUrlRef = useRef<string | null>(null);
  const reportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const waveformDuration = useMemo(() => {
    const candidate = sessionAnalysis?.waveform.duration ?? 0;
    if (candidate > 0) return candidate;
    return videoDuration;
  }, [sessionAnalysis?.waveform.duration, videoDuration]);

  const pillars = useMemo(() => {
    if (!sessionAnalysis) return null;
    return sessionAnalysis.pillars ?? fallbackPillars(sessionAnalysis.score, sessionAnalysis.markers.length);
  }, [sessionAnalysis]);

  const isDevDebug = process.env.NODE_ENV !== "production";
  const preprocessDebug = sessionAnalysis?.preprocessDebug ?? null;

  const markers = useMemo<WaveformMarker[]>(() => {
    if (!sessionAnalysis) return [];
    return sessionAnalysis.markers.map((marker) => ({
      id: marker.id,
      time: marker.time,
      label: marker.label,
      type: marker.type,
      detail: marker.detail
    }));
  }, [sessionAnalysis]);

  const keyMomentMarker = useMemo(() => {
    if (!sessionAnalysis || markers.length === 0) return null;
    const keyTime = sessionAnalysis.keyMomentTime;

    return markers.reduce((closest, marker) => {
      if (!closest) return marker;
      const bestDistance = Math.abs(closest.time - keyTime);
      const candidateDistance = Math.abs(marker.time - keyTime);
      return candidateDistance < bestDistance ? marker : closest;
    }, markers[0] ?? null);
  }, [markers, sessionAnalysis]);

  const trendEntries = useMemo(() => {
    if (!sessionAnalysis) return [];

    const merged = [...analysisHistory];
    if (!merged.some((entry) => entry.createdAt === sessionAnalysis.createdAt)) {
      merged.push({
        createdAt: sessionAnalysis.createdAt,
        score: sessionAnalysis.score,
        envelope: sessionAnalysis.waveform.envelope,
        duration: sessionAnalysis.waveform.duration
      });
    }

    return merged.slice(-4);
  }, [analysisHistory, sessionAnalysis]);

  const trendPath = useMemo(() => {
    if (trendEntries.length === 0) return "";

    return trendEntries
      .map((entry, index) => {
        const x = trendEntries.length === 1 ? TREND_WIDTH / 2 : (index / (trendEntries.length - 1)) * TREND_WIDTH;
        const y = 16 + (1 - clamp(entry.score / 100, 0, 1)) * (TREND_HEIGHT - 32);
        return `${index === 0 ? "M" : "L"} ${x},${y}`;
      })
      .join(" ");
  }, [trendEntries]);

  const trendAreaPath = useMemo(() => {
    if (trendEntries.length === 0) return "";

    const points = trendEntries.map((entry, index) => {
      const x = trendEntries.length === 1 ? TREND_WIDTH / 2 : (index / (trendEntries.length - 1)) * TREND_WIDTH;
      const y = 16 + (1 - clamp(entry.score / 100, 0, 1)) * (TREND_HEIGHT - 32);
      return { x, y };
    });

    const top = points.map((point) => `${point.x},${point.y}`);
    const bottom = [...points]
      .reverse()
      .map((point) => `${point.x},${TREND_HEIGHT - 8}`);

    return `M ${top[0]} L ${top.slice(1).join(" ")} L ${bottom.join(" ")} Z`;
  }, [trendEntries]);

  const patternBullets = useMemo(() => {
    if (!sessionAnalysis || !pillars) return [] as string[];
    return (sessionAnalysis.patternBullets?.length ? sessionAnalysis.patternBullets : buildFallbackPatternBullets(pillars))
      .slice(0, 3);
  }, [pillars, sessionAnalysis]);

  const reportPreviewText = useMemo(() => {
    if (reportText.trim()) return reportText;
    return sessionAnalysis?.reportLines?.join("\n") ?? "";
  }, [reportText, sessionAnalysis?.reportLines]);

  const debugChart = useMemo(() => {
    if (!preprocessDebug?.rmsSmooth?.length) return null;

    const rms = preprocessDebug.rmsSmooth;
    const threshold = preprocessDebug.threshold?.length
      ? preprocessDebug.threshold
      : Array.from({ length: rms.length }, () => 0);
    const maxValue = Math.max(
      ...rms,
      ...threshold,
      0.0001
    );

    return {
      rmsPath: buildDebugLine(rms, maxValue),
      thresholdPath: buildDebugLine(threshold, maxValue),
      interruptions: preprocessDebug.interruptions ?? []
    };
  }, [preprocessDebug]);

  const stopReadAloud = useCallback(() => {
    if (reportAudioRef.current) {
      reportAudioRef.current.pause();
      reportAudioRef.current.currentTime = 0;
      reportAudioRef.current = null;
    }

    if (reportAudioUrlRef.current) {
      URL.revokeObjectURL(reportAudioUrlRef.current);
      reportAudioUrlRef.current = null;
    }

    setReadAloudBusy(false);
  }, []);

  const seekVideo = useCallback(
    (nextTime: number, reason: "scrub" | "marker" | "key", label?: string) => {
      const duration = waveformDuration || sessionAnalysis?.waveform.duration || 0;
      const clampedTime = clamp(nextTime, 0, Math.max(0, duration));

      if (videoRef.current) {
        videoRef.current.currentTime = clampedTime;
      }

      setVideoCurrentTime(clampedTime);

      if (reason === "marker" && label) {
        setActiveMarkerLabel(label);
      } else if (reason === "key") {
        setActiveMarkerLabel(`Key moment · ${formatTime(clampedTime)}`);
      }
    },
    [sessionAnalysis?.waveform.duration, waveformDuration]
  );

  const toggleTile = useCallback((key: TileKey) => {
    setOpenTiles((previous) => ({
      ...previous,
      [key]: !previous[key]
    }));
  }, []);

  const handleGenerateReport = useCallback(() => {
    if (!sessionAnalysis) return;

    if (reportTimerRef.current) {
      clearTimeout(reportTimerRef.current);
    }

    setReportBusy(true);
    setActionMessage("");

    reportTimerRef.current = setTimeout(
      () => {
        const nextReport = sessionAnalysis.reportText || sessionAnalysis.reportLines?.join("\n") || "";
        setReportText(nextReport);
        setReportBusy(false);
        if (demoMode) {
          demoScript.completeStep("report");
        }
        setActionMessage("Structured report updated.");
      },
      reducedMotion ? 40 : 220
    );
  }, [demoMode, demoScript, reducedMotion, sessionAnalysis]);

  const handleCopyReport = useCallback(async () => {
    if (!reportPreviewText) return;

    try {
      await navigator.clipboard.writeText(reportPreviewText);
      setActionMessage("Report copied.");
    } catch {
      setActionMessage("Clipboard is unavailable in this browser.");
    }
  }, [reportPreviewText]);

  const handleDownloadPdf = useCallback(async () => {
    if (!reportPreviewText) return;

    try {
      const { jsPDF } = await import("jspdf");
      const doc = new jsPDF({
        unit: "pt",
        format: "letter"
      });

      doc.setFont("helvetica", "bold");
      doc.setFontSize(16);
      doc.text(REPORT_TITLE, 48, 56);

      doc.setFont("helvetica", "normal");
      doc.setFontSize(11);
      const lines = doc.splitTextToSize(reportPreviewText, 510);
      doc.text(lines, 48, 82);
      doc.save(`respirasnap-report-${Date.now()}.pdf`);
      setActionMessage("PDF downloaded.");
    } catch {
      setActionMessage("Unable to generate PDF.");
    }
  }, [reportPreviewText]);

  const handleReadAloud = useCallback(async () => {
    if (!reportPreviewText) return;

    if (readAloudBusy) {
      stopReadAloud();
      return;
    }

    setReadAloudError("");
    setActionMessage("");
    setReadAloudBusy(true);

    try {
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          text: reportPreviewText.slice(0, 3200)
        })
      });

      if (!response.ok) {
        let detail = "Report read aloud is unavailable.";
        try {
          const payload = (await response.json()) as { error?: string };
          if (payload.error) detail = payload.error;
        } catch {
          // Keep fallback detail.
        }

        throw new Error(detail);
      }

      const audioBlob = await response.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      reportAudioUrlRef.current = audioUrl;

      const audio = new Audio(audioUrl);
      reportAudioRef.current = audio;

      audio.onended = () => {
        stopReadAloud();
      };

      await audio.play();
      if (demoMode) {
        demoScript.completeStep("readAloud");
      }
      setActionMessage("Reading structured report aloud.");
    } catch (error) {
      stopReadAloud();
      setReadAloudError(error instanceof Error ? error.message : "Unable to play report audio.");
    }
  }, [demoMode, demoScript, readAloudBusy, reportPreviewText, stopReadAloud]);

  useEffect(() => {
    if (!sessionAnalysis) return;
    const next = sessionAnalysis.reportText || sessionAnalysis.reportLines?.join("\n") || "";
    setReportText(next);
  }, [sessionAnalysis?.createdAt, sessionAnalysis?.reportLines, sessionAnalysis?.reportText, sessionAnalysis]);

  useEffect(() => {
    const audio = videoRef.current;
    if (!audio) return;

    if (sessionVideo?.url) {
      audio.src = sessionVideo.url;
      audio.controls = true;
      audio.preload = "metadata";
      return;
    }

    audio.removeAttribute("src");
    audio.load();
  }, [sessionVideo?.url]);

  useEffect(() => {
    const audio = videoRef.current;
    if (!audio) return;

    const updateCurrentTime = () => {
      setVideoCurrentTime(Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
    };

    const updateDuration = () => {
      const nextDuration = Number.isFinite(audio.duration) ? audio.duration : 0;
      setVideoDuration(nextDuration);
    };

    audio.addEventListener("timeupdate", updateCurrentTime);
    audio.addEventListener("loadedmetadata", updateDuration);
    audio.addEventListener("durationchange", updateDuration);
    audio.addEventListener("seeking", updateCurrentTime);

    return () => {
      audio.removeEventListener("timeupdate", updateCurrentTime);
      audio.removeEventListener("loadedmetadata", updateDuration);
      audio.removeEventListener("durationchange", updateDuration);
      audio.removeEventListener("seeking", updateCurrentTime);
    };
  }, [sessionVideo?.url]);

  useEffect(() => {
    return () => {
      stopReadAloud();
      if (reportTimerRef.current) {
        clearTimeout(reportTimerRef.current);
      }
    };
  }, [stopReadAloud]);

  if (!sessionAnalysis || !pillars) {
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
          <GlassCard className={styles.emptyCard}>
            <SectionTitle as="h1" className={styles.emptyTitle}>
              No breathing snapshot results yet
            </SectionTitle>
            <HintText className={styles.emptyHint}>
              Capture or upload a 15-second audio clip on Record, then run Analyze to populate this page.
            </HintText>
            <div className={styles.emptyActions}>
              <GlowButton type="button" onClick={() => router.push("/record")}>
                Go To Record
              </GlowButton>
              <button type="button" className={styles.ghostButton} onClick={() => router.push("/")}>
                Back Home
              </button>
            </div>
          </GlassCard>
        </AppShell>
      </main>
    );
  }

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
          <motion.div variants={fadeIn} className={styles.topGrid}>
            <GlassCard className={styles.scoreCard}>
              <Pill className={styles.scorePill}>Breathing Snapshot Score (0-100)</Pill>
              <p className={styles.scoreValue}>{sessionAnalysis.score}</p>
              <div className={styles.scoreMeta}>
                <Pill className={styles.metaPill}>{sessionAnalysis.deltaLabel}</Pill>
                <Pill className={cx(styles.metaPill, styles[`confidence-${sessionAnalysis.confidenceLabel}`])}>
                  {formatConfidenceLabel(sessionAnalysis.confidenceLabel)}
                </Pill>
                {pillars.interruptions.quality === "Noisy" ? (
                  <Pill className={cx(styles.metaPill, styles.noisyPill)}>Noisy capture (lower confidence)</Pill>
                ) : null}
              </div>
              <HintText className={styles.scoreHint}>{pillars.rhythm.subtext}</HintText>
            </GlassCard>

            <GlassCard className={styles.videoCard}>
              <div className={styles.videoTop}>
                <SectionTitle as="h2" className={styles.videoTitle}>
                  Audio Replay
                </SectionTitle>
                <Pill className={styles.timePill}>
                  {formatTime(videoCurrentTime)} / {formatTime(waveformDuration)}
                </Pill>
              </div>

              <div className={styles.videoFrame}>
                <audio ref={videoRef} className={styles.video} />
                {!sessionVideo ? (
                  <div className={styles.videoFallback}>
                    <p>Audio unavailable after refresh. Metrics and report still visible.</p>
                  </div>
                ) : null}
              </div>

              <div className={styles.videoActions}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => {
                    seekVideo(sessionAnalysis.keyMomentTime, "key");
                    if (keyMomentMarker) {
                      setActiveMarkerLabel(`${keyMomentMarker.label} · ${formatTime(keyMomentMarker.time)}`);
                    }
                  }}
                >
                  Jump To Key Moment
                </button>

                <button type="button" className={styles.ghostButton} onClick={() => router.push("/record")}>
                  New Snapshot
                </button>
              </div>
            </GlassCard>
          </motion.div>

          <motion.div variants={fadeIn} className={styles.pillarsSection}>
            <div className={styles.pillarsTop}>
              <SectionTitle as="h2" className={styles.pillarsTitle}>
                4 Pillars
              </SectionTitle>
              <Pill className={styles.metaPill}>Waveform-first metrics</Pill>
            </div>

            <motion.div className={styles.pillarGrid} variants={staggerChildren}>
              {[
                {
                  id: "rhythm",
                  label: pillars.rhythm.shortLabel,
                  value: pillars.rhythm.value,
                  subtext: pillars.rhythm.subtext,
                  tone: pillars.rhythm.tone
                },
                {
                  id: "exhale",
                  label: pillars.exhaleRatio.shortLabel,
                  value: pillars.exhaleRatio.value,
                  subtext: pillars.exhaleRatio.subtext,
                  tone: pillars.exhaleRatio.tone
                },
                {
                  id: "interruptions",
                  label: pillars.interruptions.shortLabel,
                  value: pillars.interruptions.value,
                  subtext: pillars.interruptions.subtext,
                  tone: pillars.interruptions.tone
                },
                {
                  id: "hold",
                  label: pillars.holdDetected.shortLabel,
                  value: pillars.holdDetected.value,
                  subtext: pillars.holdDetected.subtext,
                  tone: pillars.holdDetected.tone
                }
              ].map((pillar) => (
                <motion.div key={pillar.id} variants={fadeUp}>
                  <GlassCard className={cx(styles.pillarCard, pillarToneClass(pillar.tone))}>
                    <p className={styles.pillarLabel}>{pillar.label}</p>
                    <p className={styles.pillarValue}>{pillar.value}</p>
                    <p className={styles.pillarSubtext}>{pillar.subtext}</p>
                  </GlassCard>
                </motion.div>
              ))}
            </motion.div>
          </motion.div>

          <motion.div variants={fadeIn} className={styles.tileColumn}>
            <GlassCard className={styles.tile}>
              <button type="button" className={styles.tileHead} onClick={() => toggleTile("pattern")}>
                <SectionTitle as="h3" className={styles.tileTitle}>
                  Pattern Summary
                </SectionTitle>
                <span className={styles.tileToggle}>{openTiles.pattern ? "Collapse" : "Expand"}</span>
              </button>

              <AnimatePresence initial={false}>
                {openTiles.pattern ? (
                  <motion.div className={styles.tileBody} variants={fadeUp} initial="hidden" animate="visible" exit="hidden">
                    <ul className={styles.bulletList}>
                      {patternBullets.map((bullet) => (
                        <li key={bullet}>{bullet}</li>
                      ))}
                    </ul>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </GlassCard>

            <GlassCard className={styles.tile}>
              <button type="button" className={styles.tileHead} onClick={() => toggleTile("explainability")}>
                <SectionTitle as="h3" className={styles.tileTitle}>
                  Explainability
                </SectionTitle>
                <span className={styles.tileToggle}>{openTiles.explainability ? "Collapse" : "Expand"}</span>
              </button>

              <AnimatePresence initial={false}>
                {openTiles.explainability ? (
                  <motion.div className={styles.tileBody} variants={fadeUp} initial="hidden" animate="visible" exit="hidden">
                    <Waveform
                      className={styles.waveform}
                      envelope={sessionAnalysis.waveform.envelope}
                      energy={sessionAnalysis.waveform.energy}
                      baselineEnvelope={sessionAnalysis.baselineEnvelope}
                      duration={waveformDuration}
                      currentTime={videoCurrentTime}
                      interactive
                      markers={markers}
                      onScrub={(nextTime) => seekVideo(nextTime, "scrub")}
                      onMarkerClick={(marker) => {
                        if (demoMode) {
                          demoScript.completeStep("markers");
                        }
                        const line = `${marker.label}${marker.detail ? ` · ${marker.detail}` : ""} · ${formatTime(marker.time)}`;
                        setActiveMarkerLabel(line);
                        seekVideo(marker.time, "marker", line);
                      }}
                    />

                    <p className={styles.markerTooltip}>
                      {activeMarkerLabel || "Marker tooltip: click a marker for one-line detail."}
                    </p>

                    <div className={styles.legendRow}>
                      <span className={styles.legendItem}>
                        <span className={cx(styles.legendDot, styles.legendRhythm)} />
                        Rhythm markers (cycle boundaries)
                      </span>
                      <span className={styles.legendItem}>
                        <span className={cx(styles.legendDot, styles.legendSegment)} />
                        Inhale/Exhale segments
                      </span>
                      <span className={styles.legendItem}>
                        <span className={cx(styles.legendDot, styles.legendInterrupt)} />
                        Interruption markers
                      </span>
                      <span className={styles.legendItem}>
                        <span className={cx(styles.legendDot, styles.legendHold)} />
                        {pillars.holdDetected.enabled ? "Hold window marker" : "Hold marker (guide off)"}
                      </span>
                    </div>

                    <Divider className={styles.tileDivider} />

                    <div className={styles.densityWrap}>
                      <p className={styles.densityLabel}>Event density</p>
                      <div className={styles.densityBars}>
                        {sessionAnalysis.eventDensity.map((value, index) => {
                          const totalBins = Math.max(sessionAnalysis.eventDensity.length, 1);
                          const binTime = (index / totalBins) * waveformDuration;
                          return (
                            <button
                              key={`density-${index}`}
                              type="button"
                              className={styles.densityBar}
                              style={{ height: `${Math.max(14, value * 100)}%` }}
                              onClick={() => {
                                if (demoMode) {
                                  demoScript.completeStep("markers");
                                }
                                const line = `Density bin ${index + 1} · ${formatTime(binTime)}`;
                                setActiveMarkerLabel(line);
                                seekVideo(binTime, "marker", line);
                              }}
                              aria-label={`Seek density segment ${index + 1}`}
                            />
                          );
                        })}
                      </div>
                    </div>

                    {isDevDebug && preprocessDebug ? (
                      <div className={styles.debugWrap}>
                        <button
                          type="button"
                          className={styles.debugToggle}
                          onClick={() => setShowDebug((value) => !value)}
                        >
                          Debug {showDebug ? "On" : "Off"}
                        </button>

                        {showDebug && debugChart ? (
                          <div className={styles.debugChartWrap}>
                            <svg
                              className={styles.debugChart}
                              viewBox={`0 0 ${DEBUG_WIDTH} ${DEBUG_HEIGHT}`}
                              preserveAspectRatio="none"
                              aria-hidden
                            >
                              {debugChart.interruptions.map((segment, index) => {
                                const startRatio = waveformDuration > 0 ? clamp(segment.tStart / waveformDuration, 0, 1) : 0;
                                const endRatio = waveformDuration > 0 ? clamp(segment.tEnd / waveformDuration, startRatio, 1) : startRatio;
                                const x = startRatio * DEBUG_WIDTH;
                                const width = Math.max(1, (endRatio - startRatio) * DEBUG_WIDTH);
                                return (
                                  <rect
                                    key={`dbg-interrupt-${index}`}
                                    x={x}
                                    y="0"
                                    width={width}
                                    height={DEBUG_HEIGHT}
                                    className={styles.debugInterruption}
                                  />
                                );
                              })}
                              {debugChart.thresholdPath ? <path d={debugChart.thresholdPath} className={styles.debugThreshold} /> : null}
                              {debugChart.rmsPath ? <path d={debugChart.rmsPath} className={styles.debugRms} /> : null}
                            </svg>
                            <p className={styles.debugCaption}>RMS smooth + threshold + detected interruption windows</p>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </GlassCard>

            <GlassCard className={styles.tile}>
              <button type="button" className={styles.tileHead} onClick={() => toggleTile("clinician")}>
                <SectionTitle as="h3" className={styles.tileTitle}>
                  Clinician Summary
                </SectionTitle>
                <span className={styles.tileToggle}>{openTiles.clinician ? "Collapse" : "Expand"}</span>
              </button>

              <AnimatePresence initial={false}>
                {openTiles.clinician ? (
                  <motion.div className={styles.tileBody} variants={fadeUp} initial="hidden" animate="visible" exit="hidden">
                    <div className={styles.reportActions}>
                      <GlowButton type="button" onClick={handleGenerateReport} disabled={reportBusy}>
                        {reportBusy ? "Generating..." : "Generate Report"}
                      </GlowButton>
                      <button type="button" className={styles.secondaryButton} onClick={handleCopyReport} disabled={!reportPreviewText}>
                        Copy
                      </button>
                      <button type="button" className={styles.secondaryButton} onClick={handleDownloadPdf} disabled={!reportPreviewText}>
                        Download PDF
                      </button>
                      <button
                        type="button"
                        className={styles.secondaryButton}
                        onClick={handleReadAloud}
                        disabled={!reportPreviewText}
                      >
                        {readAloudBusy ? "Stop Audio" : "Read Aloud"}
                      </button>
                    </div>

                    {reportPreviewText ? <pre className={styles.reportPreview}>{reportPreviewText}</pre> : null}
                    {actionMessage ? <HintText className={styles.actionMessage}>{actionMessage}</HintText> : null}
                    {readAloudError ? <p className={styles.errorText}>{readAloudError}</p> : null}
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </GlassCard>
          </motion.div>

          <motion.div variants={fadeIn}>
            <GlassCard className={styles.trendCard}>
              <div className={styles.trendTop}>
                <SectionTitle as="h3" className={styles.trendTitle}>
                  Weekly Trend
                </SectionTitle>
                <Pill className={styles.metaPill}>Last 4 scores</Pill>
              </div>

              <div className={styles.trendChartWrap}>
                <svg
                  className={styles.trendChart}
                  viewBox={`0 0 ${TREND_WIDTH} ${TREND_HEIGHT}`}
                  preserveAspectRatio="none"
                  aria-hidden
                >
                  <line x1="0" y1={TREND_HEIGHT - 8} x2={TREND_WIDTH} y2={TREND_HEIGHT - 8} className={styles.trendAxis} />
                  {trendAreaPath ? <path d={trendAreaPath} className={styles.trendArea} /> : null}
                  {trendPath ? <path d={trendPath} className={styles.trendLine} /> : null}
                  {trendEntries.map((entry, index) => {
                    const x =
                      trendEntries.length === 1 ? TREND_WIDTH / 2 : (index / (trendEntries.length - 1)) * TREND_WIDTH;
                    const y = 16 + (1 - clamp(entry.score / 100, 0, 1)) * (TREND_HEIGHT - 32);
                    return <circle key={entry.createdAt} cx={x} cy={y} r="4" className={styles.trendPoint} />;
                  })}
                </svg>
              </div>

              <div className={styles.trendLabels}>
                {trendEntries.map((entry) => (
                  <span key={`score-${entry.createdAt}`} className={styles.trendLabel}>
                    {entry.score}
                  </span>
                ))}
              </div>

              <HintText className={styles.checkinCopy}>
                Next check-in: {sessionAnalysis.nextCheckInLabel}. Same time next week?
              </HintText>
            </GlassCard>
          </motion.div>

          <motion.div variants={fadeUp} {...(reducedMotion ? {} : hoverGlow)} className={styles.footerActions}>
            <GlowButton type="button" onClick={() => router.push("/record")}>
              Record Again
            </GlowButton>
            <button type="button" className={styles.ghostButton} onClick={() => router.push("/history")}>
              History
            </button>
            <button type="button" className={styles.ghostButton} onClick={() => router.push("/")}>
              Home
            </button>
          </motion.div>
        </motion.section>

        {demoMode && !demoScript.dismissed ? (
          <GlassCard className={styles.demoScript}>
            <div className={styles.demoScriptTop}>
              <p className={styles.demoScriptTitle}>Demo Script</p>
              <button type="button" className={styles.demoScriptDismiss} onClick={demoScript.dismiss}>
                Dismiss
              </button>
            </div>
            <ol className={styles.demoScriptList}>
              <li className={cx(styles.demoStep, demoScript.steps.loadSample && styles.demoStepDone)}>Load sample</li>
              <li className={cx(styles.demoStep, demoScript.steps.analyze && styles.demoStepDone)}>Analyze</li>
              <li className={cx(styles.demoStep, demoScript.steps.markers && styles.demoStepDone)}>
                Open explainability markers
              </li>
              <li className={cx(styles.demoStep, demoScript.steps.report && styles.demoStepDone)}>Generate clinician report</li>
              <li className={cx(styles.demoStep, demoScript.steps.readAloud && styles.demoStepDone)}>
                Play ElevenLabs read aloud
              </li>
            </ol>
            <HintText className={styles.demoScriptHint}>
              Progress {demoScript.completedCount}/{demoScript.totalCount}.
            </HintText>
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
