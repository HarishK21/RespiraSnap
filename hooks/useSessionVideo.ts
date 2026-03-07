"use client";

import { useCallback, useEffect, useState } from "react";

export type SessionVideoSource = "record" | "upload";

export type SessionVideo = {
  blob: Blob;
  url: string;
  source: SessionVideoSource;
  fileName?: string;
  createdAt: number;
};

let currentVideo: SessionVideo | null = null;
const subscribers = new Set<(value: SessionVideo | null) => void>();

function notifySubscribers() {
  subscribers.forEach((subscriber) => subscriber(currentVideo));
}

function safelyRevokeBlobUrl(url: string | undefined) {
  if (!url || !url.startsWith("blob:")) return;
  URL.revokeObjectURL(url);
}

export function useSessionVideo() {
  const [sessionVideo, setSessionVideoState] = useState<SessionVideo | null>(currentVideo);

  useEffect(() => {
    const subscriber = (nextValue: SessionVideo | null) => {
      setSessionVideoState(nextValue);
    };

    subscribers.add(subscriber);
    return () => {
      subscribers.delete(subscriber);
    };
  }, []);

  const setSessionVideo = useCallback((nextVideo: SessionVideo | null) => {
    if (currentVideo?.url && currentVideo.url !== nextVideo?.url) {
      safelyRevokeBlobUrl(currentVideo.url);
    }

    currentVideo = nextVideo;
    notifySubscribers();
  }, []);

  const clearSessionVideo = useCallback(() => {
    setSessionVideo(null);
  }, [setSessionVideo]);

  return {
    sessionVideo,
    setSessionVideo,
    clearSessionVideo
  };
}
