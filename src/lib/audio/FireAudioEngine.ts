/**
 * Real-time driver of the fireplace soundscape: owns the AudioContext, the
 * master chain (fade, tone, compressor, volume), the look-ahead scheduler and
 * play / pause / volume / mute.
 */

import { clamp, createRng } from "../random";
import { FireSoundscape } from "./FireSoundscape";
import { synthesizeBanks, type SoundBanks } from "./synthesis";

type AudioContextConstructor = typeof AudioContext;

/** Make-up gain applied before the compressor (which also acts as a soft limiter). */
const MAKEUP_GAIN = 2.2;
/** Overall loudness at 100 % volume (after the compressor, never above 1). */
const MASTER_GAIN = 1.0;
const TICK_MS = 120;
const LOOKAHEAD_VISIBLE = 0.45;
/** Background tabs may throttle timers to ~1 Hz: schedule further ahead. */
const LOOKAHEAD_HIDDEN = 2.6;

function getAudioContextClass(): AudioContextConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & { webkitAudioContext?: AudioContextConstructor };
  return window.AudioContext ?? w.webkitAudioContext ?? null;
}

let preparedBanks: SoundBanks | null = null;

/** Synthesizes all sound material in advance (can be called while idle, before any click). */
export function prepareFireAudio(): SoundBanks {
  if (!preparedBanks) preparedBanks = synthesizeBanks(createRng((Math.random() * 2 ** 31) | 0));
  return preparedBanks;
}

/** Perceptual volume curve: slider position (0..1) → linear gain. */
export function volumeToGain(volume: number): number {
  const v = clamp(volume, 0, 1);
  return v * v * MASTER_GAIN;
}

export interface OutputChain {
  input: GainNode;
  fade: GainNode;
  volume: GainNode;
}

/** fade → warm tone → make-up gain → compression / limiting → volume. */
export function buildOutputChain(ctx: BaseAudioContext, destination: AudioNode): OutputChain {
  const input = ctx.createGain();
  const fade = ctx.createGain();
  fade.gain.value = 0;
  const warmth = ctx.createBiquadFilter();
  warmth.type = "lowshelf";
  warmth.frequency.value = 160;
  warmth.gain.value = 1;
  const soften = ctx.createBiquadFilter();
  soften.type = "highshelf";
  soften.frequency.value = 8000;
  soften.gain.value = -2.5;
  const makeup = ctx.createGain();
  makeup.gain.value = MAKEUP_GAIN;
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -14;
  compressor.knee.value = 8;
  compressor.ratio.value = 6;
  compressor.attack.value = 0.002;
  compressor.release.value = 0.2;
  const volume = ctx.createGain();
  volume.gain.value = 0;
  input.connect(fade);
  fade.connect(warmth);
  warmth.connect(soften);
  soften.connect(makeup);
  makeup.connect(compressor);
  compressor.connect(volume);
  volume.connect(destination);
  return { input, fade, volume };
}

function hold(param: AudioParam, time: number): void {
  const p = param as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam };
  if (typeof p.cancelAndHoldAtTime === "function") {
    p.cancelAndHoldAtTime(time);
  } else {
    const value = param.value;
    param.cancelScheduledValues(time);
    param.setValueAtTime(value, time);
  }
}

export interface FireAudioOptions {
  volume: number;
  muted: boolean;
  /** Called when a loud pop is heard (strength 0..1, pan -1..1), to sync sparks. */
  onPop?: (strength: number, pan: number) => void;
}

export class FireAudioEngine {
  static isSupported(): boolean {
    return getAudioContextClass() !== null;
  }

  private readonly ctx: AudioContext;
  private readonly scape: FireSoundscape;
  private readonly chain: OutputChain;
  private readonly onPop?: (strength: number, pan: number) => void;
  private timer: number | null = null;
  private suspendTimer: number | null = null;
  private paused = false;
  private disposed = false;
  private volume: number;
  private muted: boolean;

