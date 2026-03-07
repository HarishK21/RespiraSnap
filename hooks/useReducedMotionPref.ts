"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "respira:reduced-motion";

type ReducedMotionOverride = boolean | null;

function getStoredOverride(): ReducedMotionOverride {
  if (typeof window === "undefined") return null;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "true") return true;
  if (stored === "false") return false;
  return null;
}

export function useReducedMotionPref() {
  const [systemPrefersReduced, setSystemPrefersReduced] = useState(false);
  const [override, setOverride] = useState<ReducedMotionOverride>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const applyMediaQuery = () => {
      setSystemPrefersReduced(mediaQuery.matches);
    };

    applyMediaQuery();
    setOverride(getStoredOverride());

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", applyMediaQuery);
      return () => mediaQuery.removeEventListener("change", applyMediaQuery);
    }

    mediaQuery.addListener(applyMediaQuery);
    return () => mediaQuery.removeListener(applyMediaQuery);
  }, []);

  const reducedMotion = useMemo(() => {
    return override ?? systemPrefersReduced;
  }, [override, systemPrefersReduced]);

  const setReducedMotion = useCallback((nextValue: boolean) => {
    setOverride(nextValue);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, String(nextValue));
    }
  }, []);

  const toggleReducedMotion = useCallback(() => {
    setReducedMotion(!reducedMotion);
  }, [reducedMotion, setReducedMotion]);

  const clearOverride = useCallback(() => {
    setOverride(null);
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  return {
    reducedMotion,
    systemPrefersReduced,
    hasOverride: override !== null,
    setReducedMotion,
    toggleReducedMotion,
    clearOverride
  };
}
