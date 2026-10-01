/**
 * Sparks and drifting embers. Simulated on the CPU (a few dozen particles at
 * most) and drawn as motion-blurred streaks additively into the HDR buffer.
 */

import { clamp, createRng, expInterval, gaussian, randRange, type Rng } from "../random";
import { FLAME_Z, projectToNdc, type Camera, type Vec3 } from "./scene";
import type { FireDynamics } from "./dynamics";

const MAX_PARTICLES = 160;
const FLOATS_PER_VERTEX = 9; // pos(2) data(4) color(3)
const VERTICES_PER_PARTICLE = 6;

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  life: number;
  heat: number;
  size: number;
  /** Ember flakes drift slowly and glow dimly, sparks are fast and bright. */
  kind: 0 | 1;
  twinkle: number;
}

/** Cheap smooth 3D noise for the turbulent air (value noise on a hashed lattice). */
function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function noise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = smooth(x - xi);
  const yf = smooth(y - yi);
  const zf = smooth(z - zi);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const c00 = lerp(hash3(xi, yi, zi), hash3(xi + 1, yi, zi), xf);
  const c10 = lerp(hash3(xi, yi + 1, zi), hash3(xi + 1, yi + 1, zi), xf);
  const c01 = lerp(hash3(xi, yi, zi + 1), hash3(xi + 1, yi, zi + 1), xf);
  const c11 = lerp(hash3(xi, yi + 1, zi + 1), hash3(xi + 1, yi + 1, zi + 1), xf);
  return lerp(lerp(c00, c10, yf), lerp(c01, c11, yf), zf) * 2 - 1;
}

export class Sparks {
  private readonly particles: Particle[] = [];
  private readonly rng: Rng;
  private nextSpark: number;
  private nextEmber: number;
  private time = 0;
  readonly vertexData = new Float32Array(MAX_PARTICLES * VERTICES_PER_PARTICLE * FLOATS_PER_VERTEX);
  vertexCount = 0;

  constructor(seed = (Math.random() * 1e9) | 0) {
    this.rng = createRng(seed);
    this.nextSpark = randRange(this.rng, 1, 3);
    this.nextEmber = randRange(this.rng, 0.5, 2);
  }

  get count(): number {
    return this.particles.length;
  }

  /** Burst of sparks, e.g. when a loud pop is heard. `pan` in [-1, 1] picks the side. */
  burst(dynamics: FireDynamics, strength: number, pan = 0): void {
    if (!dynamics.lit) return;
    const rng = this.rng;
    const n = Math.round(clamp(3 + strength * 14 + gaussian(rng) * 2, 2, 22));
    const src = dynamics.randomSource(rng);
    const x = clamp(src.x * 0.4 + pan * 0.18, -0.3, 0.3);
    for (let i = 0; i < n; i++) {
      this.spawn(x + randRange(rng, -0.03, 0.03), src.y + randRange(rng, 0, 0.03), 0, 1 + strength * 0.8);
    }
    if (rng() < 0.6) this.spawn(x, src.y, 1, 1);
  }

  private spawn(x: number, y: number, kind: 0 | 1, energy = 1): void {
    if (this.particles.length >= MAX_PARTICLES) return;
    const rng = this.rng;
    const z = FLAME_Z + randRange(rng, -0.09, 0.08);
    if (kind === 0) {
      const speed = randRange(rng, 0.5, 1.6) * energy;
      const angle = randRange(rng, -0.55, 0.55);
      this.particles.push({
        x,
        y,
        z,
        vx: Math.sin(angle) * speed,
        vy: Math.cos(angle) * speed,
        vz: randRange(rng, -0.15, 0.25),
        age: 0,
        life: randRange(rng, 0.6, 2.4),
        heat: randRange(rng, 0.85, 1.15),
        size: randRange(rng, 0.7, 1.3),
        kind,
        twinkle: randRange(rng, 0, 100),
      });
    } else {
      this.particles.push({
        x,
        y,
        z,
        vx: randRange(rng, -0.05, 0.05),
        vy: randRange(rng, 0.12, 0.35),
        vz: randRange(rng, -0.04, 0.06),
        age: 0,
        life: randRange(rng, 2.5, 5.5),
        heat: randRange(rng, 0.55, 0.85),
        size: randRange(rng, 1.1, 1.8),
        kind,
        twinkle: randRange(rng, 0, 100),
      });
    }
  }

