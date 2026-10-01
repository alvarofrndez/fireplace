import type { CSSProperties } from "react";
import {
  ExitFullscreenIcon,
  FullscreenIcon,
  HideIcon,
  PauseIcon,
  PlayIcon,
  VolumeIcon,
} from "../icons";
import styles from "./ControlBar.module.scss";

interface ControlBarProps {
  visible: boolean;
  playing: boolean;
  volume: number;
  muted: boolean;
  isFullscreen: boolean;
  fullscreenSupported: boolean;
  onTogglePlay: () => void;
  onToggleMute: () => void;
  onVolumeChange: (volume: number) => void;
  onToggleFullscreen: () => void;
  onHide: () => void;
  /** Hovering / focusing / dragging inside the bar keeps it on screen. */
  onHoldChange: (hold: boolean) => void;
}

export function ControlBar({
  visible,
  playing,
  volume,
  muted,
  isFullscreen,
  fullscreenSupported,
  onTogglePlay,
  onToggleMute,
  onVolumeChange,
  onToggleFullscreen,
  onHide,
  onHoldChange,
}: ControlBarProps) {
  const silent = muted || volume <= 0;
  const percent = Math.round(volume * 100);
  const shownLevel = silent ? 0 : volume;

  return (
    <div
      className={styles.bar}
      data-visible={visible || undefined}
      role="toolbar"
      aria-label="Controles de la chimenea"
      aria-hidden={!visible || undefined}
      onPointerEnter={() => onHoldChange(true)}
      onPointerLeave={() => onHoldChange(false)}
      onFocus={() => onHoldChange(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onHoldChange(false);
      }}
    >
      <button
        type="button"
        className={styles.button}
        onClick={onTogglePlay}
        aria-label={playing ? "Pausar" : "Reproducir"}
        title={playing ? "Pausar (espacio)" : "Reproducir (espacio)"}
        tabIndex={visible ? 0 : -1}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>

      <span className={styles.divider} aria-hidden="true" />

      <div className={styles.volume}>
        <button
          type="button"
          className={styles.button}
          onClick={onToggleMute}
          aria-label={silent ? "Activar sonido" : "Silenciar"}
          aria-pressed={silent}
          title={silent ? "Activar sonido (M)" : "Silenciar (M)"}
          tabIndex={visible ? 0 : -1}
        >
          <VolumeIcon level={shownLevel} />
        </button>
        <input
          className={styles.slider}
          type="range"
          min={0}
          max={100}
          step={1}
          value={silent ? 0 : percent}
          onChange={(event) => onVolumeChange(Number(event.currentTarget.value) / 100)}
          onPointerDown={() => onHoldChange(true)}
          aria-label="Volumen"
          aria-valuetext={silent ? "Silenciado" : `${percent} %`}
          tabIndex={visible ? 0 : -1}
          style={{ "--fill": `${silent ? 0 : percent}%` } as CSSProperties}
        />
        <span className={styles.level} aria-hidden="true">
          {silent ? "0" : percent}
        </span>
      </div>

      <span className={styles.divider} aria-hidden="true" />

      {fullscreenSupported && (
        <button
          type="button"
          className={styles.button}
          onClick={onToggleFullscreen}
          aria-label={isFullscreen ? "Salir de pantalla completa" : "Pantalla completa"}
          title={isFullscreen ? "Salir de pantalla completa (F)" : "Pantalla completa (F)"}
          tabIndex={visible ? 0 : -1}
        >
          {isFullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
        </button>
      )}
      <button
        type="button"
        className={styles.button}
        onClick={onHide}
        aria-label="Ocultar controles"
        title="Ocultar controles (H)"
        tabIndex={visible ? 0 : -1}
      >
        <HideIcon />
      </button>
    </div>
  );
}
