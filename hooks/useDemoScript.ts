"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "respira:demo-script:v1";

export type DemoStepId = "loadSample" | "analyze" | "markers" | "report" | "readAloud";

export type DemoStepState = Record<DemoStepId, boolean>;

type DemoScriptState = {
  dismissed: boolean;
  steps: DemoStepState;
};

const DEFAULT_STEPS: DemoStepState = {
  loadSample: false,
  analyze: false,
  markers: false,
  report: false,
  readAloud: false
};

const DEFAULT_STATE: DemoScriptState = {
  dismissed: false,
  steps: DEFAULT_STEPS
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sanitizeSteps(value: unknown): DemoStepState {
  if (!isObject(value)) return DEFAULT_STEPS;

  return {
    loadSample: Boolean(value.loadSample),
    analyze: Boolean(value.analyze),
    markers: Boolean(value.markers),
    report: Boolean(value.report),
    readAloud: Boolean(value.readAloud)
  };
}

function readStoredState(): DemoScriptState {
  if (typeof window === "undefined") return DEFAULT_STATE;

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;

    const parsed = JSON.parse(raw) as { dismissed?: unknown; steps?: unknown };
    return {
      dismissed: Boolean(parsed.dismissed),
      steps: sanitizeSteps(parsed.steps)
    };
  } catch {
    return DEFAULT_STATE;
  }
}

function saveState(nextState: DemoScriptState) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
  } catch {
    // Ignore storage failures.
  }
}

export function useDemoScript() {
  const [state, setState] = useState<DemoScriptState>(DEFAULT_STATE);

  useEffect(() => {
    setState(readStoredState());
  }, []);

  const patchState = useCallback((updater: (previous: DemoScriptState) => DemoScriptState) => {
    setState((previous) => {
      const next = updater(previous);
      saveState(next);
      return next;
    });
  }, []);

  const completeStep = useCallback(
    (step: DemoStepId) => {
      patchState((previous) => ({
        ...previous,
        steps: {
          ...previous.steps,
          [step]: true
        }
      }));
    },
    [patchState]
  );

  const dismiss = useCallback(() => {
    patchState((previous) => ({
      ...previous,
      dismissed: true
    }));
  }, [patchState]);

  const show = useCallback(() => {
    patchState((previous) => ({
      ...previous,
      dismissed: false
    }));
  }, [patchState]);

  const reset = useCallback(() => {
    patchState(() => ({
      dismissed: false,
      steps: DEFAULT_STEPS
    }));
  }, [patchState]);

  const completedCount = Object.values(state.steps).filter(Boolean).length;

  return {
    dismissed: state.dismissed,
    steps: state.steps,
    completedCount,
    totalCount: 5,
    completeStep,
    dismiss,
    show,
    reset
  };
}