  update(dt: number, dynamics: FireDynamics): void {
    this.time += dt;
    const rng = this.rng;
    const activity = dynamics.ignition * dynamics.vigor;

    if (activity > 0.05) {
      this.nextSpark -= dt * activity;
      while (this.nextSpark <= 0) {
        const src = dynamics.randomSource(rng);
        this.spawn(src.x, src.y + 0.03, 0, 0.9);
        if (rng() < 0.25) this.spawn(src.x + randRange(rng, -0.02, 0.02), src.y + 0.03, 0, 0.8);
        this.nextSpark += expInterval(rng, 0.9);
      }
      this.nextEmber -= dt * activity;
      while (this.nextEmber <= 0) {
        const src = dynamics.randomSource(rng);
        this.spawn(src.x, src.y + 0.06, 1);
        this.nextEmber += expInterval(rng, 0.45);
      }
    }

    const t = this.time;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.age += dt;
      if (p.age >= p.life || p.y > 1.2 || p.y < -0.05) {
        this.particles[i] = this.particles[this.particles.length - 1];
        this.particles.pop();
        continue;
      }
      // Hot air rises fastest above the center of the fire and gets turbulent.
      const plume = Math.exp(-(p.x * p.x) / 0.05) * clamp(1.3 - p.y, 0.2, 1);
      const airUp = 0.25 + 1.05 * plume;
      const s = 6.5;
      const tx = noise3(p.x * s, p.y * s - t * 1.6, t * 0.7 + p.twinkle);
      const ty = noise3(p.x * s + 17.3, p.y * s - t * 1.6, t * 0.7);
      const tz = noise3(p.x * s - 9.1, p.y * s, t * 0.5 + 3.3);
      const airX = tx * 0.55 + dynamics.wind * 2.2;
      const airY = airUp + ty * 0.35;
      const airZ = tz * 0.25 + 0.08;
      const drag = p.kind === 0 ? 2.6 : 5.0;
      const gravity = p.kind === 0 ? 1.25 : 0.12;
      p.vx += ((airX - p.vx) * drag) * dt;
      p.vy += ((airY - p.vy) * drag - gravity) * dt;
      p.vz += ((airZ - p.vz) * drag) * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.z = Math.min(p.z, -0.02);
      p.heat -= dt * (p.kind === 0 ? randRange(rng, 0.35, 0.7) : 0.12);
    }
  }

  /** Builds the streak geometry for the current camera. */
  build(camera: Camera, pixelHeight: number): void {
    const data = this.vertexData;
    let o = 0;
    let count = 0;
    const pxToNdcY = 2 / pixelHeight;
    const pxToNdcX = pxToNdcY / camera.aspect;
    const shutter = 1 / 45;

    for (const p of this.particles) {
      const lifeT = p.age / p.life;
      const fadeIn = clamp(p.age / 0.06, 0, 1);
      const fadeOut = 1 - clamp((lifeT - 0.7) / 0.3, 0, 1);
      const heat = clamp(p.heat, 0, 1.2);
      if (heat <= 0.02) continue;
      const flicker = p.kind === 0
        ? 0.65 + 0.35 * Math.sin(p.twinkle + this.time * (19 + p.twinkle % 7))
        : 0.8 + 0.2 * Math.sin(p.twinkle + this.time * 3);
      const intensity = (p.kind === 0 ? 7.5 : 2.4) * heat * heat * fadeIn * fadeOut * flicker;
      if (intensity < 0.02) continue;

      const head: Vec3 = [p.x, p.y, p.z];
      const tail: Vec3 = [p.x - p.vx * shutter, p.y - p.vy * shutter, p.z - p.vz * shutter];
      const h = projectToNdc(camera, head);
      const tl = projectToNdc(camera, tail);
      if (!h || !tl) continue;

      // Colour: white-yellow when hot, deep orange-red when cooling.
      const r = 1.0;
      const g = clamp(0.18 + 0.62 * (heat - 0.35), 0.08, 0.85);
      const b = clamp(0.02 + 0.35 * (heat - 0.75), 0.0, 0.35);

      let dx = (h[0] - tl[0]) / pxToNdcX;
      let dy = (h[1] - tl[1]) / pxToNdcY;
      let len = Math.hypot(dx, dy);
      const width = (p.kind === 0 ? 1.15 : 1.6) * p.size * Math.max(1, pixelHeight / 1080);
      // Barely moving particles are drawn as a small dot around the head.
      const still = len < width;
      if (still) {
        dx = 0;
        dy = width;
        len = width;
      }
      const ux = dx / len;
      const uy = dy / len;
      // Perpendicular, in NDC.
      const nx = -uy * width * pxToNdcX;
      const ny = ux * width * pxToNdcY;
      // Extend slightly beyond head and tail so the round profile fits.
      const ex = ux * width * 0.5 * pxToNdcX;
      const ey = uy * width * 0.5 * pxToNdcY;
      const hx = h[0] + ex;
      const hy = h[1] + ey;
      const tx = (still ? h[0] : tl[0]) - ex;
      const ty = (still ? h[1] : tl[1]) - ey;
      const depth = h[2];
      const cr = r * intensity;
      const cg = g * intensity;
      const cb = b * intensity;

      const write = (x: number, y: number, across: number, along: number) => {
        data[o++] = x;
        data[o++] = y;
        data[o++] = across;
        data[o++] = along;
        data[o++] = 0;
        data[o++] = depth;
        data[o++] = cr;
        data[o++] = cg;
        data[o++] = cb;
      };
      write(tx - nx, ty - ny, -1, 0);
      write(tx + nx, ty + ny, 1, 0);
      write(hx + nx, hy + ny, 1, 1);
      write(tx - nx, ty - ny, -1, 0);
      write(hx + nx, hy + ny, 1, 1);
      write(hx - nx, hy - ny, -1, 1);
      count += 6;
    }
    this.vertexCount = count;
  }
}

export const SPARK_VERTEX_STRIDE = FLOATS_PER_VERTEX * 4;
