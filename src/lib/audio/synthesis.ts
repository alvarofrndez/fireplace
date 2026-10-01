/**
 * Offline synthesis of the fireplace sound material.
 *
 * Nothing is recorded: every crackle, pop, sap hiss and settling log is
 * generated procedurally (impulses exciting wood-like resonances, filtered
 * noise, damped modes). Many variations are produced so the real-time
 * scheduler can combine them without ever repeating a pattern.
 */

import { randRange, type Rng } from "../random";

/** Cheap approximately gaussian noise (sum of three uniforms, unit variance). */
function noise(rng: Rng): number {
  return (rng() + rng() + rng() - 1.5) * 2;
}

/** Sample rate used for the generated material (the AudioContext resamples if needed). */
export const SYNTH_RATE = 48000;

class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  private constructor(
    private readonly b0: number,
    private readonly b1: number,
    private readonly b2: number,
    private readonly a1: number,
    private readonly a2: number,
  ) {}

  private static make(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): Biquad {
    return new Biquad(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
  }

  /** Band-pass with 0 dB peak gain (RBJ cookbook). */
  static bandpass(sr: number, f0: number, q: number): Biquad {
    const w = (2 * Math.PI * Math.min(f0, sr * 0.45)) / sr;
    const alpha = Math.sin(w) / (2 * q);
    const cos = Math.cos(w);
    return Biquad.make(alpha, 0, -alpha, 1 + alpha, -2 * cos, 1 - alpha);
  }

  static lowpass(sr: number, f0: number, q: number): Biquad {
    const w = (2 * Math.PI * Math.min(f0, sr * 0.45)) / sr;
    const alpha = Math.sin(w) / (2 * q);
    const cos = Math.cos(w);
    return Biquad.make((1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
  }

  static highpass(sr: number, f0: number, q: number): Biquad {
    const w = (2 * Math.PI * Math.min(f0, sr * 0.45)) / sr;
    const alpha = Math.sin(w) / (2 * q);
    const cos = Math.cos(w);
    return Biquad.make((1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
  }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

function normalize(data: Float32Array, peak = 0.95): Float32Array {
  let max = 0;
  for (let i = 0; i < data.length; i++) max = Math.max(max, Math.abs(data[i]));
  if (max > 0) {
    const k = peak / max;
    for (let i = 0; i < data.length; i++) data[i] *= k;
  }
  return data;
}

/** Short fades at both ends so buffers never click when they start or stop. */
function edgeFade(data: Float32Array, inSamples: number, outSamples: number): void {
  const n = data.length;
  for (let i = 0; i < Math.min(inSamples, n); i++) data[i] *= i / inSamples;
  for (let i = 0; i < Math.min(outSamples, n); i++) data[n - 1 - i] *= i / outSamples;
}

/** Adds a single crack (a tiny burst of broadband energy) at `start`. */
function addClick(out: Float32Array, rng: Rng, start: number, amp: number, tauSeconds: number, sr: number): void {
  const tau = Math.max(1, tauSeconds * sr);
  const len = Math.min(out.length - start, Math.ceil(tau * 7));
  if (len <= 0) return;
  const decay = Math.exp(-1 / tau);
  let shape = amp;
  out[start] += amp;
  for (let i = 1; i < len; i++) {
    shape *= decay;
    out[start + i] += shape * noise(rng) * 0.65;
  }
}

/** Small dry crackle of burning wood: a few fibres snapping, resonating briefly. */
export function synthCrackle(rng: Rng, sr = SYNTH_RATE): Float32Array {
  const dur = 0.006 + Math.pow(rng(), 2.2) * 0.05;
  const n = Math.ceil(dur * sr) + 64;
  const raw = new Float32Array(n);
  const clicks = 1 + Math.floor(Math.pow(rng(), 1.6) * 5);
  for (let c = 0; c < clicks; c++) {
    const start = c === 0 ? 0 : Math.floor(rng() * dur * sr * 0.6);
    const amp = (c === 0 ? 1 : randRange(rng, 0.2, 0.85)) * (rng() < 0.5 ? -1 : 1);
    addClick(raw, rng, start, amp, randRange(rng, 0.00006, 0.0005), sr);
  }

  const bp1 = Biquad.bandpass(sr, randRange(rng, 1500, 5600), randRange(rng, 2, 7));
  const bp2 = Biquad.bandpass(sr, randRange(rng, 450, 1700), randRange(rng, 1, 3));
  const hp = Biquad.highpass(sr, randRange(rng, 250, 600), 0.7);
  const lp = Biquad.lowpass(sr, randRange(rng, 7000, 13000), 0.7);
  const dry = randRange(rng, 0.3, 0.7);
  const res1 = randRange(rng, 1.4, 2.6);
  const res2 = randRange(rng, 0.4, 1.0);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = raw[i];
    out[i] = lp.process(hp.process(x * dry + bp1.process(x) * res1 + bp2.process(x) * res2));
  }
  edgeFade(out, 2, Math.min(96, Math.floor(n / 3)));
  return normalize(out);
}

/** Louder snap of a log: sharp crack, a short woody body and splinters. */
export function synthPop(rng: Rng, sr = SYNTH_RATE): Float32Array {
  const dur = randRange(rng, 0.14, 0.38);
  const n = Math.ceil(dur * sr);
  const out = new Float32Array(n);

  // Transient.
  const tTau = randRange(rng, 0.0003, 0.0012) * sr;
  const tDecay = Math.exp(-1 / tTau);
  let tEnv = 1;
  for (let i = 0; i < Math.min(n, tTau * 8); i++, tEnv *= tDecay) out[i] += noise(rng) * tEnv;

  // Woody body: a few damped modes.
  const modes = 2 + Math.floor(rng() * 3);
  let f = randRange(rng, 170, 650);
  for (let m = 0; m < modes; m++) {
    const tau = randRange(rng, 0.005, 0.028) * sr;
    const amp = randRange(rng, 0.25, 0.6) / Math.sqrt(m + 1);
    const phase = rng() * Math.PI * 2;
    const w = (2 * Math.PI * f) / sr;
    const len = Math.min(n, Math.ceil(tau * 7));
    const decay = Math.exp(-1 / tau);
    let env = amp;
    for (let i = 0; i < len; i++, env *= decay) out[i] += env * Math.sin(w * i + phase);
    f *= randRange(rng, 1.45, 2.9);
  }

  // Crack tail: band-passed noise.
  const bp = Biquad.bandpass(sr, randRange(rng, 1300, 4200), randRange(rng, 0.7, 1.6));
  const tailDecay = Math.exp(-1 / (randRange(rng, 0.012, 0.05) * sr));
  let tail = randRange(rng, 0.35, 0.8);
  for (let i = 0; i < n; i++, tail *= tailDecay) out[i] += bp.process(noise(rng)) * tail;

  // Splinters right after the snap.
  const splinters = 2 + Math.floor(rng() * 7);
  for (let k = 0; k < splinters; k++) {
    const start = Math.floor(randRange(rng, 0.006, Math.min(0.16, dur * 0.7)) * sr);
    addClick(out, rng, start, randRange(rng, 0.1, 0.45) * (rng() < 0.5 ? -1 : 1), randRange(rng, 0.0001, 0.0005), sr);
  }

  // Sometimes a short whistle of escaping steam.
  if (rng() < 0.45) {
    const hp = Biquad.highpass(sr, randRange(rng, 2500, 4500), 0.8);
    const sizzleDecay = Math.exp(-1 / (randRange(rng, 0.05, 0.16) * sr));
    const riseDecay = Math.exp(-1 / (0.01 * sr));
    const amp = randRange(rng, 0.03, 0.09);
    const offset = Math.floor(0.01 * sr);
    let rise = 1;
    let fall = amp;
    for (let i = offset; i < n; i++, rise *= riseDecay, fall *= sizzleDecay) {
      out[i] += hp.process(noise(rng)) * (1 - rise) * fall;
    }
  }

  const hp = Biquad.highpass(sr, 70, 0.7);
  for (let i = 0; i < n; i++) out[i] = hp.process(out[i]);
  edgeFade(out, 2, Math.floor(0.03 * sr));
  return normalize(out);
}

/** Sap boiling out of a log: a fluttering hiss with tiny bubbles. */
export function synthHiss(rng: Rng, sr = SYNTH_RATE): Float32Array {
  const dur = randRange(rng, 0.9, 3.4);
  const n = Math.ceil(dur * sr);
  const out = new Float32Array(n);
  const hp = Biquad.highpass(sr, randRange(rng, 2200, 3600), 0.7);
  const lp = Biquad.lowpass(sr, randRange(rng, 7000, 11000), 0.7);
  const res = Biquad.bandpass(sr, randRange(rng, 3500, 7000), randRange(rng, 3, 9));
  const whistle = randRange(rng, 0, 0.35);

  // Fluttering amplitude: smoothed random steps.
  let level = 0.5;
  let target = 0.5;
  const step = Math.floor(sr / randRange(rng, 9, 26));
  const attack = randRange(rng, 0.08, 0.3);
  const release = randRange(rng, 0.25, 0.7);
  for (let i = 0; i < n; i++) {
    if (i % step === 0) target = 0.25 + 0.75 * Math.pow(rng(), 0.7);
    level += (target - level) * 0.004;
    const t = i / sr;
    const env = Math.min(1, t / attack) * Math.min(1, (dur - t) / release);
    const x = noise(rng);
    out[i] = lp.process(hp.process(x) + res.process(x) * whistle) * level * env;
  }

  // Bubbles: very small clicks.
  const bubbles = Math.floor(dur * randRange(rng, 25, 90));
  for (let k = 0; k < bubbles; k++) {
    const start = Math.floor(rng() * (n - 200));
    addClick(out, rng, start, randRange(rng, 0.05, 0.3) * (rng() < 0.5 ? -1 : 1), randRange(rng, 0.00005, 0.00025), sr);
  }
  edgeFade(out, Math.floor(0.01 * sr), Math.floor(0.05 * sr));
  return normalize(out);
}

/** A log settling on the grate: soft thud followed by embers trickling down. */
export function synthSettle(rng: Rng, sr = SYNTH_RATE): Float32Array {
  const dur = randRange(rng, 0.8, 1.6);
  const n = Math.ceil(dur * sr);
  const out = new Float32Array(n);

  const f = randRange(rng, 70, 140);
  const thudDecay = Math.exp(-1 / (randRange(rng, 0.05, 0.11) * sr));
  const w = (2 * Math.PI * f) / sr;
  let thud = 0.9;
  for (let i = 0; i < n && thud > 1e-5; i++, thud *= thudDecay) out[i] += Math.sin(w * i) * thud;
  const lp = Biquad.lowpass(sr, randRange(rng, 400, 900), 0.7);
  const rumbleDecay = Math.exp(-1 / (randRange(rng, 0.02, 0.05) * sr));
  let rumble = 0.8;
  for (let i = 0; i < n && rumble > 1e-5; i++, rumble *= rumbleDecay) out[i] += lp.process(noise(rng)) * rumble;

  const bits = 12 + Math.floor(rng() * 26);
  const span = randRange(rng, 0.3, 0.75) * dur;
  const bp = Biquad.bandpass(sr, randRange(rng, 2500, 5500), 2.5);
  const scratch = new Float32Array(n);
  for (let k = 0; k < bits; k++) {
    const t = Math.pow(rng(), 1.8) * span + 0.04;
    const start = Math.floor(t * sr);
    if (start >= n - 100) continue;
    addClick(scratch, rng, start, randRange(rng, 0.05, 0.35) * (1 - t / dur), randRange(rng, 0.0001, 0.0006), sr);
  }
  for (let i = 0; i < n; i++) out[i] += bp.process(scratch[i]) * 2 + scratch[i] * 0.3;

  edgeFade(out, 8, Math.floor(0.08 * sr));
  return normalize(out);
}

/** Stereo noise for the continuous layers. Pink (Kellet) or brown (leaky integrator). */
export function synthNoise(rng: Rng, seconds: number, color: "pink" | "brown" | "white", sr = SYNTH_RATE): Float32Array[] {
  const n = Math.ceil(seconds * sr);
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < 2; ch++) {
    const data = new Float32Array(n);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    let b6 = 0;
    let brown = 0;
    for (let i = 0; i < n; i++) {
      const white = rng() * 2 - 1;
      if (color === "white") {
        data[i] = white;
      } else if (color === "pink") {
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.969 * b2 + white * 0.153852;
        b3 = 0.8665 * b3 + white * 0.3104856;
        b4 = 0.55 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.016898;
        data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
        b6 = white * 0.115926;
      } else {
        brown = (brown + white * 0.02) * 0.998;
        data[i] = brown * 3.5;
      }
    }
    // Crossfade the end into the start so the loop point is seamless.
    const fade = Math.floor(0.25 * sr);
    for (let i = 0; i < fade; i++) {
      const a = i / fade;
      data[i] = data[i] * a + data[n - fade + i] * (1 - a);
    }
    channels.push(data.subarray(0, n - fade));
  }
  return channels;
}

/** Impulse response of a medium living room (small, warm, short). */
export function synthRoomImpulse(rng: Rng, seconds = 0.8, sr = SYNTH_RATE): Float32Array[] {
  const n = Math.ceil(seconds * sr);
  const channels: Float32Array[] = [];
  const decay = Math.exp(-1 / (0.095 * sr));
  const darken = Math.exp(-7 / sr);
  const preDelay = Math.floor(0.004 * sr);
  for (let ch = 0; ch < 2; ch++) {
    const data = new Float32Array(n);
    let lp = 0;
    let env = 1;
    let k = 0.75;
    for (let i = preDelay; i < n; i++, env *= decay, k *= darken) {
      // Air and furniture absorb high frequencies faster.
      lp += (noise(rng) - lp) * Math.max(0.06, k);
      data[i] = lp * env;
    }
    // A few early reflections (walls, floor, ceiling).
    const reflections = 7;
    for (let r = 0; r < reflections; r++) {
      const t = Math.floor(randRange(rng, 0.006, 0.042) * sr);
      if (t < n) data[t] += randRange(rng, 0.3, 0.7) * (rng() < 0.5 ? -1 : 1);
    }
    channels.push(normalize(data, 0.7));
  }
  return channels;
}

export interface SoundBanks {
  crackles: Float32Array[];
  pops: Float32Array[];
  hisses: Float32Array[];
  settles: Float32Array[];
  bed: Float32Array[];
  air: Float32Array[];
  impulse: Float32Array[];
}

/** Generates every sound used by the engine (a few tens of milliseconds of CPU). */
export function synthesizeBanks(rng: Rng): SoundBanks {
  const crackles: Float32Array[] = [];
  for (let i = 0; i < 48; i++) crackles.push(synthCrackle(rng));
  const pops: Float32Array[] = [];
  for (let i = 0; i < 14; i++) pops.push(synthPop(rng));
  const hisses: Float32Array[] = [];
  for (let i = 0; i < 5; i++) hisses.push(synthHiss(rng));
  const settles: Float32Array[] = [];
  for (let i = 0; i < 3; i++) settles.push(synthSettle(rng));
  return {
    crackles,
    pops,
    hisses,
    settles,
    bed: synthNoise(rng, 8.3, "pink"),
    air: synthNoise(rng, 6.1, "white"),
    impulse: synthRoomImpulse(rng),
  };
}
