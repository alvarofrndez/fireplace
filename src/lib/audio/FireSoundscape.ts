/**
 * The fireplace soundscape as a Web Audio graph.
 *
 * Continuous layers (soft roar of the flames, fluttering, faint air hiss) are
 * looped noise shaped by filters whose parameters are constantly re-drawn by
 * random processes. Discrete events (crackles, bursts of crackles, pops, sap
 * hisses, settling logs) are scheduled ahead of time with random intervals,
 * gains, pitches and stereo positions. There is no fixed loop at all: the sound
 * is generated forever and never repeats.
 *
 * This class is context agnostic (works with an AudioContext or an
 * OfflineAudioContext); the real-time driver is FireAudioEngine.
 */

import { OrnsteinUhlenbeck, clamp, expInterval, randRange, smoothstep, type Rng } from "../random";
import { SYNTH_RATE, type SoundBanks } from "./synthesis";

export type PopListener = (when: number, strength: number, pan: number) => void;

interface Banks {
  crackles: AudioBuffer[];
  pops: AudioBuffer[];
  hisses: AudioBuffer[];
  settles: AudioBuffer[];
}

function toBuffer(ctx: BaseAudioContext, channels: Float32Array[]): AudioBuffer {
  const length = channels[0].length;
  const buffer = ctx.createBuffer(channels.length, length, SYNTH_RATE);
  channels.forEach((data, i) => buffer.getChannelData(i).set(data));
  return buffer;
}

export class FireSoundscape {
  /** Output of the soundscape (connect it to the volume stage). */
  readonly output: GainNode;
  private readonly ctx: BaseAudioContext;
  private readonly rng: Rng;
  private readonly banks: Banks;
  private readonly events: GainNode;
  private readonly reverbSend: GainNode;
  private readonly roarGain: GainNode;
  private readonly roarFilter: BiquadFilterNode;
  private readonly flutterGain: GainNode;
  private readonly flutterFilter: BiquadFilterNode;
  private readonly airGain: GainNode;
  private readonly loops: { source: AudioBufferSourceNode; offset: number }[] = [];
  private readonly activity: OrnsteinUhlenbeck;
  private readonly roarWalk: OrnsteinUhlenbeck;
  private readonly canPan: boolean;
  private startTime = 0;
  private lastHorizon = 0;
  private level = 1;
  private nextCrackle = 0;
  private nextPop = 0;
  private nextHiss = 0;
  private nextSettle = 0;
  private nextRoar = 0;
  private nextFlutter = 0;
  onPop: PopListener | null = null;

  constructor(ctx: BaseAudioContext, source: SoundBanks, rng: Rng) {
    this.ctx = ctx;
    this.rng = rng;
    this.canPan = typeof ctx.createStereoPanner === "function";
    this.banks = {
      crackles: source.crackles.map((d) => toBuffer(ctx, [d])),
      pops: source.pops.map((d) => toBuffer(ctx, [d])),
      hisses: source.hisses.map((d) => toBuffer(ctx, [d])),
      settles: source.settles.map((d) => toBuffer(ctx, [d])),
    };
    this.activity = new OrnsteinUhlenbeck(rng, 14, 0.22);
    this.roarWalk = new OrnsteinUhlenbeck(rng, 3, 1);

    this.output = ctx.createGain();

    // Warm room: a short convolution reverb shared by every layer.
    const reverb = ctx.createConvolver();
    reverb.normalize = true;
    reverb.buffer = toBuffer(ctx, source.impulse);
    const reverbReturn = ctx.createGain();
    reverbReturn.gain.value = 0.55;
    const reverbTone = ctx.createBiquadFilter();
    reverbTone.type = "lowpass";
    reverbTone.frequency.value = 5200;
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.32;
    this.reverbSend.connect(reverb);
    reverb.connect(reverbTone);
    reverbTone.connect(reverbReturn);
    reverbReturn.connect(this.output);

    this.events = ctx.createGain();
    this.events.connect(this.output);
    this.events.connect(this.reverbSend);

    const bed = toBuffer(ctx, source.bed);
    const air = toBuffer(ctx, source.air);

    // Roar: low, soft breathing of the flames.
    this.roarFilter = ctx.createBiquadFilter();
    this.roarFilter.type = "lowpass";
    this.roarFilter.frequency.value = 340;
    this.roarFilter.Q.value = 0.5;
    const roarHighpass = ctx.createBiquadFilter();
    roarHighpass.type = "highpass";
    roarHighpass.frequency.value = 38;
    this.roarGain = ctx.createGain();
    this.roarGain.gain.value = 0;
    this.loop(bed, 0).connect(this.roarFilter);
    this.roarFilter.connect(roarHighpass);
    roarHighpass.connect(this.roarGain);
    this.roarGain.connect(this.output);
    this.roarGain.connect(this.reverbSend);

    // Flutter: irregular flapping of the flame tongues.
    this.flutterFilter = ctx.createBiquadFilter();
    this.flutterFilter.type = "bandpass";
    this.flutterFilter.frequency.value = 620;
    this.flutterFilter.Q.value = 0.85;
    this.flutterGain = ctx.createGain();
    this.flutterGain.gain.value = 0;
    this.loop(bed, bed.duration * 0.5).connect(this.flutterFilter);
    this.flutterFilter.connect(this.flutterGain);
    this.flutterGain.connect(this.output);

    // Air: a barely audible high hiss of hot gas.
    const airHighpass = ctx.createBiquadFilter();
    airHighpass.type = "highpass";
    airHighpass.frequency.value = 3800;
    const airLowpass = ctx.createBiquadFilter();
    airLowpass.type = "lowpass";
    airLowpass.frequency.value = 9500;
    this.airGain = ctx.createGain();
    this.airGain.gain.value = 0;
    this.loop(air, 0).connect(airHighpass);
    airHighpass.connect(airLowpass);
    airLowpass.connect(this.airGain);
    this.airGain.connect(this.output);
  }

