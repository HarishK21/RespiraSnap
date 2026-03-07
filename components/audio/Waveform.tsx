"use client";

import { useMemo, useRef, useState, type PointerEvent } from "react";
import styles from "./Waveform.module.css";

const SVG_WIDTH = 1000;
const SVG_HEIGHT = 132;
const MID_Y = SVG_HEIGHT / 2;
const MAX_AMPLITUDE = 50;

type WaveformMarker = {
  id: string;
  time: number;
  label: string;
};

type WaveformProps = {
  envelope: number[];
  energy: number[];
  baselineEnvelope?: number[] | null;
  duration: number;
  currentTime: number;
  markers?: WaveformMarker[];
  interactive?: boolean;
  live?: boolean;
  loading?: boolean;
  error?: string | null;
  onScrub?: (time: number) => void;
  onMarkerClick?: (marker: WaveformMarker) => void;
  className?: string;
};

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

function buildWaveAreaPath(values: number[]) {
  if (values.length === 0) return "";

  const safeValues = values.map((value) => clamp(value, 0, 1));
  const top: string[] = [];
  const bottom: string[] = [];

  safeValues.forEach((value, index) => {
    const x = safeValues.length === 1 ? SVG_WIDTH / 2 : (index / (safeValues.length - 1)) * SVG_WIDTH;
    const amplitude = value * MAX_AMPLITUDE;
    top.push(`${x},${MID_Y - amplitude}`);
    bottom.push(`${x},${MID_Y + amplitude}`);
  });

  return `M ${top[0]} L ${top.slice(1).join(" ")} L ${bottom.reverse().join(" ")} Z`;
}

function buildEnergyLinePath(values: number[]) {
  if (values.length === 0) return "";

  const safeValues = values.map((value) => clamp(value, 0, 1));

  return safeValues
    .map((value, index) => {
      const x = safeValues.length === 1 ? SVG_WIDTH / 2 : (index / (safeValues.length - 1)) * SVG_WIDTH;
      const y = 122 - value * 20;
      return `${index === 0 ? "M" : "L"} ${x},${y}`;
    })
    .join(" ");
}

export type { WaveformMarker };

export default function Waveform({
  envelope,
  energy,
  baselineEnvelope,
  duration,
  currentTime,
  markers = [],
  interactive = false,
  live = false,
  loading = false,
  error,
  onScrub,
  onMarkerClick,
  className
}: WaveformProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  const safeDuration = Math.max(0, duration || 0);
  const hasData = envelope.length > 1;

  const wavePath = useMemo(() => buildWaveAreaPath(envelope), [envelope]);
  const baselinePath = useMemo(
    () => (baselineEnvelope?.length ? buildWaveAreaPath(baselineEnvelope) : ""),
    [baselineEnvelope]
  );
  const energyPath = useMemo(() => buildEnergyLinePath(energy), [energy]);

  const progressRatio = safeDuration > 0 ? clamp(currentTime / safeDuration, 0, 1) : 0;
  const progressX = progressRatio * SVG_WIDTH;

  const seekFromClientX = (clientX: number) => {
    if (!interactive || !onScrub || !trackRef.current || safeDuration <= 0) return;

    const rect = trackRef.current.getBoundingClientRect();
    const relativeX = clamp(clientX - rect.left, 0, rect.width);
    const ratio = rect.width ? relativeX / rect.width : 0;
    onScrub(ratio * safeDuration);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!interactive || safeDuration <= 0) return;

    draggingRef.current = true;
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    seekFromClientX(event.clientX);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    seekFromClientX(event.clientX);
  };

  const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;

    draggingRef.current = false;
    setDragging(false);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div className={cx(styles.root, className)}>
      <div
        ref={trackRef}
        className={cx(styles.track, interactive && styles.trackInteractive)}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
      >
        {loading ? <div className={styles.trackLoading}>Extracting audio waveform...</div> : null}

        <svg className={styles.svg} viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`} preserveAspectRatio="none" aria-hidden>
          <line className={styles.midLine} x1="0" y1={MID_Y} x2={SVG_WIDTH} y2={MID_Y} />
          {baselinePath ? <path className={styles.baselineArea} d={baselinePath} /> : null}
          {hasData ? <path className={styles.waveArea} d={wavePath} /> : null}
          {energyPath ? <path className={styles.energyLine} d={energyPath} /> : null}
          {safeDuration > 0 ? <line className={styles.progressLine} x1={progressX} y1="0" x2={progressX} y2={SVG_HEIGHT} /> : null}
        </svg>

        {safeDuration > 0
          ? markers.map((marker) => {
              const leftPercent = clamp((marker.time / safeDuration) * 100, 0, 100);

              return (
                <button
                  key={marker.id}
                  type="button"
                  className={styles.markerButton}
                  style={{ left: `${leftPercent}%` }}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (onMarkerClick) {
                      onMarkerClick(marker);
                      return;
                    }
                    onScrub?.(marker.time);
                  }}
                >
                  <span className={styles.markerLabel}>{marker.label}</span>
                  <span className={styles.markerDot} />
                  <span className={styles.markerStem} />
                </button>
              );
            })
          : null}
      </div>

      <div className={styles.meta}>
        <span>{live ? "Live waveform" : "Waveform timeline"}</span>
        <span>
          {formatTime(currentTime)} / {formatTime(safeDuration)}{dragging ? " (scrubbing)" : ""}
        </span>
      </div>

      {error ? <p className={styles.error}>{error}</p> : null}
    </div>
  );
}
