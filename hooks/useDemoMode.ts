"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "respira:demo-mode";

function readStoredValue() {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(STORAGE_KEY) === "true";
}

export function useDemoMode() {
  const [demoMode, setDemoMode] = useState(false);

  useEffect(() => {
    setDemoMode(readStoredValue());
  }, []);

  const updateDemoMode = useCallback((nextValue: boolean) => {
    setDemoMode(nextValue);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, String(nextValue));
    }
  }, []);

  const toggleDemoMode = useCallback(() => {
    updateDemoMode(!demoMode);
  }, [demoMode, updateDemoMode]);

  return {
    demoMode,
    setDemoMode: updateDemoMode,
    toggleDemoMode
  };
}
