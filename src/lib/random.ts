/** Small random helpers shared by the fire renderer and the audio engine. */

export type Rng = () => number;

/**
 * Deterministic PRNG (mulberry32). The state lives in a typed array so the
 * engine never has to box it: this is called millions of times while the
 * sound material is synthesized.
 */
export function createRng(seed: number): Rng {
  const state = new Int32Array([seed | 0 || 0x9e3779b9 | 0]);
  return () => {
    state[0] = (state[0] + 0x6d2b79f5) | 0;
    let t = state[0];
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal sample (Box-Muller). */
export function gaussian(rng: Rng): number {
  let u = 0;
  while (u <= Number.EPSILON) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function randRange(rng: Rng, min: number, max: number): number {
  return min + (max - min) * rng();
}

/** Exponentially distributed waiting time for a Poisson process of the given rate (events / s). */
export function expInterval(rng: Rng, rate: number): number {
  return -Math.log(1 - rng() * 0.999999) / Math.max(rate, 1e-6);
}

export function clamp(x: number, min: number, max: number): number {
  return x < min ? min : x > max ? max : x;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Ornstein-Uhlenbeck process: a mean reverting random walk. Produces organic,
 * never repeating fluctuations with a characteristic time scale `tau` and a
 * stationary standard deviation `sigma`.
 */
export class OrnsteinUhlenbeck {
  value: number;

  constructor(
    private readonly rng: Rng,
    private readonly tau: number,
    private readonly sigma: number,
    private readonly mean = 0,
  ) {
    this.value = mean + gaussian(rng) * sigma * 0.5;
  }

  step(dt: number): number {
    const decay = Math.exp(-dt / this.tau);
    const noise = this.sigma * Math.sqrt(1 - decay * decay);
    this.value = this.mean + (this.value - this.mean) * decay + noise * gaussian(this.rng);
    return this.value;
  }
}
