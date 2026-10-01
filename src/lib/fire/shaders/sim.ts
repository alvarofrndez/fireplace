/**
 * GPU fire simulation (2D incompressible fluid + simple combustion model).
 *
 * Fields:
 *  - velocity (uv units per second) on a coarse grid,
 *  - state on a finer grid: r = temperature, g = fuel, b = smoke.
 *
 * Fuel is injected along the logs, burns once the temperature is above the
 * ignition point (releasing heat and a little smoke), hot gas is pushed up by
 * buoyancy and torn apart by vorticity confinement plus a curl-noise forcing.
 */

import { NOISE_GLSL } from "./common";

export const MAX_EMITTERS = 16;

const EMITTER_UNIFORMS = /* glsl */ `
uniform vec4 uEmitA[${MAX_EMITTERS}]; // xy: center (uv), zw: radii (uv)
uniform vec4 uEmitB[${MAX_EMITTERS}]; // x: strength, y: seed, z: pilot temperature, w: flicker rate
`;

export const REACT_FRAG = /* glsl */ `
${NOISE_GLSL}
${EMITTER_UNIFORMS}
uniform sampler2D uState;
uniform float uDt;
uniform float uTime;
uniform float uFuelRate;
uniform float uIgnition;
uniform float uBurnRate;
uniform float uHeat;
uniform float uCooling;
uniform float uSoot;
uniform float uSmokeDecay;
uniform float uFuelDecay;
varying vec2 vUv;

void main() {
  vec4 s = texture2D(uState, vUv);
  float T = s.r;
  float F = s.g;
  float S = s.b;

  float inject = 0.0;
  float pilot = 0.0;
  for (int i = 0; i < ${MAX_EMITTERS}; i++) {
    vec4 a = uEmitA[i];
    vec4 b = uEmitB[i];
    if (b.x <= 0.0) continue;
    vec2 d = (vUv - a.xy) / a.zw;
    float r2 = dot(d, d);
    if (r2 > 7.0) continue;
    float g = exp(-r2);
    // Flamelets: the emission along the log breaks into several tongues that
    // slowly wander and change size.
    float n1 = vnoiseP(vec2(vUv.x * 40.0 + b.y * 13.7, uTime * b.w + b.y * 7.1), floor(b.w * 1000.0 + 0.5));
    float n2 = vnoiseP(vec2(vUv.x * 93.0 - b.y * 5.3, uTime * b.w * 2.0 + b.y), floor(b.w * 2000.0 + 0.5));
    float m = smoothstep(0.3, 0.85, 0.62 * n1 + 0.38 * n2);
    // Puffing: the base of a flame pulses several times per second.
    float puff = vnoiseP(vec2(b.y * 7.3, uTime * 6.0), 6000.0);
    inject += g * b.x * (0.4 + 1.2 * m) * (0.45 + 1.1 * puff);
    pilot = max(pilot, g * b.z * (0.55 + 0.45 * m));
  }

  F += inject * uFuelRate * uDt;
  T = max(T, pilot);

  float ignite = smoothstep(uIgnition, uIgnition + 0.1, T);
  float burn = F * (1.0 - exp(-uBurnRate * ignite * uDt));
  F -= burn;
  T += burn * uHeat;
  S += burn * uSoot;

  // Radiative-like cooling (dT/dt = -k T^2), integrated exactly.
  T = T / (1.0 + uCooling * T * uDt);
  F *= exp(-uFuelDecay * uDt);
  S *= exp(-uSmokeDecay * uDt);

  // Fade near the side and top borders so nothing sticks to clamped edges.
  float border = smoothstep(0.0, 0.05, vUv.x) * smoothstep(0.0, 0.05, 1.0 - vUv.x) * smoothstep(0.0, 0.08, 1.0 - vUv.y);
  gl_FragColor = vec4(min(T, 2.5), min(F, 4.0), min(S, 3.0), 1.0) * border;
}
`;

