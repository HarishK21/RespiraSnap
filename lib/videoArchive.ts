"use client";

const DB_NAME = "respira-snap";
const DB_VERSION = 1;
const STORE_NAME = "archived-videos";

type ArchivedVideoRecord = {
  id: string;
  blob: Blob;
  updatedAt: number;
};

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof window === "undefined" || !("indexedDB" in window)) {
      reject(new Error("IndexedDB unavailable"));
      return;
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(request.error ?? new Error("Failed to open IndexedDB."));
    };
  });
}

export async function archiveVideoBlob(id: string, blob: Blob) {
  if (!id || !(blob instanceof Blob) || !blob.size) return;

  const db = await openDatabase();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);

    store.put({
      id,
      blob,
      updatedAt: Date.now()
    } satisfies ArchivedVideoRecord);

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Failed to write archived video."));
    tx.onabort = () => reject(tx.error ?? new Error("Archived video write aborted."));
  });

  db.close();
}

export async function readArchivedVideoBlob(id: string) {
  if (!id) return null;

  const db = await openDatabase();

  const record = await new Promise<ArchivedVideoRecord | null>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(id);

    request.onsuccess = () => {
      const value = request.result;
      resolve(value && typeof value === "object" ? (value as ArchivedVideoRecord) : null);
    };
    request.onerror = () => reject(request.error ?? new Error("Failed to read archived video."));
  });

  db.close();
  return record?.blob ?? null;
}

