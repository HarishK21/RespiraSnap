"use client";

import type { AnalysisHistoryEntry, SessionAnalysis } from "@/lib/analysisBundle";
import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "respira:session-analysis:v1";
const MAX_HISTORY = 24;
const MAX_SESSIONS = 24;

type SessionAnalysisStore = {
  analysis: SessionAnalysis | null;
  history: AnalysisHistoryEntry[];
  sessions: SessionAnalysis[];
};

const EMPTY_STORE: SessionAnalysisStore = {
  analysis: null,
  history: [],
  sessions: []
};

let currentStore: SessionAnalysisStore = EMPTY_STORE;
let hydrated = false;
const subscribers = new Set<(store: SessionAnalysisStore) => void>();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function safeString(value: unknown, fallback = "") {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeConfidence(value: unknown): "low" | "med" | "high" {
  const normalized = safeString(value).toLowerCase();
  if (normalized === "low" || normalized === "med" || normalized === "high") return normalized;
  return "low";
}

function parseTrendLabel(value: unknown): SessionAnalysis["trend"]["label"] | null {
  const normalized = safeString(value).toLowerCase();
  if (normalized === "improving") return "Improving";
  if (normalized === "stable") return "Stable";
  if (normalized === "worsening") return "Worsening";
  if (normalized === "baseline building") return "Baseline building";
  return null;
}

function parseDeltaValue(deltaLabel: string) {
  const match = deltaLabel.match(/[-+]?\d+/);
  if (!match) return 0;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : 0;
}

function classifyFallbackTrend(deltaValue: number): SessionAnalysis["trend"]["label"] {
  if (deltaValue >= 4) return "Improving";
  if (deltaValue <= -4) return "Worsening";
  return "Stable";
}

function sanitizeTrend(
  value: unknown,
  fallbackDeltaLabel: string,
  fallbackConfidence: "low" | "med" | "high"
): SessionAnalysis["trend"] {
  const parsed = isObject(value) ? value : {};
  const deltaLabel = safeString(parsed.deltaLabel, fallbackDeltaLabel);
  const deltaValue = isFiniteNumber(parsed.deltaValue) ? Math.round(parsed.deltaValue) : parseDeltaValue(deltaLabel);
  const comparedCount = isFiniteNumber(parsed.comparedCount) ? Math.max(0, Math.floor(parsed.comparedCount)) : 0;
  const comparedToLabel = safeString(
    parsed.comparedToLabel,
    comparedCount ? `Compared to your last ${comparedCount} sessions` : "Compared to your recent sessions"
  );
  const reason = safeString(parsed.reason);
  const pillarDeltaSummary = safeString(parsed.pillarDeltaSummary);
  const explicitLabel = parseTrendLabel(parsed.label);
  const label = explicitLabel ?? (comparedCount < 3 ? "Baseline building" : classifyFallbackTrend(deltaValue));
  const confidence = normalizeConfidence(parsed.confidence || fallbackConfidence);

  return {
    label,
    deltaValue,
    deltaLabel,
    confidence,
    comparedCount,
    comparedToLabel,
    reason,
    pillarDeltaSummary
  };
}

function sanitizeHistoryEntry(value: unknown): AnalysisHistoryEntry | null {
  if (!isObject(value)) return null;
  if (typeof value.createdAt !== "string") return null;
  if (!isFiniteNumber(value.score)) return null;
  if (!Array.isArray(value.envelope)) return null;
  if (!isFiniteNumber(value.duration)) return null;

  return {
    createdAt: value.createdAt,
    score: value.score,
    envelope: value.envelope.filter(isFiniteNumber).slice(0, 600),
    duration: value.duration,
    rhythmLabel:
      value.rhythmLabel === "Stable" || value.rhythmLabel === "Slightly Variable" || value.rhythmLabel === "Variable"
        ? value.rhythmLabel
        : undefined,
    exhaleRatio: value.exhaleRatio === null ? null : isFiniteNumber(value.exhaleRatio) ? value.exhaleRatio : undefined,
    interruptions: isFiniteNumber(value.interruptions) ? Math.max(0, Math.floor(value.interruptions)) : undefined,
    holdDetected: typeof value.holdDetected === "boolean" || value.holdDetected === null ? value.holdDetected : undefined,
    confidenceLabel:
      value.confidenceLabel === "low" || value.confidenceLabel === "med" || value.confidenceLabel === "high"
        ? value.confidenceLabel
        : undefined,
    qualityFlag:
      value.qualityFlag === "Good" ||
      value.qualityFlag === "Fair" ||
      value.qualityFlag === "Poor" ||
      value.qualityFlag === "Noisy"
        ? value.qualityFlag
        : undefined
  };
}

function sanitizeHistory(value: unknown): AnalysisHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => sanitizeHistoryEntry(item))
    .filter((item): item is AnalysisHistoryEntry => !!item)
    .slice(-MAX_HISTORY);
}