export const FORCES_FRAG = /* glsl */ `
${NOISE_GLSL}
${EMITTER_UNIFORMS}
uniform sampler2D uVelocity;
uniform sampler2D uState;
uniform float uDt;
uniform float uTime;
uniform float uBuoyancy;
uniform float uSmokeWeight;
uniform float uTurbulence;
uniform float uWind;
uniform float uDrag;
uniform float uJet;
varying vec2 vUv;

// Divergence-free noise field (curl of a scalar potential), periodic in time.
vec2 curlNoise(vec2 p, float t, float period) {
  const float e = 0.07;
  float n1 = vnoise3P(vec3(p.x, p.y + e, t), period);
  float n2 = vnoise3P(vec3(p.x, p.y - e, t), period);
  float n3 = vnoise3P(vec3(p.x + e, p.y, t), period);
  float n4 = vnoise3P(vec3(p.x - e, p.y, t), period);
  return vec2(n1 - n2, n4 - n3) / (2.0 * e);
}

void main() {
  vec2 vel = texture2D(uVelocity, vUv).xy;
  vec4 s = texture2D(uState, vUv);
  float T = s.r;

  vel.y += uDt * (uBuoyancy * T - uSmokeWeight * s.b);

  // Flicker: lateral waves travelling up the flames (they sway rather than curl),
  // plus a little small-scale curl noise that tears the tips apart.
  float hot = smoothstep(0.02, 0.4, T + 0.35 * s.b);
  float height = smoothstep(0.1, 0.55, vUv.y);
  float sway = 0.6 * vnoiseP(vec2(vUv.x * 5.0, vUv.y * 4.0 - uTime * 1.7), 1700.0)
             + 0.4 * vnoiseP(vec2(vUv.x * 9.0 + 3.1, vUv.y * 7.0 - uTime * 2.9), 2900.0) - 0.5;
  vec2 tear = curlNoise(vUv * vec2(16.0, 11.0) + 5.3, uTime * 1.9, 1900.0);
  vel.x += uDt * uTurbulence * sway * 2.0 * hot * (0.35 + height);
  vel += uDt * uTurbulence * 0.35 * tear * hot * height;
  vel.x += uDt * uWind * hot;

  float jet = 0.0;
  for (int i = 0; i < ${MAX_EMITTERS}; i++) {
    vec4 a = uEmitA[i];
    vec4 b = uEmitB[i];
    if (b.x <= 0.0) continue;
    vec2 d = (vUv - a.xy) / (a.zw * vec2(1.0, 1.6));
    jet += exp(-dot(d, d)) * b.x;
  }
  vel.y += uDt * uJet * jet;

  vel /= 1.0 + uDrag * uDt;
  gl_FragColor = vec4(vel, 0.0, 1.0);
}
`;

export const ADVECT_FRAG = /* glsl */ `
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform float uDt;
uniform float uDissipation;
varying vec2 vUv;

void main() {
  // Second order (midpoint) back-tracing.
  vec2 v1 = texture2D(uVelocity, vUv).xy;
  vec2 mid = vUv - 0.5 * uDt * v1;
  vec2 v2 = texture2D(uVelocity, mid).xy;
  vec2 coord = vUv - uDt * v2;
  gl_FragColor = texture2D(uSource, coord) / (1.0 + uDissipation * uDt);
}
`;

export const DIVERGENCE_FRAG = /* glsl */ `
uniform sampler2D uVelocity;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;

void main() {
  float L = texture2D(uVelocity, vL).x;
  float R = texture2D(uVelocity, vR).x;
  float T = texture2D(uVelocity, vT).y;
  float B = texture2D(uVelocity, vB).y;
  vec2 C = texture2D(uVelocity, vUv).xy;
  // Solid walls on the sides and the floor, open top.
  if (vL.x < 0.0) L = -C.x;
  if (vR.x > 1.0) R = -C.x;
  if (vB.y < 0.0) B = -C.y;
  if (vT.y > 1.0) T = C.y;
  gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}
`;

export const CURL_FRAG = /* glsl */ `
uniform sampler2D uVelocity;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;

void main() {
  float L = texture2D(uVelocity, vL).y;
  float R = texture2D(uVelocity, vR).y;
  float T = texture2D(uVelocity, vT).x;
  float B = texture2D(uVelocity, vB).x;
  gl_FragColor = vec4(0.5 * ((R - L) - (T - B)), 0.0, 0.0, 1.0);
}
`;

export const VORTICITY_FRAG = /* glsl */ `
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float uStrength;
uniform float uDt;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;

void main() {
  float L = texture2D(uCurl, vL).x;
  float R = texture2D(uCurl, vR).x;
  float T = texture2D(uCurl, vT).x;
  float B = texture2D(uCurl, vB).x;
  float C = texture2D(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 1e-5;
  force *= uStrength * C;
  force.y *= -1.0;
  vec2 vel = texture2D(uVelocity, vUv).xy + force * uDt;
  gl_FragColor = vec4(vel, 0.0, 1.0);
}
`;

