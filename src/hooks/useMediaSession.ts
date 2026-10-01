"use client";

import { useEffect, useRef } from "react";

/** Hardware media keys / lock screen controls (play & pause). */
export function useMediaSession(enabled: boolean, playing: boolean, onPlay: () => void, onPause: () => void): void {
  const handlers = useRef({ onPlay, onPause });
  useEffect(() => {
    handlers.current = { onPlay, onPause };
  }, [onPlay, onPause]);

  useEffect(() => {
    if (!enabled || typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    try {
      session.metadata = new MediaMetadata({
        title: "Fireplace",
        artist: "Ambient Fireplace",
        artwork: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      });
      session.setActionHandler("play", () => handlers.current.onPlay());
      session.setActionHandler("pause", () => handlers.current.onPause());
    } catch {
      /* partial support */
    }
    return () => {
      try {
        session.setActionHandler("play", null);
        session.setActionHandler("pause", null);
      } catch {
        /* ignore */
      }
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  }, [enabled, playing]);
}