function sanitizeAnalysis(value: unknown): SessionAnalysis | null {
  if (!isObject(value)) return null;
  if (!isFiniteNumber(value.score)) return null;
  if (typeof value.reportText !== "string") return null;
  if (!isObject(value.waveform)) return null;

  const confidenceLabel = normalizeConfidence(value.confidenceLabel);
  const deltaLabel = safeString(value.deltaLabel, `${value.score >= 0 ? "+" : ""}${Math.round(value.score)} vs baseline`);
  const trend = sanitizeTrend(value.trend, deltaLabel, confidenceLabel);

  return {
    ...(value as SessionAnalysis),
    confidenceLabel,
    deltaLabel,
    trend
  };
}

function sanitizeSessions(value: unknown): SessionAnalysis[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => sanitizeAnalysis(item))
    .filter((item): item is SessionAnalysis => !!item)
    .slice(-MAX_SESSIONS);
}

function upsertSession(sessions: SessionAnalysis[], analysis: SessionAnalysis) {
  const deduped = sessions.filter((session) => session.createdAt !== analysis.createdAt);
  const next = [...deduped, analysis];

  next.sort((left, right) => {
    return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
  });

  return next.slice(0, MAX_SESSIONS);
}

function historyEntryFromSession(analysis: SessionAnalysis): AnalysisHistoryEntry {
  return {
    createdAt: analysis.createdAt,
    score: analysis.score,
    envelope: (analysis.waveform?.envelope ?? []).filter(isFiniteNumber).slice(0, 600),
    duration: isFiniteNumber(analysis.waveform?.duration) ? analysis.waveform.duration : 0,
    rhythmLabel: analysis.pillars?.rhythm?.value,
    exhaleRatio: analysis.pillars?.exhaleRatio?.ratio ?? null,
    interruptions: analysis.pillars?.interruptions?.count,
    holdDetected: analysis.pillars?.holdDetected?.detected ?? null,
    confidenceLabel: analysis.confidenceLabel,
    qualityFlag: analysis.pillars?.interruptions?.quality
  };
}

function mergeHistoryEntries(
  localHistory: AnalysisHistoryEntry[],
  remoteHistory: AnalysisHistoryEntry[],
  remoteSessions: SessionAnalysis[]
) {
  const fromSessions = remoteSessions.map((analysis) => historyEntryFromSession(analysis));
  const combined = [...localHistory, ...remoteHistory, ...fromSessions];
  const deduped = new Map<string, AnalysisHistoryEntry>();

  combined.forEach((entry) => {
    if (!entry?.createdAt) return;
    deduped.set(entry.createdAt, entry);
  });

  return Array.from(deduped.values())
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .slice(0, MAX_HISTORY);
}

type SnapshotApiPayload = {
  snapshots?: Array<{
    analysis?: unknown;
    historyEntry?: unknown;
  }>;
};

function readStoredState(): SessionAnalysisStore {
  if (typeof window === "undefined") return EMPTY_STORE;

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_STORE;

    const parsed = JSON.parse(raw) as { analysis?: unknown; history?: unknown };

    return {
      analysis: sanitizeAnalysis(parsed.analysis),
      history: sanitizeHistory(parsed.history),
      sessions: sanitizeSessions((parsed as { sessions?: unknown }).sessions)
    };
  } catch {
    return EMPTY_STORE;
  }
}

function persistState(store: SessionAnalysisStore) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Ignore storage failures.
  }
}

