"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { FireRenderer } from "@/lib/fire/FireRenderer";
import { FireAudioEngine, prepareFireAudio } from "@/lib/audio/FireAudioEngine";
import { getPreferences } from "@/lib/preferences";
import { usePreferences } from "@/hooks/usePreferences";
import { useFullscreen } from "@/hooks/useFullscreen";
import { useUserActivity } from "@/hooks/useUserActivity";
import { useWakeLock } from "@/hooks/useWakeLock";
import { useMediaSession } from "@/hooks/useMediaSession";
import { IntroScreen } from "../IntroScreen/IntroScreen";
import { ControlBar } from "../ControlBar/ControlBar";
import { SlidersIcon } from "../icons";
import styles from "./FireplaceApp.module.scss";

type Phase = "intro" | "running";

const IDLE_TIMEOUT = 3200;
const INTRO_FADE_MS = 1700;
const TOAST_MS = 3600;
const VOLUME_STEP = 0.05;

export default function FireplaceApp() {
  const rendererRef = useRef<FireRenderer | null>(null);
  const audioRef = useRef<FireAudioEngine | null>(null);
  const [phase, setPhase] = useState<Phase>("intro");
  const [introMounted, setIntroMounted] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [webglFailed, setWebglFailed] = useState(false);
  const [hold, setHold] = useState(false);
  const [toast, setToast] = useState({ text: "", visible: false });
  const toastTimer = useRef<number | null>(null);
  const [prefs, updatePrefs] = usePreferences();

  // Mirrors of the state for event handlers and engine callbacks. They are
  // written synchronously where the state changes, so anything created right
  // after a click (e.g. a canvas re-created during hydration) sees the truth.
  const phaseRef = useRef<Phase>("intro");
  const playingRef = useRef(false);
  const unloading = useRef(false);

  // Remember whether the user likes fullscreen (ignore the exit caused by closing the page).
  const {
    isFullscreen,
    supported: fullscreenSupported,
    enter: enterFullscreen,
    toggle: toggleFullscreenMode,
  } = useFullscreen(
    useCallback(
      (fullscreenNow: boolean) => {
        if (phaseRef.current === "running" && !unloading.current) updatePrefs({ fullscreen: fullscreenNow });
      },
      [updatePrefs],
    ),
  );

  const running = phase === "running";
  const { active: userActive, poke } = useUserActivity({
    timeout: IDLE_TIMEOUT,
    enabled: running,
    hold: hold || !playing,
  });
  useWakeLock(running && playing);

  // --------------------------------------------------------------- engines

  /** The WebGL renderer lives as long as the canvas element. */
  const attachCanvas = useCallback((canvas: HTMLCanvasElement | null) => {
    if (!canvas) return;
    let renderer: FireRenderer | null = null;
    try {
      renderer = new FireRenderer(canvas);
      if (phaseRef.current === "running") {
        // The canvas was re-created while the fire was already lit (e.g. hot reload).
        renderer.ignite();
        if (playingRef.current) renderer.play();
        else renderer.pause();
      } else {
        renderer.renderStill();
      }
    } catch (error) {
      console.warn("[Fireplace] No se pudo iniciar WebGL:", error);
      setWebglFailed(true);
    }
    rendererRef.current = renderer;
    return () => {
      renderer?.dispose();
      if (rendererRef.current === renderer) rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    // Synthesize the sound material while the user is looking at the intro.
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(() => prepareFireAudio(), { timeout: 2500 });
      return () => w.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(() => prepareFireAudio(), 700);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    const onPageHide = () => {
      unloading.current = true;
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onPageHide);
      audioRef.current?.dispose();
      audioRef.current = null;
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    };
  }, []);

  // ---------------------------------------------------------------- actions

  const showToast = useCallback((text: string) => {
    setToast({ text, visible: true });
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast((t) => ({ ...t, visible: false })), TOAST_MS);
  }, []);

  const start = useCallback(() => {
    if (phaseRef.current !== "intro") return;
    phaseRef.current = "running";
    playingRef.current = true;
    const current = getPreferences();
    // Audio has to be created synchronously inside the click to be allowed to play.
    if (!audioRef.current && FireAudioEngine.isSupported()) {
      try {
        audioRef.current = new FireAudioEngine({
          volume: current.volume,
          muted: current.muted,
          onPop: (strength, pan) => rendererRef.current?.sparkBurst(strength, pan),
        });
      } catch (error) {
        console.warn("[Fireplace] No se pudo iniciar el audio:", error);
      }
    }
    rendererRef.current?.ignite();
    rendererRef.current?.play();
    // Silently ignored where fullscreen is not available (e.g. iPhone).
    if (current.fullscreen) void enterFullscreen();
    setPlaying(true);
    setPhase("running");
    poke();
    window.setTimeout(() => setIntroMounted(false), INTRO_FADE_MS);
  }, [enterFullscreen, poke]);

  const setPlayback = useCallback((next: boolean) => {
    if (phaseRef.current !== "running") return;
    playingRef.current = next;
    setPlaying(next);
    if (next) {
      rendererRef.current?.play();
      audioRef.current?.resume();
    } else {
      rendererRef.current?.pause();
      audioRef.current?.pause();
    }
  }, []);

  const togglePlay = useCallback(() => setPlayback(!playingRef.current), [setPlayback]);

  const changeVolume = useCallback(
    (value: number) => {
      const volume = Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
      const unmute = getPreferences().muted && volume > 0;
      updatePrefs(unmute ? { volume, muted: false } : { volume });
      audioRef.current?.setVolume(volume);
      if (unmute) audioRef.current?.setMuted(false);
    },
    [updatePrefs],
  );

  const toggleMute = useCallback(() => {
    const { muted, volume } = getPreferences();
    if (muted || volume <= 0) {
      const restored = volume <= 0 ? 0.5 : volume;
      updatePrefs({ muted: false, volume: restored });
      audioRef.current?.setVolume(restored);
      audioRef.current?.setMuted(false);
    } else {
      updatePrefs({ muted: true });
      audioRef.current?.setMuted(true);
    }
  }, [updatePrefs]);

  const toggleFullscreen = useCallback(() => {
    void toggleFullscreenMode();
  }, [toggleFullscreenMode]);

  const hideControls = useCallback(() => {
    updatePrefs({ controlsHidden: true });
    setHold(false);
    showToast("Controles ocultos · pulsa H o el icono de la esquina para mostrarlos");
  }, [updatePrefs, showToast]);

  const showControls = useCallback(() => {
    updatePrefs({ controlsHidden: false });
    setToast((t) => ({ ...t, visible: false }));
    poke();
  }, [updatePrefs, poke]);

  useMediaSession(
    running,
    playing,
    useCallback(() => setPlayback(true), [setPlayback]),
    useCallback(() => setPlayback(false), [setPlayback]),
  );

  // -------------------------------------------------------------- shortcuts

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (phaseRef.current !== "running" || event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const tag = (event.target as HTMLElement | null)?.tagName;
      const onButton = tag === "BUTTON";
      const onInput = tag === "INPUT";
      switch (event.key) {
        case " ":
        case "Spacebar":
          if (onButton || onInput) return;
          event.preventDefault();
          togglePlay();
          break;
        case "k":
        case "K":
          togglePlay();
          break;
        case "m":
        case "M":
          toggleMute();
          break;
        case "f":
        case "F":
          toggleFullscreen();
          break;
        case "h":
        case "H":
          if (getPreferences().controlsHidden) showControls();
          else hideControls();
          break;
        case "ArrowUp":
          if (onInput) return;
          event.preventDefault();
          changeVolume(getPreferences().volume + VOLUME_STEP);
          break;
        case "ArrowDown":
          if (onInput) return;
          event.preventDefault();
          changeVolume(getPreferences().volume - VOLUME_STEP);
          break;
        default:
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [togglePlay, toggleMute, toggleFullscreen, hideControls, showControls, changeVolume]);

  // Double click (mouse) toggles fullscreen, like a video player.
  const lastPointerType = useRef("mouse");
  const onPointerDown = useCallback((event: ReactPointerEvent) => {
    lastPointerType.current = event.pointerType;
    audioRef.current?.ensureRunning();
  }, []);
  const onDoubleClick = useCallback(
    (event: ReactMouseEvent) => {
      if (phaseRef.current !== "running" || lastPointerType.current !== "mouse") return;
      if ((event.target as HTMLElement).closest("button, input")) return;
      toggleFullscreen();
    },
    [toggleFullscreen],
  );

  // ------------------------------------------------------------------ view

  const controlsVisible = running && !prefs.controlsHidden && (userActive || !playing);
  const restoreVisible = running && prefs.controlsHidden && userActive;
  const cursorHidden = running && !userActive;

  return (
    <main
      className={styles.app}
      data-cursor={cursorHidden ? "hidden" : undefined}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
    >
      <canvas ref={attachCanvas} className={styles.canvas} aria-hidden="true" />
      {webglFailed && <div className={styles.fallback} data-lit={running || undefined} aria-hidden="true" />}

      <p className={styles.paused} data-visible={(running && !playing) || undefined} aria-live="polite">
        {running && !playing ? "En pausa" : ""}
      </p>

      {running && (
        <ControlBar
          visible={controlsVisible}
          playing={playing}
          volume={prefs.volume}
          muted={prefs.muted}
          isFullscreen={isFullscreen}
          fullscreenSupported={fullscreenSupported}
          onTogglePlay={togglePlay}
          onToggleMute={toggleMute}
          onVolumeChange={changeVolume}
          onToggleFullscreen={toggleFullscreen}
          onHide={hideControls}
          onHoldChange={setHold}
        />
      )}

      {running && (
        <button
          type="button"
          className={styles.restore}
          data-visible={restoreVisible || undefined}
          onClick={showControls}
          aria-label="Mostrar controles"
          title="Mostrar controles (H)"
          tabIndex={restoreVisible ? 0 : -1}
        >
          <SlidersIcon />
        </button>
      )}

      <div className={styles.toast} data-visible={toast.visible || undefined} role="status">
        {toast.text}
      </div>

      {introMounted && <IntroScreen leaving={running} onStart={start} />}
    </main>
  );
}
