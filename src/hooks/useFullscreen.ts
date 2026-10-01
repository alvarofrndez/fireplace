"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => Promise<void> | void;
};

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

const CHANGE_EVENTS = ["fullscreenchange", "webkitfullscreenchange"] as const;

function fullscreenElement(): Element | null {
  const doc = document as FullscreenDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

function isSupported(): boolean {
  const doc = document as FullscreenDocument;
  const el = document.documentElement as FullscreenElement;
  const enabled = doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled ?? false;
  return Boolean(enabled && (el.requestFullscreen || el.webkitRequestFullscreen));
}

function subscribe(callback: () => void): () => void {
  for (const name of CHANGE_EVENTS) document.addEventListener(name, callback);
  return () => {
    for (const name of CHANGE_EVENTS) document.removeEventListener(name, callback);
  };
}

const noopSubscribe = () => () => undefined;

export interface FullscreenControls {
  isFullscreen: boolean;
  supported: boolean;
  enter: () => Promise<void>;
  exit: () => Promise<void>;
  toggle: () => Promise<void>;
}

/** Fullscreen API (standard + WebKit prefix for Safari / iPadOS). */
export function useFullscreen(onChange?: (isFullscreen: boolean) => void): FullscreenControls {
  const isFullscreen = useSyncExternalStore(subscribe, () => fullscreenElement() !== null, () => false);
  const supported = useSyncExternalStore(noopSubscribe, isSupported, () => false);

  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const handler = () => onChangeRef.current?.(fullscreenElement() !== null);
    return subscribe(handler);
  }, []);

  const enter = useCallback(async () => {
    if (fullscreenElement()) return;
    const el = document.documentElement as FullscreenElement;
    try {
      if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: "hide" });
      else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
    } catch {
      /* denied (no user gesture, iframe, unsupported...) */
    }
  }, []);

  const exit = useCallback(async () => {
    if (!fullscreenElement()) return;
    const doc = document as FullscreenDocument;
    try {
      if (doc.exitFullscreen) await doc.exitFullscreen();
      else if (doc.webkitExitFullscreen) await doc.webkitExitFullscreen();
    } catch {
      /* ignore */
    }
  }, []);

  const toggle = useCallback(() => (fullscreenElement() ? exit() : enter()), [enter, exit]);

  return { isFullscreen, supported, enter, exit, toggle };
}
