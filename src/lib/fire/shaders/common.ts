/**
 * Shared GLSL (ES 1.00) snippets.
 *
 * Long running sessions: every animated noise receives `uTime` wrapped on the
 * CPU (time mod TIME_WRAP) and uses lattice noises that are periodic along the
 * animated axis, so the animation never loses float precision nor jumps when
 * the time wraps. A noise animated as `f(uTime * rate)` must use a period of
 * `rate * TIME_WRAP` lattice cells along its time axis.
 */

export const TIME_WRAP = 1000;

export function precisionHeader(highp: boolean): string {
  return `precision ${highp ? "highp" : "mediump"} float;\n`;
}

export const FULLSCREEN_VERT = /* glsl */ `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

/** Vertex shader for grid passes: also outputs the 4 neighbour texel coordinates. */
export const GRID_VERT = /* glsl */ `
attribute vec2 aPosition;
uniform vec2 uTexel;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  vL = vUv - vec2(uTexel.x, 0.0);
  vR = vUv + vec2(uTexel.x, 0.0);
  vT = vUv + vec2(0.0, uTexel.y);
  vB = vUv - vec2(0.0, uTexel.y);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

export const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

vec3 hash32(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}

// Value noise in [0, 1].
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Value noise in [0, 1], periodic along y with an integer period (in lattice cells).
float vnoiseP(vec2 p, float period) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float y0 = mod(i.y, period);
  float y1 = mod(i.y + 1.0, period);
  float a = hash12(vec2(i.x, y0));
  float b = hash12(vec2(i.x + 1.0, y0));
  float c = hash12(vec2(i.x, y1));
  float d = hash12(vec2(i.x + 1.0, y1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// 3D value noise in [0, 1], periodic along z with an integer period (in lattice cells).
float vnoise3P(vec3 p, float period) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float z0 = mod(i.z, period);
  float z1 = mod(i.z + 1.0, period);
  float a0 = hash13(vec3(i.x, i.y, z0));
  float b0 = hash13(vec3(i.x + 1.0, i.y, z0));
  float c0 = hash13(vec3(i.x, i.y + 1.0, z0));
  float d0 = hash13(vec3(i.x + 1.0, i.y + 1.0, z0));
  float a1 = hash13(vec3(i.x, i.y, z1));
  float b1 = hash13(vec3(i.x + 1.0, i.y, z1));
  float c1 = hash13(vec3(i.x, i.y + 1.0, z1));
  float d1 = hash13(vec3(i.x + 1.0, i.y + 1.0, z1));
  float l0 = mix(mix(a0, b0, u.x), mix(c0, d0, u.x), u.y);
  float l1 = mix(mix(a1, b1, u.x), mix(c1, d1, u.x), u.y);
  return mix(l0, l1, u.z);
}

// Gradient noise, roughly in [-1, 1].
float gnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 ga = hash22(i) * 2.0 - 1.0;
  vec2 gb = hash22(i + vec2(1.0, 0.0)) * 2.0 - 1.0;
  vec2 gc = hash22(i + vec2(0.0, 1.0)) * 2.0 - 1.0;
  vec2 gd = hash22(i + vec2(1.0, 1.0)) * 2.0 - 1.0;
  float va = dot(ga, f);
  float vb = dot(gb, f - vec2(1.0, 0.0));
  float vc = dot(gc, f - vec2(0.0, 1.0));
  float vd = dot(gd, f - vec2(1.0, 1.0));
  return 1.5 * mix(mix(va, vb, u.x), mix(vc, vd, u.x), u.y);
}

float fbm4(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p = m * p + 3.17;
    a *= 0.5;
  }
  return s / 0.9375;
}

float fbm6(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 6; i++) {
    s += a * vnoise(p);
    p = m * p + 3.17;
    a *= 0.5;
  }
  return s / 0.984375;
}

float gfbm4(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 4; i++) {
    s += a * gnoise(p);
    p = m * p + 1.31;
    a *= 0.5;
  }
  return s;
}
`;