export const PRESSURE_FRAG = /* glsl */ `
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;

void main() {
  float L = texture2D(uPressure, vL).x;
  float R = texture2D(uPressure, vR).x;
  float T = texture2D(uPressure, vT).x;
  float B = texture2D(uPressure, vB).x;
  if (vT.y > 1.0) T = 0.0;
  float div = texture2D(uDivergence, vUv).x;
  gl_FragColor = vec4((L + R + B + T - div) * 0.25, 0.0, 0.0, 1.0);
}
`;

export const GRADIENT_FRAG = /* glsl */ `
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;

void main() {
  float L = texture2D(uPressure, vL).x;
  float R = texture2D(uPressure, vR).x;
  float T = texture2D(uPressure, vT).x;
  float B = texture2D(uPressure, vB).x;
  if (vT.y > 1.0) T = 0.0;
  vec2 vel = texture2D(uVelocity, vUv).xy;
  vel -= 0.5 * vec2(R - L, T - B);
  gl_FragColor = vec4(vel, 0.0, 1.0);
}
`;

export const SCALE_FRAG = /* glsl */ `
uniform sampler2D uSource;
uniform float uScale;
varying vec2 vUv;

void main() {
  gl_FragColor = texture2D(uSource, vUv) * uScale;
}
`;

/**
 * Flame colour from the simulated temperature. Chromaticity follows Wien's
 * approximation of black body radiation for the red, green and blue
 * wavelengths, intensity follows an artistic curve.
 * uFlame: x = kelvin at T = 0, y = kelvin per unit of T, z = gain, w = curve exponent.
 */
export const FLAME_COLOR_GLSL = /* glsl */ `
uniform vec4 uFlame;
uniform vec2 uFlameRange;

vec3 flameColor(float t) {
  float x = clamp(t, 0.0, 1.8);
  float kelvin = uFlame.x + uFlame.y * x;
  vec3 chroma = vec3(1.0, 1.677 * exp(-2573.0 / kelvin), 3.887 * exp(-7355.0 / kelvin));
  // Luminous zone: a fairly sharp edge, then brighter towards the hot core.
  float edge = smoothstep(uFlameRange.x, uFlameRange.y, x);
  float intensity = uFlame.z * pow(edge, uFlame.w) * (0.22 + x * x);
  return chroma * intensity;
}
`;

/**
 * Integrates the flame emission over a 4x3 grid of cells. Each texel becomes
 * the intensity of one of the point lights that illuminate the fireplace.
 * The result is blended with the previous frame to emulate the light
 * integration of a camera sensor.
 */
export const LIGHT_GRID_FRAG = /* glsl */ `
${FLAME_COLOR_GLSL}
uniform sampler2D uState;
uniform sampler2D uPrevious;
uniform float uStateScale;
uniform float uBlend;
uniform float uEncode;
uniform float uCellX[5];
uniform float uCellY[4];
varying vec2 vUv;

void main() {
  float ix = floor(vUv.x * 4.0);
  float iy = floor(vUv.y * 3.0);
  float x0 = 0.0;
  float x1 = 1.0;
  float y0 = 0.0;
  float y1 = 1.0;
  for (int i = 0; i < 4; i++) {
    if (float(i) == ix) {
      x0 = uCellX[i];
      x1 = uCellX[i + 1];
    }
  }
  for (int j = 0; j < 3; j++) {
    if (float(j) == iy) {
      y0 = uCellY[j];
      y1 = uCellY[j + 1];
    }
  }
  vec3 sum = vec3(0.0);
  for (int j = 0; j < 7; j++) {
    for (int i = 0; i < 6; i++) {
      vec2 uv = vec2(mix(x0, x1, (float(i) + 0.5) / 6.0), mix(y0, y1, (float(j) + 0.5) / 7.0));
      sum += flameColor(texture2D(uState, uv).r * uStateScale);
    }
  }
  float area = (x1 - x0) * (y1 - y0);
  vec3 current = sum / 42.0 * area;
  vec3 previous = texture2D(uPrevious, vUv).rgb / uEncode;
  gl_FragColor = vec4(mix(previous, current, uBlend) * uEncode, 1.0);
}
`;