function notifySubscribers() {
  subscribers.forEach((subscriber) => subscriber(currentStore));
}

function commitStore(nextStore: SessionAnalysisStore) {
  currentStore = {
    analysis: nextStore.analysis,
    history: nextStore.history.slice(-MAX_HISTORY),
    sessions: nextStore.sessions.slice(0, MAX_SESSIONS)
  };
  persistState(currentStore);
  notifySubscribers();
}

export function useSessionAnalysis() {
  const [sessionAnalysis, setSessionAnalysisState] = useState<SessionAnalysis | null>(currentStore.analysis);
  const [analysisHistory, setAnalysisHistoryState] = useState<AnalysisHistoryEntry[]>(currentStore.history);
  const [sessionSnapshots, setSessionSnapshotsState] = useState<SessionAnalysis[]>(currentStore.sessions);

  useEffect(() => {
    if (!hydrated) {
      currentStore = readStoredState();
      hydrated = true;
    }

    setSessionAnalysisState(currentStore.analysis);
    setAnalysisHistoryState(currentStore.history);
    setSessionSnapshotsState(currentStore.sessions);

    const subscriber = (nextStore: SessionAnalysisStore) => {
      setSessionAnalysisState(nextStore.analysis);
      setAnalysisHistoryState(nextStore.history);
      setSessionSnapshotsState(nextStore.sessions);
    };

    subscribers.add(subscriber);

    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/user/snapshots?limit=${MAX_SESSIONS}`, {
          method: "GET",
          headers: {
            "content-type": "application/json"
          }
        });

        if (!response.ok || cancelled) return;

        const payload = (await response.json()) as SnapshotApiPayload;
        const snapshots = Array.isArray(payload.snapshots) ? payload.snapshots : [];
        if (!snapshots.length) return;

        const remoteSessions = snapshots
          .map((item) => sanitizeAnalysis(item.analysis))
          .filter((item): item is SessionAnalysis => !!item)
          .slice(0, MAX_SESSIONS);

        const remoteHistory = snapshots
          .map((item) => sanitizeHistoryEntry(item.historyEntry))
          .filter((item): item is AnalysisHistoryEntry => !!item)
          .slice(0, MAX_HISTORY);

        if (!remoteSessions.length && !remoteHistory.length) return;

        const nextSessions = [...currentStore.sessions];
        remoteSessions.forEach((session) => {
          const exists = nextSessions.some((item) => item.createdAt === session.createdAt);
          if (!exists) nextSessions.push(session);
        });

        nextSessions.sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
        const cappedSessions = nextSessions.slice(0, MAX_SESSIONS);
        const mergedHistory = mergeHistoryEntries(currentStore.history, remoteHistory, remoteSessions);
        const latestSession = cappedSessions[0] ?? null;

        commitStore({
          analysis: currentStore.analysis ?? latestSession,
          history: mergedHistory,
          sessions: cappedSessions
        });
      } catch {
        // Ignore server sync failures (unauthorized/offline/etc).
      }
    })();

    return () => {
      cancelled = true;
      subscribers.delete(subscriber);
    };
  }, []);

  const setSessionAnalysis = useCallback((analysis: SessionAnalysis | null, history?: AnalysisHistoryEntry[]) => {
    commitStore({
      analysis,
      history: history ? sanitizeHistory(history) : currentStore.history,
      sessions: analysis ? upsertSession(currentStore.sessions, analysis) : currentStore.sessions
    });
  }, []);

  const setAnalysisHistory = useCallback((history: AnalysisHistoryEntry[]) => {
    commitStore({
      analysis: currentStore.analysis,
      history: sanitizeHistory(history),
      sessions: currentStore.sessions
    });
  }, []);

  const clearSessionAnalysis = useCallback(() => {
    commitStore({
      analysis: null,
      history: currentStore.history,
      sessions: currentStore.sessions
    });
  }, []);

  const clearAllSessionAnalysis = useCallback(() => {
    commitStore(EMPTY_STORE);
  }, []);

  return {
    sessionAnalysis,
    analysisHistory,
    sessionSnapshots,
    setSessionAnalysis,
    setAnalysisHistory,
    clearSessionAnalysis,
    clearAllSessionAnalysis
  };
}
