/**
 * Post-processing: physically inspired bloom (13 tap downsample + tent
 * upsample), heat haze, filmic tone mapping, vignette, film grain and dither.
 */

import { NOISE_GLSL } from "./common";

export const DOWNSAMPLE_FRAG = /* glsl */ `
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform float uKaris;
varying vec2 vUv;

vec3 tap(vec2 o) {
  return texture2D(uSource, vUv + o * uTexel).rgb;
}

float karisWeight(vec3 c) {
  return 1.0 / (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722)));
}

void main() {
  vec3 a = tap(vec2(-2.0, 2.0));
  vec3 b = tap(vec2(0.0, 2.0));
  vec3 c = tap(vec2(2.0, 2.0));
  vec3 d = tap(vec2(-2.0, 0.0));
  vec3 e = tap(vec2(0.0, 0.0));
  vec3 f = tap(vec2(2.0, 0.0));
  vec3 g = tap(vec2(-2.0, -2.0));
  vec3 h = tap(vec2(0.0, -2.0));
  vec3 i = tap(vec2(2.0, -2.0));
  vec3 j = tap(vec2(-1.0, 1.0));
  vec3 k = tap(vec2(1.0, 1.0));
  vec3 l = tap(vec2(-1.0, -1.0));
  vec3 m = tap(vec2(1.0, -1.0));

  vec3 result;
  if (uKaris > 0.5) {
    // Karis average on the first mip: tames single bright pixels (sparks).
    vec3 g0 = (j + k + l + m) * 0.25;
    vec3 g1 = (a + b + d + e) * 0.25;
    vec3 g2 = (b + c + e + f) * 0.25;
    vec3 g3 = (d + e + g + h) * 0.25;
    vec3 g4 = (e + f + h + i) * 0.25;
    float w0 = karisWeight(g0) * 0.5;
    float w1 = karisWeight(g1) * 0.125;
    float w2 = karisWeight(g2) * 0.125;
    float w3 = karisWeight(g3) * 0.125;
    float w4 = karisWeight(g4) * 0.125;
    result = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
  } else {
    result = e * 0.125;
    result += (a + c + g + i) * 0.03125;
    result += (b + d + f + h) * 0.0625;
    result += (j + k + l + m) * 0.125;
  }
  gl_FragColor = vec4(max(result, 0.0), 1.0);
}
`;

export const UPSAMPLE_FRAG = /* glsl */ `
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform float uRadius;
uniform float uWeight;
varying vec2 vUv;

void main() {
  vec2 d = uTexel * uRadius;
  vec3 c = texture2D(uSource, vUv).rgb * 4.0;
  c += texture2D(uSource, vUv + vec2(-d.x, 0.0)).rgb * 2.0;
  c += texture2D(uSource, vUv + vec2(d.x, 0.0)).rgb * 2.0;
  c += texture2D(uSource, vUv + vec2(0.0, -d.y)).rgb * 2.0;
  c += texture2D(uSource, vUv + vec2(0.0, d.y)).rgb * 2.0;
  c += texture2D(uSource, vUv + vec2(-d.x, -d.y)).rgb;
  c += texture2D(uSource, vUv + vec2(d.x, -d.y)).rgb;
  c += texture2D(uSource, vUv + vec2(-d.x, d.y)).rgb;
  c += texture2D(uSource, vUv + vec2(d.x, d.y)).rgb;
  gl_FragColor = vec4(c * (uWeight / 16.0), 1.0);
}
`;

export const FINAL_FRAG = /* glsl */ `
${NOISE_GLSL}
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uBloomStrength;
uniform float uExposure;
uniform float uTime;
uniform float uHaze;
uniform float uGrain;
uniform float uVignette;
uniform float uFrame;
uniform float uHdrScale;
uniform float uBloomLevels;
uniform vec2 uAspect;
varying vec2 vUv;

vec3 tonemap(vec3 x) {
  // Narkowicz ACES fit: deep blacks, gentle highlight roll-off.
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

vec3 toDisplay(vec3 c) {
  // sRGB transfer function.
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

void main() {
  vec2 uv = vUv;

  // Heat haze: refraction of the hot air right above the flames.
  float hz = texture2D(uScene, uv).a;
  if (uHaze > 0.0 && hz > 0.004) {
    vec2 q = uv * uAspect * vec2(26.0, 15.0);
    vec2 n = vec2(
      vnoiseP(q + vec2(0.0, -uTime * 3.1), 3100.0),
      vnoiseP(q + vec2(31.4, -uTime * 2.7), 2700.0)) - 0.5;
    uv += n * uHaze * hz;
  }

  vec3 col = texture2D(uScene, uv).rgb;
  vec3 bloom = texture2D(uBloom, uv).rgb;
  if (uHdrScale > 1.001) {
    // 8-bit fallback: values were stored as sqrt(color / range). The bloom chain
    // added up encoded levels, so decode it as the square of their mean.
    col *= col;
    bloom = bloom * bloom / max(uBloomLevels, 1.0);
  }
  col = (col + bloom * uBloomStrength) * uHdrScale;
  col *= uExposure;

  // Lens vignette, normalised to the longest side so every aspect ratio looks alike.
  vec2 vq = (vUv - 0.5) * uAspect / max(uAspect.x, uAspect.y) * 2.0;
  float vig = 1.0 - uVignette * pow(smoothstep(0.3, 1.3, length(vq)), 1.4);
  col *= vig;

  col = toDisplay(tonemap(col));

  // Film grain, stronger in the shadows, plus triangular dither against banding.
  vec2 fc = gl_FragCoord.xy;
  float g = hash12(fc + vec2(uFrame * 17.0, uFrame * 31.0)) + hash12(fc * 1.31 + vec2(uFrame * 7.0, 3.0)) - 1.0;
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col += g * uGrain * (1.0 - 0.7 * lum);
  float dither = hash12(fc + vec2(uFrame * 3.0, 11.0)) - hash12(fc + vec2(5.0, uFrame * 5.0));
  col += dither / 255.0;

  gl_FragColor = vec4(col, 1.0);
}
`;

export const SPARK_VERT = /* glsl */ `
attribute vec2 aPosition;
attribute vec4 aData;   // x: across (-1..1), y: along (0 = tail, 1 = head), z: unused, w: camera distance
attribute vec3 aColor;
varying vec4 vData;
varying vec3 vColor;
varying vec2 vScreen;

void main() {
  vData = aData;
  vColor = aColor;
  vScreen = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

export const SPARK_FRAG = /* glsl */ `
uniform sampler2D uMisc;
uniform float uOutputScale;
varying vec4 vData;
varying vec3 vColor;
varying vec2 vScreen;

void main() {
  // Hidden behind logs / walls (baked depth stored in misc.a, meters / 4).
  float depth = texture2D(uMisc, vScreen).a * 4.0;
  if (vData.w > depth + 0.015) discard;
  float across = vData.x;
  float profile = exp(-across * across * 3.2);
  float tail = smoothstep(0.0, 0.65, vData.y);
  vec3 c = vColor * profile * tail * uOutputScale;
  // Additive on top of sqrt-encoded 8-bit targets (fallback): approximate, but keeps sparks visible.
  gl_FragColor = vec4(uOutputScale < 0.999 ? sqrt(c) * 0.6 : c, 1.0);
}
`;