  private loop(buffer: AudioBuffer, offset: number): AudioBufferSourceNode {
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    this.loops.push({ source, offset });
    return source;
  }

  /** Starts the continuous layers at `when` (context time). */
  start(when: number): void {
    this.startTime = when;
    this.lastHorizon = when;
    for (const { source, offset } of this.loops) source.start(when, offset + this.rng() * 2);
    this.nextCrackle = when + 0.6;
    this.nextPop = when + randRange(this.rng, 2.5, 6);
    this.nextHiss = when + randRange(this.rng, 10, 25);
    this.nextSettle = when + randRange(this.rng, 45, 110);
    this.nextRoar = when;
    this.nextFlutter = when;
  }

  stop(): void {
    for (const { source } of this.loops) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
    }
  }

  /** Skips events that should have happened while the context was suspended. */
  resync(now: number): void {
    const min = now + 0.03;
    this.nextCrackle = Math.max(this.nextCrackle, min);
    this.nextPop = Math.max(this.nextPop, min + 0.5);
    this.nextHiss = Math.max(this.nextHiss, min + 2);
    this.nextSettle = Math.max(this.nextSettle, min + 10);
    this.nextRoar = Math.max(this.nextRoar, min);
    this.nextFlutter = Math.max(this.nextFlutter, min);
    this.lastHorizon = Math.max(this.lastHorizon, now);
  }

  /** Schedules everything up to `horizon` (context time). */
  scheduleUntil(horizon: number): void {
    const dt = horizon - this.lastHorizon;
    if (dt > 0) {
      // Crackling comes and goes in long waves.
      this.level = clamp(1 + this.activity.step(dt), 0.55, 1.6);
      this.lastHorizon = horizon;
    }
    const rng = this.rng;

    while (this.nextRoar < horizon) {
      this.modulateRoar(this.nextRoar);
      this.nextRoar += randRange(rng, 0.09, 0.24);
    }
    while (this.nextFlutter < horizon) {
      this.modulateFlutter(this.nextFlutter);
      this.nextFlutter += randRange(rng, 0.035, 0.11);
    }
    while (this.nextCrackle < horizon) {
      const t = this.nextCrackle;
      const ramp = this.ramp(t);
      if (rng() < 0.13 * ramp) this.crackleBurst(t);
      else this.crackle(t, 1);
      const rate = (1.2 + 4.2 * this.level * this.level) * (0.25 + 0.75 * ramp);
      this.nextCrackle += expInterval(rng, rate);
    }
    while (this.nextPop < horizon) {
      const t = this.nextPop;
      if (this.ramp(t) > 0.5) this.pop(t);
      this.nextPop += expInterval(rng, (1 / 9) * this.level) + 0.8;
    }
    while (this.nextHiss < horizon) {
      this.hiss(this.nextHiss);
      this.nextHiss += randRange(rng, 14, 50);
    }
    while (this.nextSettle < horizon) {
      this.settle(this.nextSettle);
      this.nextSettle += randRange(rng, 60, 170);
    }
  }

  /** Fire builds up during the first seconds, like the flames on screen. */
  private ramp(t: number): number {
    return smoothstep(0, 7, t - this.startTime);
  }

  private modulateRoar(t: number): void {
    const rng = this.rng;
    const walk = this.roarWalk.step(0.15);
    const ramp = this.ramp(t);
    const gain = (0.085 + 0.025 * walk + 0.03 * rng()) * (0.75 + 0.25 * this.level) * (0.25 + 0.75 * ramp);
    this.roarGain.gain.setTargetAtTime(Math.max(0.02, gain), t, randRange(rng, 0.08, 0.2));
    this.roarFilter.frequency.setTargetAtTime(clamp(330 + 90 * walk + randRange(rng, -40, 60), 200, 620), t, 0.25);
    this.airGain.gain.setTargetAtTime((0.0045 + 0.003 * rng()) * ramp * this.level, t, 0.3);
  }

  private modulateFlutter(t: number): void {
    const rng = this.rng;
    const ramp = this.ramp(t);
    const gain = 0.045 * Math.pow(rng(), 1.8) * (0.7 + 0.3 * this.level) * ramp;
    this.flutterGain.gain.setTargetAtTime(gain, t, randRange(rng, 0.02, 0.05));
    if (rng() < 0.15) this.flutterFilter.frequency.setTargetAtTime(randRange(rng, 420, 900), t, 0.2);
  }

  private play(buffer: AudioBuffer, when: number, gain: number, pan: number, rate: number, reverb = 1): void {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    let node: AudioNode = g;
    if (this.canPan) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      g.connect(p);
      node = p;
    }
    if (reverb === 1) {
      node.connect(this.events);
    } else {
      node.connect(this.output);
      const send = ctx.createGain();
      send.gain.value = reverb;
      node.connect(send);
      send.connect(this.reverbSend);
    }
    src.start(when);
  }

  private pick<T>(list: T[]): T {
    return list[Math.floor(this.rng() * list.length) % list.length];
  }

  private crackle(t: number, scale: number, pan?: number): void {
    const rng = this.rng;
    // Mostly quiet ticks, now and then a sharper one.
    const gain = (0.05 + 0.45 * Math.pow(rng(), 3)) * scale;
    const p = pan ?? clamp((rng() + rng() - 1) * 0.9, -0.85, 0.85);
    this.play(this.pick(this.banks.crackles), t, gain, p, randRange(rng, 0.72, 1.35));
  }

  private crackleBurst(t: number): void {
    const rng = this.rng;
    const pan = clamp((rng() + rng() - 1) * 0.8, -0.8, 0.8);
    const count = 3 + Math.floor(Math.pow(rng(), 1.5) * 11);
    let time = t;
    for (let i = 0; i < count; i++) {
      this.crackle(time, 1.15 * (1 - (i / count) * 0.6), pan + randRange(rng, -0.12, 0.12));
      time += randRange(rng, 0.008, 0.07);
    }
  }

  private pop(t: number): void {
    const rng = this.rng;
    const strength = Math.pow(rng(), 1.4);
    const pan = clamp((rng() + rng() - 1) * 0.75, -0.75, 0.75);
    this.play(this.pick(this.banks.pops), t, 0.22 + 0.5 * strength, pan, randRange(rng, 0.8, 1.2), 1.2);
    // Splinters and crackles following the snap.
    if (rng() < 0.65) {
      let time = t + randRange(rng, 0.03, 0.12);
      const n = 2 + Math.floor(rng() * 7);
      for (let i = 0; i < n; i++) {
        this.crackle(time, 0.8, pan + randRange(rng, -0.1, 0.1));
        time += randRange(rng, 0.02, 0.16);
      }
    }
    this.onPop?.(t, strength, pan);
  }

  private hiss(t: number): void {
    const rng = this.rng;
    this.play(this.pick(this.banks.hisses), t, randRange(rng, 0.025, 0.075), randRange(rng, -0.5, 0.5), randRange(rng, 0.85, 1.15), 0.6);
  }

  private settle(t: number): void {
    const rng = this.rng;
    this.play(this.pick(this.banks.settles), t, randRange(rng, 0.25, 0.45), randRange(rng, -0.35, 0.35), randRange(rng, 0.85, 1.1), 1.4);
    this.onPop?.(t + 0.05, 0.9, 0);
  }
}
