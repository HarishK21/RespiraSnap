"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

const DEVICE_ID_KEY = "respira:device-id";
const ASSISTANT_ID_KEY = "respira:backboard-assistant-id";
const THREAD_ID_KEY = "respira:backboard-thread-id";

type BackboardContext = {
  assistantId: string;
  threadId: string;
};

function generateId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `device-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

function readStorageValue(key: string) {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(key) ?? "";
}

export function useBackboardIdentity() {
  const [deviceId, setDeviceId] = useState("");
  const [assistantId, setAssistantId] = useState("");
  const [threadId, setThreadId] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") return;

    let storedDeviceId = readStorageValue(DEVICE_ID_KEY);
    if (!storedDeviceId) {
      storedDeviceId = generateId();
      window.localStorage.setItem(DEVICE_ID_KEY, storedDeviceId);
    }

    setDeviceId(storedDeviceId);
    setAssistantId(readStorageValue(ASSISTANT_ID_KEY));
    setThreadId(readStorageValue(THREAD_ID_KEY));
  }, []);

  const setBackboardContext = useCallback((context: Partial<BackboardContext>) => {
    if (typeof window === "undefined") return;

    if (context.assistantId) {
      window.localStorage.setItem(ASSISTANT_ID_KEY, context.assistantId);
      setAssistantId(context.assistantId);
    }

    if (context.threadId) {
      window.localStorage.setItem(THREAD_ID_KEY, context.threadId);
      setThreadId(context.threadId);
    }
  }, []);

  const clearBackboardContext = useCallback(() => {
    if (typeof window === "undefined") return;

    window.localStorage.removeItem(ASSISTANT_ID_KEY);
    window.localStorage.removeItem(THREAD_ID_KEY);
    setAssistantId("");
    setThreadId("");
  }, []);

  const isReady = useMemo(() => !!deviceId, [deviceId]);

  return {
    deviceId,
    assistantId,
    threadId,
    isReady,
    setBackboardContext,
    clearBackboardContext
  };
}
