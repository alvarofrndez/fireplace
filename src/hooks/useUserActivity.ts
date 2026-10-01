"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Options {
  /** Milliseconds without interaction before becoming idle. */
  timeout: number;
  enabled: boolean;
  /** While true the user is considered active (hovering the controls, paused...). */
  hold: boolean;
}

/** Ignore tiny pointer jitter (TV remotes, sensitive mice). */
const MOVE_THRESHOLD = 4;

/**
 * Tracks whether the user has interacted recently (pointer, touch, keyboard).
 * Used to fade the controls and the cursor out when nobody is touching anything.
 */
export function useUserActivity({ timeout, enabled, hold }: Options): { active: boolean; poke: () => void } {
  const [active, setActive] = useState(true);
  const timer = useRef<number | null>(null);
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const holdRef = useRef(hold);

  const schedule = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (!holdRef.current) setActive(false);
    }, timeout);
  }, [timeout]);

  const poke = useCallback(() => {
    setActive(true);
    schedule();
  }, [schedule]);

  useEffect(() => {
    holdRef.current = hold;
    if (!hold) schedule();
  }, [hold, schedule]);

  useEffect(() => {
    if (!enabled) return;
    const onMove = (event: PointerEvent) => {
      const last = lastPointer.current;
      lastPointer.current = { x: event.clientX, y: event.clientY };
      if (last && Math.abs(event.clientX - last.x) < MOVE_THRESHOLD && Math.abs(event.clientY - last.y) < MOVE_THRESHOLD) {
        return;
      }
      poke();
    };
    const onInput = () => poke();
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", onInput, { passive: true });
    window.addEventListener("keydown", onInput);
    window.addEventListener("wheel", onInput, { passive: true });
    window.addEventListener("touchstart", onInput, { passive: true });
    schedule();
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onInput);
      window.removeEventListener("keydown", onInput);
      window.removeEventListener("wheel", onInput);
      window.removeEventListener("touchstart", onInput);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, [enabled, poke, schedule]);

  return { active, poke };
}
