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

    let cancelled = false;

    fetch("/api/user/preferences", {
      method: "GET",
      headers: {
        "content-type": "application/json"
      },
      cache: "no-store"
    })
      .then(async (response) => {
        if (!response.ok) return null;
        const payload = (await response.json()) as { preferences?: { demoMode?: boolean } };
        return payload.preferences;
      })
      .then((preferences) => {
        if (cancelled || typeof preferences?.demoMode !== "boolean") return;
        setDemoMode(preferences.demoMode);
        if (typeof window !== "undefined") {
          window.localStorage.setItem(STORAGE_KEY, String(preferences.demoMode));
        }
      })
      .catch(() => {
        // Ignore unauthenticated/offline states.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const updateDemoMode = useCallback((nextValue: boolean) => {
    setDemoMode(nextValue);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, String(nextValue));
    }

    void fetch("/api/user/preferences", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        demoMode: nextValue
      })
    }).catch(() => {
      // Ignore sync failures; local state still works.
    });
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
