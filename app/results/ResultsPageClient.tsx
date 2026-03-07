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
import { AnimatePresence, motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./page.module.css";

type TileKey = "pattern" | "explainability" | "clinician";

const TREND_WIDTH = 360;
const TREND_HEIGHT = 112;
const REPORT_TITLE = "RespiraSnap Clinician Summary";

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

  const videoRef = useRef<HTMLVideoElement>(null);
  const reportAudioRef = useRef<HTMLAudioElement | null>(null);
  const reportAudioUrlRef = useRef<string | null>(null);
  const reportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const waveformDuration = useMemo(() => {
    const candidate = sessionAnalysis?.waveform.duration ?? 0;
    if (candidate > 0) return candidate;
    return videoDuration;
  }, [sessionAnalysis?.waveform.duration, videoDuration]);

  const markers = useMemo<WaveformMarker[]>(() => {
    if (!sessionAnalysis) return [];
    return sessionAnalysis.markers.map((marker) => ({
      id: marker.id,
      time: marker.time,
      label: marker.label
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
        setActiveMarkerLabel(`${label} • ${formatTime(clampedTime)}`);
      } else if (reason === "key") {
        setActiveMarkerLabel(`Key moment • ${formatTime(clampedTime)}`);
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
        setReportText(sessionAnalysis.reportText);
        setReportBusy(false);
        if (demoMode) {
          demoScript.completeStep("report");
        }
        setActionMessage("Report refreshed from Backboard output.");
      },
      reducedMotion ? 40 : 260
    );
  }, [demoMode, demoScript, reducedMotion, sessionAnalysis]);

  const handleCopyReport = useCallback(async () => {
    if (!reportText) return;

    try {
      await navigator.clipboard.writeText(reportText);
      setActionMessage("Report copied.");
    } catch {
      setActionMessage("Clipboard is unavailable in this browser.");
    }
  }, [reportText]);

  const handleDownloadPdf = useCallback(async () => {
    if (!reportText) return;

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
      const lines = doc.splitTextToSize(reportText, 510);
      doc.text(lines, 48, 82);
      doc.save(`respirasnap-report-${Date.now()}.pdf`);
      setActionMessage("PDF downloaded.");
    } catch {
      setActionMessage("Unable to generate PDF.");
    }
  }, [reportText]);

  const handleReadAloud = useCallback(async () => {
    if (!reportText) return;

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
          text: reportText.slice(0, 3200)
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
      setActionMessage("Reading report aloud.");
    } catch (error) {
      stopReadAloud();
      setReadAloudError(error instanceof Error ? error.message : "Unable to play report audio.");
    }
  }, [demoMode, demoScript, readAloudBusy, reportText, stopReadAloud]);

  useEffect(() => {
    if (!sessionAnalysis) return;
    setReportText(sessionAnalysis.reportText);
  }, [sessionAnalysis?.createdAt, sessionAnalysis?.reportText, sessionAnalysis]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (sessionVideo?.url) {
      video.src = sessionVideo.url;
      video.controls = true;
      video.preload = "metadata";
      video.playsInline = true;
      return;
    }

    video.removeAttribute("src");
    video.load();
  }, [sessionVideo?.url]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const updateCurrentTime = () => {
      setVideoCurrentTime(Number.isFinite(video.currentTime) ? video.currentTime : 0);
    };

    const updateDuration = () => {
      const nextDuration = Number.isFinite(video.duration) ? video.duration : 0;
      setVideoDuration(nextDuration);
    };

    video.addEventListener("timeupdate", updateCurrentTime);
    video.addEventListener("loadedmetadata", updateDuration);
    video.addEventListener("durationchange", updateDuration);
    video.addEventListener("seeking", updateCurrentTime);

    return () => {
      video.removeEventListener("timeupdate", updateCurrentTime);
      video.removeEventListener("loadedmetadata", updateDuration);
      video.removeEventListener("durationchange", updateDuration);
      video.removeEventListener("seeking", updateCurrentTime);
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

  if (!sessionAnalysis) {
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
              Capture or upload a 15-second video on Record, then run Analyze to populate this page.
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
              </div>
              <HintText className={styles.scoreHint}>
                {sessionAnalysis.coachingTip || "Maintain a consistent pace for the next snapshot."}
              </HintText>
            </GlassCard>

            <GlassCard className={styles.videoCard}>
              <div className={styles.videoTop}>
                <SectionTitle as="h2" className={styles.videoTitle}>
                  Video Replay
                </SectionTitle>
                <Pill className={styles.timePill}>{formatTime(videoCurrentTime)} / {formatTime(waveformDuration)}</Pill>
              </div>

              <div className={styles.videoFrame}>
                <video ref={videoRef} className={styles.video} playsInline />
                {!sessionVideo ? (
                  <div className={styles.videoFallback}>
                    <p>Video not available after refresh. Waveform and report remain accessible.</p>
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
                      setActiveMarkerLabel(`${keyMomentMarker.label} • ${formatTime(keyMomentMarker.time)}`);
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
                  <motion.div
                    className={styles.tileBody}
                    variants={fadeUp}
                    initial="hidden"
                    animate="visible"
                    exit="hidden"
                  >
                    <p className={styles.bodyCopy}>{sessionAnalysis.patternSummary}</p>
                    <HintText className={styles.bodyHint}>{sessionAnalysis.followUpPrompt}</HintText>
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
                  <motion.div
                    className={styles.tileBody}
                    variants={fadeUp}
                    initial="hidden"
                    animate="visible"
                    exit="hidden"
                  >
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
                        seekVideo(marker.time, "marker", marker.label);
                      }}
                    />

                    <p className={styles.markerStatus}>
                      {activeMarkerLabel || "Click a marker to seek video and inspect that event."}
                    </p>

                    <div className={styles.legendRow}>
                      <span className={styles.legendItem}>
                        <span className={cx(styles.legendDot, styles.legendWave)} />
                        Waveform envelope
                      </span>
                      <span className={styles.legendItem}>
                        <span className={cx(styles.legendDot, styles.legendBaseline)} />
                        Baseline overlay
                      </span>
                      <span className={styles.legendItem}>
                        <span className={cx(styles.legendDot, styles.legendEvent)} />
                        Event marker
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
                                seekVideo(binTime, "marker", `Density ${index + 1}`);
                              }}
                              aria-label={`Seek density segment ${index + 1}`}
                            />
                          );
                        })}
                      </div>
                    </div>
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
                  <motion.div
                    className={styles.tileBody}
                    variants={fadeUp}
                    initial="hidden"
                    animate="visible"
                    exit="hidden"
                  >
                    <p className={styles.bodyCopy}>{sessionAnalysis.clinicianSummary}</p>

                    <div className={styles.reportActions}>
                      <GlowButton type="button" onClick={handleGenerateReport} disabled={reportBusy}>
                        {reportBusy ? "Generating..." : "Generate Report"}
                      </GlowButton>
                      <button type="button" className={styles.secondaryButton} onClick={handleCopyReport} disabled={!reportText}>
                        Copy
                      </button>
                      <button type="button" className={styles.secondaryButton} onClick={handleDownloadPdf} disabled={!reportText}>
                        Download PDF
                      </button>
                      <button
                        type="button"
                        className={styles.secondaryButton}
                        onClick={handleReadAloud}
                        disabled={!reportText}
                      >
                        {readAloudBusy ? "Stop Audio" : "Read Aloud"}
                      </button>
                    </div>

                    {reportText ? <pre className={styles.reportPreview}>{reportText}</pre> : null}
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
