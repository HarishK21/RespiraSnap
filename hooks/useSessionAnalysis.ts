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
    duration: value.duration
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

  return value as SessionAnalysis;
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

    const subscriber = (nextStore: SessionAnalysisStore) => {
      setSessionAnalysisState(nextStore.analysis);
      setAnalysisHistoryState(nextStore.history);
      setSessionSnapshotsState(nextStore.sessions);
    };

    subscribers.add(subscriber);
    return () => {
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