  /** Must be created from a user gesture (click / key press) so the browser allows sound. */
  constructor(options: FireAudioOptions) {
    const Ctor = getAudioContextClass();
    if (!Ctor) throw new Error("Web Audio no está disponible en este navegador");

    // iOS / iPadOS: keep playing even with the silent switch on.
    try {
      const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
      if (session) session.type = "playback";
    } catch {
      /* not supported */
    }

    let ctx: AudioContext;
    try {
      ctx = new Ctor({ latencyHint: "playback" });
    } catch {
      ctx = new Ctor();
    }
    this.ctx = ctx;
    void ctx.resume().catch(() => undefined);

    this.volume = clamp(options.volume, 0, 1);
    this.muted = options.muted;
    this.onPop = options.onPop;

    this.chain = buildOutputChain(ctx, ctx.destination);
    this.scape = new FireSoundscape(ctx, prepareFireAudio(), createRng((Math.random() * 2 ** 31) | 0));
    this.scape.output.connect(this.chain.input);
    this.scape.onPop = (when, strength, pan) => this.notifyPop(when, strength, pan);

    const now = ctx.currentTime;
    this.applyVolume(true);
    this.scape.start(now + 0.05);
    this.chain.fade.gain.setValueAtTime(0, now);
    this.chain.fade.gain.setTargetAtTime(1, now + 0.05, 0.9);
    this.startTimer();
    document.addEventListener("visibilitychange", this.handleVisibility);
  }

  get state(): AudioContextState | "interrupted" {
    return this.ctx.state;
  }

  setVolume(volume: number): void {
    this.volume = clamp(volume, 0, 1);
    this.applyVolume();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyVolume();
  }

  pause(): void {
    if (this.paused || this.disposed) return;
    this.paused = true;
    this.stopTimer();
    const now = this.ctx.currentTime;
    const fade = this.chain.fade.gain;
    hold(fade, now);
    fade.setTargetAtTime(0, now, 0.12);
    this.suspendTimer = window.setTimeout(() => {
      this.suspendTimer = null;
      if (this.paused && !this.disposed) void this.ctx.suspend().catch(() => undefined);
    }, 800);
  }

  resume(): void {
    if (!this.paused || this.disposed) return;
    this.paused = false;
    if (this.suspendTimer !== null) {
      window.clearTimeout(this.suspendTimer);
      this.suspendTimer = null;
    }
    const restart = () => {
      if (this.paused || this.disposed) return;
      const now = this.ctx.currentTime;
      this.scape.resync(now);
      const fade = this.chain.fade.gain;
      hold(fade, now);
      fade.setTargetAtTime(1, now, 0.35);
      this.startTimer();
    };
    if (this.ctx.state === "running") restart();
    else this.ctx.resume().then(restart, restart);
  }

  /** Browsers (iOS mainly) may interrupt audio; call on user interaction to recover. */
  ensureRunning(): void {
    if (this.disposed || this.paused) return;
    if (this.ctx.state !== "running") {
      void this.ctx.resume().then(
        () => this.scape.resync(this.ctx.currentTime),
        () => undefined,
      );
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopTimer();
    if (this.suspendTimer !== null) window.clearTimeout(this.suspendTimer);
    document.removeEventListener("visibilitychange", this.handleVisibility);
    this.scape.stop();
    void this.ctx.close().catch(() => undefined);
  }

  private applyVolume(immediate = false): void {
    const target = this.muted ? 0 : volumeToGain(this.volume);
    const now = this.ctx.currentTime;
    const gain = this.chain.volume.gain;
    if (immediate) {
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(target, now);
    } else {
      hold(gain, now);
      gain.setTargetAtTime(target, now, 0.045);
    }
  }

  private tick = (): void => {
    if (this.paused || this.disposed) return;
    const lookahead = document.hidden ? LOOKAHEAD_HIDDEN : LOOKAHEAD_VISIBLE;
    this.scape.scheduleUntil(this.ctx.currentTime + lookahead);
  };

  private startTimer(): void {
    if (this.timer !== null) return;
    this.tick();
    this.timer = window.setInterval(this.tick, TICK_MS);
  }

  private stopTimer(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  private handleVisibility = (): void => {
    // Refill the schedule right away with the lookahead that suits the new state.
    this.tick();
  };

  private notifyPop(when: number, strength: number, pan: number): void {
    const listener = this.onPop;
    if (!listener) return;
    const latency = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    const delay = Math.max(0, (when - this.ctx.currentTime + latency) * 1000);
    window.setTimeout(() => {
      if (!this.paused && !this.disposed) listener(strength, pan);
    }, delay);
  }
}
