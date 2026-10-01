/**
 * CPU side behaviour of the fire: where fuel is released along the logs, how
 * each tongue of flame breathes, flares and calms down, the slow changes of
 * the whole fire, the draft and the glow of the ember bed.
 */

import { OrnsteinUhlenbeck, clamp, createRng, expInterval, randRange, smoothstep, type Rng } from "../random";
import { MAX_EMITTERS } from "./shaders/sim";
import { FIRE_DOMAIN } from "./scene";

interface EmitterSpec {
  /** World position on the flame plane (meters). */
  x: number;
  y: number;
  halfWidth: number;
  halfHeight: number;
  /** Nominal strength. */
  base: number;
  /** Temperature kept at the source (embers keep the gas igniting). */
  pilot: number;
  /** Delay (s) before this part of the logs catches fire after ignition. */
  delay: number;
}

const EMITTERS: EmitterSpec[] = [
  // Along the top of the crossing log.
  { x: -0.115, y: 0.208, halfWidth: 0.068, halfHeight: 0.018, base: 0.9, pilot: 0.42, delay: 0.5 },
  { x: -0.02, y: 0.217, halfWidth: 0.07, halfHeight: 0.018, base: 1.0, pilot: 0.45, delay: 0.0 },
  { x: 0.078, y: 0.225, halfWidth: 0.068, halfHeight: 0.018, base: 1.0, pilot: 0.45, delay: 0.2 },
  { x: 0.172, y: 0.233, halfWidth: 0.06, halfHeight: 0.018, base: 0.85, pilot: 0.4, delay: 0.9 },
  // Crevice between the crossing log and the back log.
  { x: -0.2, y: 0.165, halfWidth: 0.065, halfHeight: 0.02, base: 0.85, pilot: 0.42, delay: 1.4 },
  { x: 0.0, y: 0.168, halfWidth: 0.08, halfHeight: 0.022, base: 0.95, pilot: 0.45, delay: 0.3 },
  { x: 0.15, y: 0.17, halfWidth: 0.065, halfHeight: 0.02, base: 0.85, pilot: 0.42, delay: 0.8 },
  // Ends of the back log.
  { x: -0.24, y: 0.15, halfWidth: 0.05, halfHeight: 0.018, base: 0.6, pilot: 0.38, delay: 2.0 },
  { x: 0.245, y: 0.152, halfWidth: 0.05, halfHeight: 0.018, base: 0.62, pilot: 0.38, delay: 1.7 },
  // Front log.
  { x: -0.14, y: 0.118, halfWidth: 0.055, halfHeight: 0.016, base: 0.48, pilot: 0.35, delay: 1.2 },
  { x: 0.07, y: 0.12, halfWidth: 0.06, halfHeight: 0.016, base: 0.5, pilot: 0.35, delay: 1.0 },
  // Leaning branch.
  { x: -0.275, y: 0.11, halfWidth: 0.035, halfHeight: 0.022, base: 0.45, pilot: 0.35, delay: 2.4 },
  // Small flames licking from the ember bed at both sides.
  { x: -0.31, y: 0.04, halfWidth: 0.04, halfHeight: 0.015, base: 0.3, pilot: 0.32, delay: 2.6 },
  { x: 0.3, y: 0.045, halfWidth: 0.04, halfHeight: 0.015, base: 0.32, pilot: 0.32, delay: 2.2 },
];

interface EmitterState {
  spec: EmitterSpec;
  seed: number;
  rate: number;
  ou: OrnsteinUhlenbeck;
  flare: number;
  nextFlare: number;
  strength: number;
}

export interface EmberLight {
  r: number;
  g: number;
  b: number;
}

export class FireDynamics {
  /** 0 → 1 while the fire catches. */
  ignition = 0;
  /** Seconds since ignition started (-1 when unlit). */
  private sinceIgnition = -1;
  private readonly rng: Rng;
  private readonly emitters: EmitterState[];
  private readonly global: OrnsteinUhlenbeck;
  private readonly breeze: OrnsteinUhlenbeck;
  private readonly emberBreath: OrnsteinUhlenbeck;
  private readonly emberLocal: OrnsteinUhlenbeck[];
  /** Overall vigor of the fire (around 1). */
  vigor = 1;
  /** Lateral draft (uv / s²). */
  wind = 0;
  /** Gain applied to the ember glow. */
  emberGain = 0.35;
  readonly emberLights: EmberLight[] = [
    { r: 0, g: 0, b: 0 },
    { r: 0, g: 0, b: 0 },
    { r: 0, g: 0, b: 0 },
  ];

