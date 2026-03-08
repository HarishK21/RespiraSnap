"use client";

const TRANSIENT_LOCAL_KEYS = [
  "respira:current-capture:v1",
  "respira:pending-auto-analyze:v1",
  "respira:last-capture:v1",
  "respira:record:auto-analyze-session-id:v1"
];

const TRANSIENT_SESSION_KEYS = [
  "respira:current-capture:v1",
  "respira:pending-auto-analyze:v1",
  "respira:last-capture:v1",
  "respira:record:auto-analyze-session-id:v1"
];

function clearKeys(storage: Storage | undefined, keys: string[]) {
  if (!storage) return;

  keys.forEach((key) => {
    try {
      storage.removeItem(key);
    } catch {
      // Ignore storage cleanup failures.
    }
  });
}

export function clearCurrentSession() {
  if (typeof window === "undefined") return;

  clearKeys(window.localStorage, TRANSIENT_LOCAL_KEYS);
  clearKeys(window.sessionStorage, TRANSIENT_SESSION_KEYS);
}

