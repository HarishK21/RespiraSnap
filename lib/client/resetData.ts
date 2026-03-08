"use client";

const KNOWN_LOCAL_KEYS = [
  "respira:device-id",
  "respira:backboard-assistant-id",
  "respira:backboard-thread-id",
  "respira:session-analysis:v1",
  "respira:demo-mode",
  "respira:demo-script:v1",
  "respira:reduced-motion"
];

const PREFIX = "respira:";
const VIDEO_ARCHIVE_DB = "respira-snap";

function removeKnownAndPrefixed(storage: Storage) {
  KNOWN_LOCAL_KEYS.forEach((key) => {
    storage.removeItem(key);
  });

  const keysToRemove: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key && key.startsWith(PREFIX)) {
      keysToRemove.push(key);
    }
  }

  keysToRemove.forEach((key) => {
    storage.removeItem(key);
  });
}

function deleteIndexedDb(name: string) {
  return new Promise<void>((resolve) => {
    if (typeof window === "undefined" || !("indexedDB" in window)) {
      resolve();
      return;
    }

    try {
      const request = window.indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function clearClientRespiraData() {
  if (typeof window === "undefined") return;

  try {
    removeKnownAndPrefixed(window.localStorage);
  } catch {
    // Ignore storage clearing failures.
  }

  try {
    removeKnownAndPrefixed(window.sessionStorage);
  } catch {
    // Ignore storage clearing failures.
  }

  await deleteIndexedDb(VIDEO_ARCHIVE_DB);
}