  constructor(seed = (Math.random() * 1e9) | 0) {
    this.rng = createRng(seed);
    const rng = this.rng;
    this.emitters = EMITTERS.slice(0, MAX_EMITTERS).map((spec, i) => ({
      spec,
      seed: Math.round(randRange(rng, 0, 100) * 100) / 100 + i * 3.17,
      // Rounded to 0.01 so that the noise stays periodic with the time wrap.
      rate: Math.round(randRange(rng, 0.55, 1.05) * 100) / 100,
      ou: new OrnsteinUhlenbeck(rng, randRange(rng, 1.2, 3.0), 0.55),
      flare: 0,
      nextFlare: randRange(rng, 4, 40),
      strength: 0,
    }));
    this.global = new OrnsteinUhlenbeck(rng, 22, 0.13);
    this.breeze = new OrnsteinUhlenbeck(rng, 7, 1);
    this.emberBreath = new OrnsteinUhlenbeck(rng, 4.5, 1);
    this.emberLocal = [0, 1, 2].map(() => new OrnsteinUhlenbeck(rng, 2.2, 1));
  }

  ignite(): void {
    if (this.sinceIgnition < 0) this.sinceIgnition = 0;
  }

  get lit(): boolean {
    return this.sinceIgnition >= 0;
  }

  /** Makes the flames near `x` (meters) flare up, e.g. after a loud crackle. */
  flare(x: number, amount: number): void {
    for (const e of this.emitters) {
      const d = Math.abs(e.spec.x - x);
      const w = Math.exp(-(d * d) / 0.012);
      e.flare = Math.min(2.2, e.flare + amount * w);
    }
  }

  /** A random position along the logs where flames currently burn (for sparks). */
  randomSource(rng: Rng): { x: number; y: number; weight: number } {
    let total = 0;
    for (const e of this.emitters) total += e.strength;
    let pick = rng() * total;
    for (const e of this.emitters) {
      pick -= e.strength;
      if (pick <= 0) {
        return {
          x: e.spec.x + (rng() - 0.5) * e.spec.halfWidth * 2,
          y: e.spec.y + rng() * 0.02,
          weight: e.strength,
        };
      }
    }
    const e = this.emitters[1];
    return { x: e.spec.x, y: e.spec.y, weight: e.strength };
  }

  update(dt: number): void {
    if (this.sinceIgnition >= 0) this.sinceIgnition += dt;
    const t = this.sinceIgnition;
    this.ignition = t < 0 ? 0 : smoothstep(0, 5.5, t);

    this.vigor = clamp(1 + this.global.step(dt), 0.72, 1.3);
    this.wind = this.breeze.step(dt) * 0.11;

    for (const e of this.emitters) {
      const ou = e.ou.step(dt);
      e.flare *= Math.exp(-dt / 0.9);
      e.nextFlare -= dt;
      if (e.nextFlare <= 0) {
        e.flare = Math.min(2.2, e.flare + randRange(this.rng, 0.35, 1.0));
        e.nextFlare = expInterval(this.rng, 1 / 18);
      }
      const local = t < 0 ? 0 : smoothstep(e.spec.delay, e.spec.delay + 2.8, t);
      const breathing = clamp(1 + 0.42 * ou, 0.12, 1.9);
      e.strength = e.spec.base * breathing * (1 + 0.55 * e.flare) * this.vigor * local;
    }

    const breath = this.emberBreath.step(dt);
    this.emberGain = (0.32 + 0.68 * this.ignition) * clamp(1 + 0.08 * breath, 0.8, 1.2);
    for (let i = 0; i < 3; i++) {
      const v = clamp(1 + 0.22 * this.emberLocal[i].step(dt) + 0.08 * breath, 0.45, 1.6);
      const k = (0.0016 + 0.0026 * this.ignition) * v;
      this.emberLights[i].r = k;
      this.emberLights[i].g = k * 0.3;
      this.emberLights[i].b = k * 0.06;
    }
  }

  /** Writes the emitter uniforms (see REACT_FRAG) in domain uv units. */
  fillUniforms(emitA: Float32Array, emitB: Float32Array): void {
    emitA.fill(0);
    emitB.fill(0);
    const inv = 1 / FIRE_DOMAIN.size;
    this.emitters.forEach((e, i) => {
      emitA[i * 4 + 0] = (e.spec.x - FIRE_DOMAIN.x0) * inv;
      emitA[i * 4 + 1] = (e.spec.y - FIRE_DOMAIN.y0) * inv;
      emitA[i * 4 + 2] = e.spec.halfWidth * inv;
      emitA[i * 4 + 3] = e.spec.halfHeight * inv;
      emitB[i * 4 + 0] = e.strength;
      emitB[i * 4 + 1] = e.seed;
      emitB[i * 4 + 2] = e.strength > 0.01 ? e.spec.pilot * Math.min(1, 0.6 + e.strength * 0.5) : 0;
      emitB[i * 4 + 3] = e.rate;
    });
  }
}
