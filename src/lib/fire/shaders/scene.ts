/**
 * Fireplace scene shaders.
 *
 * The camera never moves, so the expensive part of the scene (ray tracing the
 * firebox, ray marching the logs and the ember bed, procedural materials and
 * soft shadows) is "baked" once per resolution into a small G-buffer:
 *
 *   albedo  : rgb = sqrt(albedo), a = ember mask
 *   misc    : r = flame visibility, g = ember heat, b = material, a = depth / 4
 *   light0-3: light transfer (N.L * falloff * shadow) towards 16 lights,
 *             sqrt encoded and scaled by 1 / TRANSFER_SCALE.
 *
 * Each frame the composite shader only combines that data with the current
 * intensity of the fire lights, animates the embers and adds the flames.
 */

import { COAL_BED, FIREBOX, HEARTH, LOGS } from "../scene";
import { NOISE_GLSL } from "./common";
import { FLAME_COLOR_GLSL } from "./sim";

export const TRANSFER_SCALE = 64;
export const NUM_LOGS = LOGS.length;

function f(value: number): string {
  const s = value.toFixed(6);
  return s.includes(".") ? s : `${s}.0`;
}

function v3(x: number, y: number, z: number): string {
  return `vec3(${f(x)}, ${f(y)}, ${f(z)})`;
}

function normalize3(x: number, y: number, z: number): [number, number, number] {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}

const leftN = normalize3(FIREBOX.backZ, 0, -(FIREBOX.openHalfWidth - FIREBOX.backHalfWidth));
const rightN = normalize3(-FIREBOX.backZ, 0, -(FIREBOX.openHalfWidth - FIREBOX.backHalfWidth));
const shelfN = normalize3(0, FIREBOX.throatZ - FIREBOX.backZ, -(FIREBOX.topY - FIREBOX.shelfY));
const sideDir = normalize3(FIREBOX.openHalfWidth - FIREBOX.backHalfWidth, 0, FIREBOX.backZ);
const shelfDir = normalize3(0, FIREBOX.topY - FIREBOX.shelfY, FIREBOX.throatZ - FIREBOX.backZ);

const SCENE_DEFINES = /* glsl */ `
#define NUM_LOGS ${NUM_LOGS}
#define OPEN_HW ${f(FIREBOX.openHalfWidth)}
#define OPEN_H ${f(FIREBOX.openHeight)}
#define LINTEL_D ${f(FIREBOX.lintelDepth)}
#define BACK_Z ${f(FIREBOX.backZ)}
#define BACK_HW ${f(FIREBOX.backHalfWidth)}
#define SHELF_Y ${f(FIREBOX.shelfY)}
#define THROAT_Z ${f(FIREBOX.throatZ)}
#define TOP_Y ${f(FIREBOX.topY)}
#define HEARTH_D ${f(HEARTH.depth)}
#define HEARTH_HW ${f(HEARTH.halfWidth)}
#define HEARTH_H ${f(HEARTH.height)}
#define COAL_C vec2(${f(COAL_BED.cx)}, ${f(COAL_BED.cz)})
#define COAL_R vec2(${f(COAL_BED.rx)}, ${f(COAL_BED.rz)})
#define LEFT_N ${v3(...leftN)}
#define RIGHT_N ${v3(...rightN)}
#define LEFT_P ${v3(-FIREBOX.openHalfWidth, 0, 0)}
#define RIGHT_P ${v3(FIREBOX.openHalfWidth, 0, 0)}
#define SIDE_DIR ${v3(...sideDir)}
#define SHELF_N ${v3(...shelfN)}
#define SHELF_P ${v3(0, FIREBOX.shelfY, FIREBOX.backZ)}
#define SHELF_DIR ${v3(...shelfDir)}
#define BED_MIN vec3(-0.5, -0.002, ${f(FIREBOX.backZ)})
#define BED_MAX vec3(0.5, 0.34, -0.001)
#define TRANSFER_SCALE ${f(TRANSFER_SCALE)}

#define M_NONE 0.0
#define M_BACK 1.0
#define M_SIDE 2.0
#define M_FLOOR 3.0
#define M_HEARTH 4.0
#define M_FACADE 5.0
#define M_LOG 6.0
#define M_COAL 7.0
#define M_SHELF 8.0
#define M_THROAT 9.0
#define M_ROOM 10.0
#define M_LINTEL 11.0
#define M_HEDGE 12.0
`;

const CAMERA_GLSL = /* glsl */ `
uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform vec2 uViewScale;

vec3 cameraRay(vec2 uv) {
  vec2 ndc = uv * 2.0 - 1.0;
  return normalize(uCamFwd + uCamRight * (ndc.x * uViewScale.x) + uCamUp * (ndc.y * uViewScale.y));
}
`;

export const BAKE_FRAG = /* glsl */ `
${SCENE_DEFINES}
${NOISE_GLSL}
${CAMERA_GLSL}

uniform vec4 uLogPos[NUM_LOGS];   // xyz center, w radius
uniform vec4 uLogAxis[NUM_LOGS];  // xyz axis, w half length
uniform vec4 uLogInfo[NUM_LOGS];  // x seed, y char level, z heat
uniform vec3 uLights[15];         // 12 fire lights + 3 ember lights
uniform float uOutput;
uniform float uFlameZ;
varying vec2 vUv;

float vnoise3(vec3 p) {
  return vnoise3P(p, 65536.0);
}

// Voronoi: x = distance to the closest point, y = distance to the cell border, z = cell id.
vec3 voronoi(vec2 x) {
  vec2 n = floor(x);
  vec2 f = fract(x);
  vec2 mg = vec2(0.0);
  vec2 mr = vec2(0.0);
  float md = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = hash22(n + g);
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < md) {
        md = d;
        mr = r;
        mg = g;
      }
    }
  }
  float f1 = sqrt(md);
  md = 8.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      vec2 g = mg + vec2(float(i), float(j));
      vec2 o = hash22(n + g);
      vec2 r = g + o - f;
      if (dot(mr - r, mr - r) > 0.00001) {
        md = min(md, dot(0.5 * (mr + r), normalize(r - mr)));
      }
    }
  }
  return vec3(f1, md, hash12(n + mg));
}

// Cheap Voronoi: x = F1 distance, y = cell id.
vec2 voronoiF1(vec2 x) {
  vec2 n = floor(x);
  vec2 f = fract(x);
  float md = 8.0;
  vec2 mc = vec2(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 r = g + hash22(n + g) - f;
      float d = dot(r, r);
      if (d < md) {
        md = d;
        mc = n + g;
      }
    }
  }
  return vec2(sqrt(md), hash12(mc));
}

// ---------------------------------------------------------------- geometry

struct Hit {
  float t;
  vec3 n;
  float mat;
  float id;
};

vec2 boxHit(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax) {
  vec3 safe = vec3(
    abs(rd.x) < 1e-6 ? 1e-6 : rd.x,
    abs(rd.y) < 1e-6 ? 1e-6 : rd.y,
    abs(rd.z) < 1e-6 ? 1e-6 : rd.z);
  vec3 inv = 1.0 / safe;
  vec3 t0 = (bmin - ro) * inv;
  vec3 t1 = (bmax - ro) * inv;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
}

// Analytic trace of the static architecture (room, hearth, surround and firebox).
Hit traceStatic(vec3 ro, vec3 rd) {
  Hit h;
  h.t = 1e6;
  h.n = vec3(0.0, 0.0, 1.0);
  h.mat = M_NONE;
  h.id = 0.0;

  float tz = rd.z < -1e-6 ? -ro.z / rd.z : 1e6;
  float ty = rd.y < -1e-6 ? -ro.y / rd.y : 1e6;

  if (ty < tz) {
    vec3 p = ro + rd * ty;
    if (p.z <= HEARTH_D && abs(p.x) <= HEARTH_HW) {
      h.t = ty;
      h.n = vec3(0.0, 1.0, 0.0);
      h.mat = M_HEARTH;
      return h;
    }
    float tr = (-HEARTH_H - ro.y) / rd.y;
    vec3 pr = ro + rd * tr;
    float te = rd.z < -1e-6 ? (HEARTH_D - ro.z) / rd.z : 1e6;
    vec3 pe = ro + rd * te;
    if (te > ty && te < tr && abs(pe.x) <= HEARTH_HW) {
      h.t = te;
      h.n = vec3(0.0, 0.0, 1.0);
      h.mat = M_HEDGE;
    } else if (pr.z >= 0.0) {
      h.t = tr;
      h.n = vec3(0.0, 1.0, 0.0);
      h.mat = M_ROOM;
    } else {
      h.t = tz;
      h.n = vec3(0.0, 0.0, 1.0);
      h.mat = M_FACADE;
    }
    return h;
  }

  if (tz >= 1e6) return h;
  vec3 pz = ro + rd * tz;
  if (abs(pz.x) >= OPEN_HW || pz.y >= OPEN_H) {
    h.t = tz;
    h.n = vec3(0.0, 0.0, 1.0);
    h.mat = M_FACADE;
    return h;
  }

  // Inside the opening. The lintel soffit is the only non convex part.
  if (rd.y > 1e-6) {
    float tl = (OPEN_H - ro.y) / rd.y;
    vec3 pl = ro + rd * tl;
    if (pl.z >= -LINTEL_D && pl.z <= 0.0) {
      h.t = tl;
      h.n = vec3(0.0, -1.0, 0.0);
      h.mat = M_LINTEL;
      return h;
    }
  }

  float te = 1e6;
  vec3 n = vec3(0.0, 0.0, 1.0);
  float m = M_NONE;
  float side = 0.0;
  if (rd.y < -1e-6) {
    float t = -ro.y / rd.y;
    if (t < te) { te = t; n = vec3(0.0, 1.0, 0.0); m = M_FLOOR; }
  }
  if (rd.y > 1e-6) {
    float t = (TOP_Y - ro.y) / rd.y;
    if (t < te) { te = t; n = vec3(0.0, -1.0, 0.0); m = M_THROAT; }
  }
  if (rd.z < -1e-6) {
    float t = (BACK_Z - ro.z) / rd.z;
    if (t < te) { te = t; n = vec3(0.0, 0.0, 1.0); m = M_BACK; }
  }
  float dn = dot(SHELF_N, rd);
  if (dn > 1e-6) {
    float t = dot(SHELF_N, SHELF_P - ro) / dn;
    if (t < te) { te = t; n = -SHELF_N; m = M_SHELF; }
  }
  dn = dot(LEFT_N, rd);
  if (dn > 1e-6) {
    float t = dot(LEFT_N, LEFT_P - ro) / dn;
    if (t < te) { te = t; n = -LEFT_N; m = M_SIDE; side = -1.0; }
  }
  dn = dot(RIGHT_N, rd);
  if (dn > 1e-6) {
    float t = dot(RIGHT_N, RIGHT_P - ro) / dn;
    if (t < te) { te = t; n = -RIGHT_N; m = M_SIDE; side = 1.0; }
  }
  h.t = te;
  h.n = n;
  h.mat = m;
  h.id = side;
  return h;
}

// ------------------------------------------------------------- log pile SDF

float logSdf(vec4 lp, vec4 la, vec4 li, vec3 p) {
  vec3 d = p - lp.xyz;
  float s = dot(d, la.xyz);
  vec3 rad = d - la.xyz * s;
  float rl = length(rad);
  float r = lp.w;
  float bound = max(rl - r * 1.3, abs(s) - la.w - 0.012);
  if (bound > 0.015) return bound;
  vec3 dir = rad / max(rl, 1e-5);
  float seed = li.x;
  float lumps = vnoise3(vec3(s * 8.0 + seed * 3.1, dir.y * 1.6 + seed, dir.z * 1.6 - dir.x)) - 0.5;
  float plates = vnoise3(vec3(s * 34.0 + seed, dir.y * 9.0, dir.z * 9.0 + dir.x * 9.0)) - 0.5;
  float rr = r * (1.0 + 0.14 * lumps + 0.06 * plates);
  rr -= smoothstep(la.w * 0.72, la.w, abs(s)) * 0.07 * r;
  float cut = abs(s) - la.w + 0.014 * (vnoise3(vec3(dir * 2.3 + seed)) - 0.5);
  vec2 q = vec2(rl - rr, cut);
  return (min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - 0.0025) * 0.8;
}

// Bed of embers: irregular chunks of two sizes, warped so they never line up.
float coalHeight(vec2 xz) {
  vec2 q = (xz - COAL_C) / COAL_R;
  float e = 1.0 - dot(q, q);
  float mask = smoothstep(-0.2, 0.55, e);
  if (mask <= 0.0) return 0.0;
  vec2 w = xz + 0.012 * (vec2(vnoise(xz * 40.0), vnoise(xz * 40.0 + 9.3)) - 0.5);
  vec2 big = voronoiF1(w * 24.0);
  vec2 small = voronoiF1(w * 52.0 + 4.7);
  float chunkA = smoothstep(0.78, 0.18, big.x) * (0.004 + 0.022 * big.y * big.y);
  float chunkB = smoothstep(0.75, 0.2, small.x) * (0.003 + 0.01 * small.y);
  float h = max(chunkA, chunkB) + 0.003 * vnoise(xz * 170.0);
  return (h + 0.004) * mask;
}

float mapBed(vec3 p, out float mat, out float id) {
  float d = (p.y - coalHeight(p.xz)) * 0.55;
  mat = M_COAL;
  id = -1.0;
  for (int i = 0; i < NUM_LOGS; i++) {
    float dl = logSdf(uLogPos[i], uLogAxis[i], uLogInfo[i], p);
    if (dl < d) {
      d = dl;
      mat = M_LOG;
      id = float(i);
    }
  }
  return d;
}

float mapBedDist(vec3 p) {
  float m;
  float i;
  return mapBed(p, m, i);
}

float marchBed(vec3 ro, vec3 rd, float t0, float t1, out float mat, out float id) {
  float t = t0;
  mat = M_NONE;
  id = -1.0;
  for (int k = 0; k < 110; k++) {
    float m;
    float i;
    float d = mapBed(ro + rd * t, m, i);
    if (d < 0.00035 * t) {
      mat = m;
      id = i;
      return t;
    }
    t += d;
    if (t > t1) break;
  }
  return -1.0;
}

vec3 bedNormal(vec3 p) {
  const vec2 k = vec2(1.0, -1.0);
  const float e = 0.0005;
  return normalize(
    k.xyy * mapBedDist(p + k.xyy * e) +
    k.yyx * mapBedDist(p + k.yyx * e) +
    k.yxy * mapBedDist(p + k.yxy * e) +
    k.xxx * mapBedDist(p + k.xxx * e));
}

float bedOcclusion(vec3 p, vec3 n) {
  float occ = 0.0;
  float w = 1.0;
  for (int i = 0; i < 5; i++) {
    float h = 0.006 + 0.019 * float(i);
    float d = mapBedDist(p + n * h) / 0.6;
    occ += w * max(h - d, 0.0);
    w *= 0.72;
  }
  return clamp(1.0 - 5.5 * occ, 0.0, 1.0);
}

// ---------------------------------------------------------------- shadows

float capsuleShadow(vec3 ro, vec3 rd, float tmax, vec3 a, vec3 b, float r, float k) {
  vec3 ba = b - a;
  vec3 oa = ro - a;
  float a1 = dot(rd, ba);
  float a2 = dot(rd, oa);
  float a3 = dot(ba, ba);
  float a4 = dot(ba, oa);
  float den = max(a3 - a1 * a1, 1e-6);
  vec2 th = vec2(-a2 * a3 + a1 * a4, a4 - a1 * a2) / den;
  th.x = clamp(th.x, 0.0005, tmax);
  th.y = clamp(th.y, 0.0, 1.0);
  vec3 pa = a + ba * th.y;
  vec3 pr = ro + rd * th.x;
  float d = length(pa - pr) - r;
  float s = clamp(k * d / th.x + 0.5, 0.0, 1.0);
  return s * s * (3.0 - 2.0 * s);
}

float logShadow(vec3 ro, vec3 rd, float tmax, float skip) {
  float sh = 1.0;
  for (int i = 0; i < NUM_LOGS; i++) {
    if (float(i) == skip) continue;
    vec3 c = uLogPos[i].xyz;
    vec3 ax = uLogAxis[i].xyz * (uLogAxis[i].w - uLogPos[i].w * 0.6);
    sh *= capsuleShadow(ro, rd, tmax, c - ax, c + ax, uLogPos[i].w * 0.92, 2.6);
  }
  return sh;
}

// Light coming from inside the firebox only reaches the room through the opening.
float openingVisibility(vec3 p, vec3 l) {
  if (p.z <= 0.001) return 1.0;
  float t = p.z / max(p.z - l.z, 1e-4);
  vec3 q = mix(p, l, t);
  return smoothstep(-0.025, 0.025, OPEN_HW - abs(q.x)) * smoothstep(-0.03, 0.03, OPEN_H - q.y);
}

float transfer(vec3 p, vec3 n, vec3 lp, float radius, float wrap, float skip) {
  vec3 dl = lp - p;
  float d2 = dot(dl, dl);
  float dist = sqrt(d2);
  vec3 l = dl / dist;
  float ndl = (dot(n, l) + wrap) / (1.0 + wrap);
  if (ndl <= 0.0) return 0.0;
  vec3 o = p + n * 0.004;
  float sh = logShadow(o, l, dist, skip) * openingVisibility(o, lp);
  return ndl * sh / (d2 + radius * radius);
}

// --------------------------------------------------------------- materials

vec4 brickPattern(vec2 uv, vec2 size, float mortarW, float seed, vec3 colA, vec3 colB, vec3 mortarCol) {
  vec2 q = uv / size;
  float row = floor(q.y);
  q.x += 0.5 * mod(row, 2.0) + 0.37 * seed;
  vec2 cell = floor(q);
  vec2 fr = fract(q);
  vec2 de = min(fr, 1.0 - fr) * size;
  float wobble = (vnoise(uv * 70.0 + seed) - 0.5) * mortarW * 0.7;
  float dm = min(de.x, de.y) + wobble;
  float mortar = 1.0 - smoothstep(mortarW * 0.42, mortarW * 0.9, dm);
  float r1 = hash12(cell + seed * 7.3);
  float r2 = hash12(cell * 1.7 + 2.9 + seed);
  float grain = fbm4(uv * 52.0 + r1 * 9.0);
  vec3 col = mix(colA, colB, r1) * (0.7 + 0.55 * grain);
  col *= 1.0 - 0.3 * r2 * r2;
  float speck = smoothstep(0.7, 0.92, vnoise(uv * 360.0 + seed * 3.0));
  col *= 1.0 - 0.3 * speck;
  vec3 mcol = mortarCol * (0.72 + 0.55 * vnoise(uv * 120.0 + seed));
  float rounded = smoothstep(0.0, mortarW * 2.2, dm);
  float height = mix(-0.0022, 0.0016 * rounded + 0.0013 * (grain - 0.5) - 0.0007 * speck, 1.0 - mortar);
  return vec4(mix(col, mcol, mortar), height);
}

vec3 fireBrick(vec2 uv, float seed, vec3 n, vec3 tu, vec3 tv, out vec3 nOut) {
  vec2 size = vec2(0.229, 0.114);
  vec3 ca = vec3(0.44, 0.33, 0.235);
  vec3 cb = vec3(0.6, 0.46, 0.33);
  vec3 cm = vec3(0.3, 0.285, 0.265);
  const float e = 0.0011;
  vec4 c = brickPattern(uv, size, 0.0075, seed, ca, cb, cm);
  float hu = brickPattern(uv + vec2(e, 0.0), size, 0.0075, seed, ca, cb, cm).w;
  float hv = brickPattern(uv + vec2(0.0, e), size, 0.0075, seed, ca, cb, cm).w;
  vec2 g = vec2(hu - c.w, hv - c.w) / e;
  nOut = normalize(n - (tu * g.x + tv * g.y) * 0.9);
  return c.rgb;
}

float sootAt(vec3 p, float base) {
  float hgt = smoothstep(0.0, 0.55, p.y);
  float center = 1.0 - smoothstep(0.06, 0.48, abs(p.x));
  // The plume above the fire blackens the bricks the most.
  float plume = exp(-p.x * p.x / 0.035) * smoothstep(0.12, 0.45, p.y);
  float streaks = fbm4(vec2(p.x * 15.0 + p.z * 11.0, p.y * 2.4 - p.z * 3.0));
  float patches = fbm4(vec2(p.x * 6.0 - p.z * 5.0, p.y * 6.0) + 4.1);
  return clamp(base + 0.5 * hgt + 0.2 * center + 0.35 * plume + 0.6 * (streaks - 0.5) + 0.45 * (patches - 0.5), 0.0, 0.97);
}

vec3 applySoot(vec3 albedo, float soot) {
  // Soot keeps a faint brown tint of the brick underneath.
  return mix(albedo, albedo * 0.08 + vec3(0.012, 0.01, 0.009), soot);
}

vec3 stoneSurround(vec3 p, out vec3 nOut) {
  vec3 n = vec3(0.0, 0.0, 1.0);
  vec3 col;
  float height;
  const float e = 0.0015;
  // A long lintel stone right above the opening, coursed stone everywhere else.
  bool lintel = abs(p.x) < OPEN_HW + 0.15 && p.y > OPEN_H && p.y < OPEN_H + 0.17;
  if (lintel) {
    vec2 uv = p.xy * vec2(1.0, 1.0);
    float g = fbm6(uv * 9.0);
    float g2 = fbm4(uv * 40.0);
    col = vec3(0.27, 0.245, 0.215) * (0.75 + 0.4 * g) * (0.85 + 0.3 * g2);
    float edge = min(min(OPEN_HW + 0.15 - abs(p.x), p.y - OPEN_H), OPEN_H + 0.17 - p.y);
    float joint = 1.0 - smoothstep(0.003, 0.009, edge);
    col = mix(col, vec3(0.1, 0.095, 0.09), joint);
    float h0 = 0.003 * g + 0.002 * g2 - joint * 0.004;
    float hu = 0.003 * fbm6((uv + vec2(e, 0.0)) * 9.0) + 0.002 * fbm4((uv + vec2(e, 0.0)) * 40.0);
    float hv = 0.003 * fbm6((uv + vec2(0.0, e)) * 9.0) + 0.002 * fbm4((uv + vec2(0.0, e)) * 40.0);
    nOut = normalize(n - vec3(hu - h0, hv - h0, 0.0) / e * 0.8);
  } else {
    vec2 size = vec2(0.34, 0.17);
    vec3 ca = vec3(0.22, 0.2, 0.18);
    vec3 cb = vec3(0.33, 0.29, 0.25);
    vec3 cm = vec3(0.12, 0.11, 0.1);
    vec4 c = brickPattern(p.xy + vec2(0.0, 0.03), size, 0.014, 5.0, ca, cb, cm);
    float hu = brickPattern(p.xy + vec2(e, 0.03), size, 0.014, 5.0, ca, cb, cm).w;
    float hv = brickPattern(p.xy + vec2(0.0, 0.03 + e), size, 0.014, 5.0, ca, cb, cm).w;
    col = c.rgb * (0.8 + 0.35 * fbm4(p.xy * 14.0));
    nOut = normalize(n - vec3(hu - c.w, hv - c.w, 0.0) / e * 1.4);
  }
  // Smoke stain rising above the opening.
  float stain = exp(-p.x * p.x / 0.09) * smoothstep(OPEN_H - 0.02, OPEN_H + 0.1, p.y) * (1.0 - smoothstep(OPEN_H + 0.1, OPEN_H + 0.75, p.y));
  stain *= 0.55 + 0.45 * fbm4(p.xy * vec2(8.0, 3.0));
  col = mix(col, vec3(0.025), clamp(stain, 0.0, 0.92));
  // Darker edges where the stone meets the firebox.
  float lip = 1.0 - smoothstep(0.0, 0.05, min(abs(abs(p.x) - OPEN_HW), abs(p.y - OPEN_H) + step(OPEN_HW, abs(p.x))));
  col *= 1.0 - 0.45 * lip * step(p.y, OPEN_H + 0.04);
  return col;
}

vec3 woodFloor(vec3 p) {
  float w = 0.135;
  float plank = floor(p.x / w);
  float fx = fract(p.x / w);
  float r = hash12(vec2(plank, 4.7));
  float grain = fbm4(vec2(p.x * 55.0, p.z * 3.5 + r * 20.0));
  vec3 col = mix(vec3(0.075, 0.045, 0.026), vec3(0.14, 0.085, 0.05), r) * (0.65 + 0.7 * grain);
  float seam = 1.0 - smoothstep(0.0, 0.03, min(fx, 1.0 - fx));
  return col * (1.0 - 0.7 * seam);
}

vec3 hearthStone(vec3 p) {
  float n1 = fbm6(p.xz * 5.0);
  float n2 = vnoise(p.xz * 280.0);
  vec3 col = vec3(0.09, 0.085, 0.08) * (0.7 + 0.55 * n1) * (0.85 + 0.3 * n2);
  // Two slabs.
  float joint = 1.0 - smoothstep(0.0015, 0.004, abs(p.x - 0.02 + 0.01 * sin(p.z * 9.0)));
  col *= 1.0 - 0.6 * joint;
  // Ash dust spilled near the opening.
  float dust = (1.0 - smoothstep(0.0, 0.16, p.z)) * smoothstep(0.4, 0.75, fbm4(p.xz * 22.0)) * (1.0 - smoothstep(0.25, 0.55, abs(p.x)));
  return mix(col, vec3(0.3, 0.29, 0.28), dust * 0.55);
}

vec3 floorShade(vec3 p, out float emberMask, out float emberHeat) {
  vec3 dummy;
  vec3 brick = fireBrick(p.xz + vec2(0.11, 0.03), 3.0, vec3(0.0, 1.0, 0.0), vec3(1.0, 0.0, 0.0), vec3(0.0, 0.0, 1.0), dummy);
  brick = applySoot(brick, 0.55);
  vec2 q = (p.xz - COAL_C) / (COAL_R * 1.55);
  float nearBed = 1.0 - smoothstep(0.55, 1.35, length(q));
  float ashN = fbm4(p.xz * 16.0);
  float cover = clamp(nearBed * 1.25 + (ashN - 0.5) * 1.1 + 0.2, 0.0, 1.0);
  // Fine grey ash, darker and dirtier close to the embers.
  vec3 ash = mix(vec3(0.13, 0.125, 0.12), vec3(0.3, 0.29, 0.28), fbm4(p.xz * 26.0));
  ash *= mix(1.0, 0.65, nearBed);
  float crumbs = smoothstep(0.74, 0.9, vnoise(p.xz * 150.0)) * (0.15 + 0.6 * nearBed);
  ash = mix(ash, vec3(0.025, 0.022, 0.02), clamp(crumbs, 0.0, 1.0));
  vec3 col = mix(brick, ash, cover);
  // A few stray embers in the ash close to the bed.
  float stray = smoothstep(0.82, 0.9, vnoise(p.xz * 120.0 + 7.0)) * nearBed * crumbs;
  emberMask = stray * 0.7;
  emberHeat = 0.45;
  return col;
}

vec3 coalShade(vec3 p, vec3 n, out float emberMask, out float emberHeat) {
  vec2 q = (p.xz - COAL_C) / COAL_R;
  float e = 1.0 - dot(q, q);
  vec2 w = p.xz + 0.012 * (vec2(vnoise(p.xz * 40.0), vnoise(p.xz * 40.0 + 9.3)) - 0.5);
  vec2 v = voronoiF1(w * 24.0);
  float h = p.y;
  // Gaps between chunks are the hottest, deepest parts of the bed.
  float crevice = smoothstep(0.012, 0.0, h - 0.004) * 0.8 + smoothstep(0.42, 0.78, v.x) * 0.5;
  float core = smoothstep(-0.3, 0.8, e);
  float lumpHot = smoothstep(0.45, 1.0, v.y + 0.35 * (vnoise(w * 60.0) - 0.5));
  float crust = vnoise(w * 210.0 + v.y * 13.0);
  float crust2 = vnoise(w * 520.0 - v.y * 7.0);
  vec3 charcoal = vec3(0.03, 0.028, 0.026) * (0.55 + 0.9 * crust * crust2);
  float ashy = smoothstep(0.5, 0.8, vnoise(w * 38.0 + 2.0)) * smoothstep(0.1, 0.8, n.y) * (1.0 - core * 0.5);
  vec3 col = mix(charcoal, vec3(0.38, 0.365, 0.35), ashy * 0.85);
  emberHeat = core * (0.38 + 0.5 * max(lumpHot, crevice * 0.8));
  float glowing = max(crevice, lumpHot * smoothstep(0.35, 0.8, crust) * (0.6 + 0.4 * crust2));
  emberMask = smoothstep(-0.1, 0.55, e) * (0.12 + 0.88 * glowing) * (1.0 - ashy * 0.9);
  // The rim of the bed fades into the surrounding ash instead of ending in a ring.
  float rim = smoothstep(0.3, -0.25, e + 0.25 * (vnoise(p.xz * 30.0) - 0.5));
  vec3 ash = mix(vec3(0.09, 0.085, 0.08), vec3(0.2, 0.19, 0.18), vnoise(p.xz * 26.0));
  col = mix(col, ash, rim * 0.85);
  emberMask *= 1.0 - rim * 0.8;
  return col;
}

void getLog(float idx, out vec4 lp, out vec4 la, out vec4 li) {
  lp = uLogPos[0];
  la = uLogAxis[0];
  li = uLogInfo[0];
  for (int k = 0; k < NUM_LOGS; k++) {
    if (float(k) == idx) {
      lp = uLogPos[k];
      la = uLogAxis[k];
      li = uLogInfo[k];
    }
  }
}

// Height of the log surface: bark fibres on fresh wood, "alligator" char blocks
// separated by cracks on burnt wood. cell = voronoi of the char blocks.
float charHeight(vec2 st, float charAmt, float seed, out vec3 cell) {
  vec2 warp = vec2(vnoise(st * 70.0 + seed), vnoise(st * 70.0 + seed + 17.0)) - 0.5;
  cell = voronoi((st + warp * 0.007) * vec2(56.0, 74.0) + seed * 11.0);
  float crack = 1.0 - smoothstep(0.02, 0.085, cell.y);
  float fibers = fbm4(vec2(st.x * 22.0, st.y * 150.0) + seed);
  float dome = 0.0009 * (1.0 - cell.x * cell.x * 1.4);
  return mix(0.0016 * fibers, dome - 0.0024 * crack + 0.0004 * cell.z, charAmt);
}

vec3 logShade(float idx, vec3 p, vec3 n, out float emberMask, out float emberHeat, out vec3 nOut) {
  vec4 lp;
  vec4 la;
  vec4 li;
  getLog(idx, lp, la, li);
  vec3 a = la.xyz;
  float hl = la.w;
  float r = lp.w;
  float seed = li.x;
  float charLevel = li.y;
  float hot = li.z;

  vec3 d = p - lp.xyz;
  float s = dot(d, a);
  vec3 rad = d - a * s;
  float rl = length(rad);
  vec3 u = normalize(cross(a, vec3(0.0, 1.0, 0.0)));
  vec3 v = cross(u, a);
  float ang = atan(dot(rad, v), dot(rad, u));
  vec3 radDir = rad / max(rl, 1e-5);
  nOut = n;

  float centrality = 1.0 - smoothstep(0.15, 0.95, abs(s) / hl);
  float underside = smoothstep(0.15, -0.75, n.y);
  bool cap = abs(dot(n, a)) > 0.72 && abs(s) > hl * 0.8;

  if (cap) {
    float rr = clamp(rl / r, 0.0, 1.0);
    vec2 cs = vec2(cos(ang), sin(ang));
    float wob = vnoise(cs * 2.5 + rr * 3.0 + seed);
    float rings = 0.5 + 0.5 * sin((rr * 16.0 + wob * 1.8) * 6.2831);
    vec3 wood = mix(vec3(0.24, 0.16, 0.095), vec3(0.4, 0.28, 0.17), rings) * (0.8 + 0.3 * vnoise(cs * 9.0 + rr * 20.0));
    float checks = smoothstep(0.86, 0.97, abs(sin(ang * 2.5 + seed * 3.0 + vnoise(vec2(rr * 4.0, seed)) * 1.5))) * smoothstep(0.15, 0.6, rr);
    wood *= 1.0 - 0.8 * checks;
    float rim = smoothstep(0.55, 0.9, rr + (vnoise(cs * 4.0 + seed) - 0.5) * 0.25);
    float burnt = clamp(rim + charLevel * 0.35, 0.0, 1.0);
    vec3 col = mix(wood, vec3(0.025, 0.022, 0.02), burnt);
    emberMask = (rim * (1.0 - smoothstep(0.93, 1.0, rr)) * 0.55 + checks * 0.35 * burnt) * smoothstep(0.2, 0.8, hot);
    emberHeat = 0.55 * hot;
    return col;
  }

  float arc = ang * r;
  vec2 st = vec2(s, arc);
  float endFade = smoothstep(hl * 0.55, hl * 0.98, abs(s));
  float charN = fbm4(vec2(s * 10.0, arc * 14.0) + seed * 5.0);
  float charAmt = clamp(charLevel * (1.0 - 0.7 * endFade) + (charN - 0.5) * 0.95 + 0.1 * underside, 0.0, 1.0);
  charAmt = smoothstep(0.28, 0.62, charAmt);

  // Bump: bark fibres on fresh wood, alligator cracks on charred wood.
  const float e = 0.0006;
  vec3 cell;
  vec3 cellU;
  vec3 cellV;
  float h0 = charHeight(st, charAmt, seed, cell);
  float hs = charHeight(st + vec2(e, 0.0), charAmt, seed, cellU);
  float ha = charHeight(st + vec2(0.0, e), charAmt, seed, cellV);
  vec3 tAround = normalize(cross(a, radDir));
  nOut = normalize(n - (a * (hs - h0) + tAround * (ha - h0)) / e * 0.8);

  // Cracks of varying width, some of them interrupted.
  float crackWidth = mix(0.035, 0.1, vnoise(st * 45.0 + seed * 2.0));
  float crack = (1.0 - smoothstep(crackWidth * 0.35, crackWidth, cell.y)) * smoothstep(0.18, 0.45, vnoise(st * 130.0 + seed));
  float fibers = fbm4(vec2(s * 22.0, arc * 150.0) + seed);
  float plates = vnoise(vec2(s * 28.0, arc * 40.0) + seed * 3.0);
  vec3 bark = mix(vec3(0.085, 0.058, 0.04), vec3(0.19, 0.13, 0.085), fibers) * (0.7 + 0.55 * plates);
  bark = mix(bark, vec3(0.17, 0.16, 0.14), smoothstep(0.66, 0.86, vnoise(vec2(s * 12.0, arc * 20.0) + 9.0)) * 0.55);

  // Charcoal: dark grey blocks with a slight silvery sheen and white ash on top.
  vec3 charCol = vec3(0.034, 0.031, 0.029) * (0.65 + 0.9 * cell.z);
  float ash = smoothstep(0.2, 0.85, n.y) * smoothstep(0.4, 0.75, vnoise(vec2(s * 24.0, arc * 24.0) + 3.0));
  charCol = mix(charCol, vec3(0.36, 0.35, 0.34), ash * 0.7 * (1.0 - crack));
  charCol *= 1.0 - 0.8 * crack;

  vec3 col = mix(bark, charCol, charAmt);

  // Only some cracks glow: hot zones near the bed, between logs and away from the cold air.
  float facing = smoothstep(0.25, 0.95, n.z);
  float topFace = smoothstep(0.3, 0.9, n.y);
  float hotZone = smoothstep(0.42, 0.82, vnoise(vec2(s * 17.0, arc * 23.0) + seed * 3.0) + 0.4 * underside);
  float heatBase = hot * (0.3 + 0.7 * centrality) * (0.45 + 0.55 * underside) * (1.0 - 0.55 * facing) * (1.0 - 0.45 * topFace);
  emberMask = charAmt * hotZone * (crack * 0.95 + 0.16 * underside) * smoothstep(0.06, 0.38, heatBase);
  emberHeat = heatBase * (0.7 + 0.3 * vnoise(vec2(s * 40.0, arc * 40.0) + 1.0));
  return col;
}

// --------------------------------------------------------------------- main

void main() {
  vec3 ro = uCamPos;
  vec3 rd = cameraRay(vUv);
  Hit h = traceStatic(ro, rd);

  bool interior = h.mat == M_FLOOR || h.mat == M_BACK || h.mat == M_SIDE || h.mat == M_SHELF || h.mat == M_THROAT || h.mat == M_LINTEL;
  if (interior) {
    vec2 bb = boxHit(ro, rd, BED_MIN, BED_MAX);
    float tOpen = -ro.z / rd.z;
    float t0 = max(bb.x, tOpen);
    float t1 = min(bb.y, h.t + 0.002);
    if (t1 > t0) {
      float bm;
      float bi;
      float t = marchBed(ro, rd, t0, t1, bm, bi);
      if (t > 0.0) {
        h.t = t;
        h.mat = bm;
        h.id = bi;
      }
    }
  }

  vec3 p = ro + rd * h.t;
  vec3 n = h.n;
  bool bed = h.mat == M_LOG || h.mat == M_COAL;
  if (bed) {
    n = bedNormal(p);
    if (h.mat == M_COAL) {
      vec2 q = (p.xz - COAL_C) / COAL_R;
      if (dot(q, q) > 1.25) h.mat = M_FLOOR;
    }
  }

  vec3 albedo = vec3(0.0);
  vec3 ns = n;
  float emberMask = 0.0;
  float emberHeat = 0.0;
  float ao = 1.0;
  float openness = 1.0;

  if (h.mat == M_BACK) {
    albedo = fireBrick(p.xy + vec2(0.06, 0.0), 1.0, n, vec3(1.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0), ns);
    albedo = applySoot(albedo, sootAt(p, 0.3));
    ao *= mix(0.45, 1.0, smoothstep(0.0, 0.09, p.y)) * mix(0.6, 1.0, smoothstep(0.0, 0.06, BACK_HW - abs(p.x)));
  } else if (h.mat == M_SIDE) {
    vec3 origin = h.id < 0.0 ? LEFT_P : RIGHT_P;
    vec3 along = h.id < 0.0 ? SIDE_DIR : SIDE_DIR * vec3(-1.0, 1.0, 1.0);
    float sAlong = dot(p - origin, along);
    albedo = fireBrick(vec2(sAlong + 0.03 * h.id, p.y), 2.0 + h.id, n, along, vec3(0.0, 1.0, 0.0), ns);
    albedo = applySoot(albedo, sootAt(p, 0.22) * mix(0.55, 1.0, smoothstep(-0.02, 0.2, -p.z)) + 0.08);
    ao *= mix(0.45, 1.0, smoothstep(0.0, 0.09, p.y)) * mix(0.6, 1.0, smoothstep(0.0, 0.07, p.z - BACK_Z));
  } else if (h.mat == M_SHELF) {
    float sAlong = dot(p - SHELF_P, SHELF_DIR);
    albedo = fireBrick(vec2(p.x + 0.11, sAlong), 4.0, n, vec3(1.0, 0.0, 0.0), SHELF_DIR, ns);
    albedo = applySoot(albedo, 0.62 + 0.3 * fbm4(p.xy * 8.0));
  } else if (h.mat == M_THROAT) {
    albedo = vec3(0.01, 0.009, 0.008) * (0.6 + 0.8 * fbm4(p.xz * 12.0));
  } else if (h.mat == M_LINTEL) {
    albedo = vec3(0.025, 0.022, 0.02) * (0.7 + 0.6 * fbm4(p.xz * 20.0));
  } else if (h.mat == M_FLOOR) {
    albedo = floorShade(p, emberMask, emberHeat);
    ao *= mix(0.55, 1.0, smoothstep(0.0, 0.08, p.z - BACK_Z));
  } else if (h.mat == M_HEARTH) {
    albedo = hearthStone(p);
  } else if (h.mat == M_HEDGE) {
    albedo = hearthStone(p.xzy) * 0.75;
  } else if (h.mat == M_ROOM) {
    albedo = woodFloor(p);
  } else if (h.mat == M_FACADE) {
    if (abs(p.x) < 1.05) {
      albedo = stoneSurround(p, ns);
    } else {
      albedo = vec3(0.16, 0.15, 0.14) * (0.85 + 0.25 * fbm4(p.xy * 6.0));
    }
    // Wall base below the hearth level.
    if (p.y < 0.0) albedo *= 0.6;
  } else if (h.mat == M_LOG) {
    albedo = logShade(h.id, p, n, emberMask, emberHeat, ns);
  } else if (h.mat == M_COAL) {
    albedo = coalShade(p, n, emberMask, emberHeat);
  }

  // Contact occlusion from the log pile (logs, coals and the floor around them).
  if (p.z < 0.02 && p.z > BACK_Z - 0.01 && p.y < 0.4) {
    ao *= bedOcclusion(p, n);
  }
  if (p.z < 0.0) openness = mix(0.85, 0.22, smoothstep(0.0, 0.44, -p.z));
  if (h.mat == M_FACADE) {
    // Firelight bouncing off the hearth warms the stone right around the opening.
    vec2 outside = max(vec2(abs(p.x) - OPEN_HW, p.y - OPEN_H), 0.0);
    float dist = length(outside);
    openness = 0.3 + 1.4 * exp(-dist / 0.16) * smoothstep(-0.1, 0.25, OPEN_H + 0.1 - p.y + 0.3);
  }

  // Flames are drawn on the plane z = uFlameZ: visible in front of whatever lies behind it.
  float tFlame = (uFlameZ - ro.z) / rd.z;
  float flameVis = smoothstep(-0.012, 0.012, h.t - tFlame);
  if (h.mat == M_LOG) flameVis = max(flameVis, smoothstep(0.35, 0.95, n.y) * 0.75);

  if (uOutput < 0.5) {
    gl_FragColor = vec4(sqrt(clamp(albedo, 0.0, 1.0)), clamp(emberMask, 0.0, 1.0));
  } else if (uOutput < 1.5) {
    gl_FragColor = vec4(flameVis, clamp(emberHeat, 0.0, 1.0), h.mat / 16.0, clamp(h.t / 4.0, 0.0, 1.0));
  } else {
    float skip = h.mat == M_LOG ? h.id : -1.0;
    vec4 g = vec4(0.0);
    if (uOutput < 2.5) {
      g.x = transfer(p, ns, uLights[0], 0.09, 0.25, skip);
      g.y = transfer(p, ns, uLights[1], 0.09, 0.25, skip);
      g.z = transfer(p, ns, uLights[2], 0.09, 0.25, skip);
      g.w = transfer(p, ns, uLights[3], 0.09, 0.25, skip);
    } else if (uOutput < 3.5) {
      g.x = transfer(p, ns, uLights[4], 0.1, 0.25, skip);
      g.y = transfer(p, ns, uLights[5], 0.1, 0.25, skip);
      g.z = transfer(p, ns, uLights[6], 0.1, 0.25, skip);
      g.w = transfer(p, ns, uLights[7], 0.1, 0.25, skip);
    } else if (uOutput < 4.5) {
      g.x = transfer(p, ns, uLights[8], 0.12, 0.25, skip);
      g.y = transfer(p, ns, uLights[9], 0.12, 0.25, skip);
      g.z = transfer(p, ns, uLights[10], 0.12, 0.25, skip);
      g.w = transfer(p, ns, uLights[11], 0.12, 0.25, skip);
    } else {
      g.x = transfer(p, ns, uLights[12], 0.06, 0.35, skip);
      g.y = transfer(p, ns, uLights[13], 0.06, 0.35, skip);
      g.z = transfer(p, ns, uLights[14], 0.06, 0.35, skip);
    }
    g *= ao / TRANSFER_SCALE;
    // The last channel stores the (unscaled) ambient / bounce light factor.
    if (uOutput > 4.5) g.w = ao * openness * (0.55 + 0.45 * max(ns.z, 0.0));
    gl_FragColor = sqrt(clamp(g, 0.0, 1.0));
  }
}
`;

/**
 * Per-frame composite: lighting from the baked transfer + current fire lights,
 * animated embers, flames, a hint of smoke and the heat haze mask (alpha).
 */
export const COMPOSITE_FRAG = /* glsl */ `
#define TRANSFER_SCALE ${f(TRANSFER_SCALE)}
${NOISE_GLSL}
${FLAME_COLOR_GLSL}
${CAMERA_GLSL}

uniform sampler2D uAlbedo;
uniform sampler2D uMisc;
uniform sampler2D uG0;
uniform sampler2D uG1;
uniform sampler2D uG2;
uniform sampler2D uG3;
uniform sampler2D uLightGrid;
uniform sampler2D uState;
uniform float uStateScale;
uniform vec3 uEmberLights[3];
uniform float uLightScale;
uniform float uAmbient;
uniform float uAmbientFloor;
uniform float uTime;
uniform float uEmberGain;
uniform float uFireGain;
uniform float uFlameZ;
uniform vec4 uDomain;   // x0, y0, size, 1 / size
uniform float uSmoke;
uniform float uDetail;
uniform float uOutputScale;
uniform float uGridDecode;
varying vec2 vUv;

vec3 gridLight(float i, float j) {
  return texture2D(uLightGrid, vec2((i + 0.5) / 4.0, (j + 0.5) / 3.0)).rgb * uGridDecode;
}

vec3 emberColor(float heat) {
  float h = max(heat, 0.0);
  vec3 c = vec3(1.0, 0.1 + 0.36 * smoothstep(0.45, 1.4, h), 0.012 + 0.1 * smoothstep(0.95, 1.6, h));
  return c * (h * h * 1.7);
}

void main() {
  vec4 alb = texture2D(uAlbedo, vUv);
  vec4 misc = texture2D(uMisc, vUv);
  vec4 g0 = texture2D(uG0, vUv);
  vec4 g1 = texture2D(uG1, vUv);
  vec4 g2 = texture2D(uG2, vUv);
  vec4 g3 = texture2D(uG3, vUv);
  g0 *= g0;
  g1 *= g1;
  g2 *= g2;
  g3 *= g3;

  vec3 l00 = gridLight(0.0, 0.0);
  vec3 l10 = gridLight(1.0, 0.0);
  vec3 l20 = gridLight(2.0, 0.0);
  vec3 l30 = gridLight(3.0, 0.0);
  vec3 l01 = gridLight(0.0, 1.0);
  vec3 l11 = gridLight(1.0, 1.0);
  vec3 l21 = gridLight(2.0, 1.0);
  vec3 l31 = gridLight(3.0, 1.0);
  vec3 l02 = gridLight(0.0, 2.0);
  vec3 l12 = gridLight(1.0, 2.0);
  vec3 l22 = gridLight(2.0, 2.0);
  vec3 l32 = gridLight(3.0, 2.0);

  vec3 irr = g0.x * l00 + g0.y * l10 + g0.z * l20 + g0.w * l30
           + g1.x * l01 + g1.y * l11 + g1.z * l21 + g1.w * l31
           + g2.x * l02 + g2.y * l12 + g2.z * l22 + g2.w * l32;
  irr *= TRANSFER_SCALE * uLightScale;
  irr += (g3.x * uEmberLights[0] + g3.y * uEmberLights[1] + g3.z * uEmberLights[2]) * TRANSFER_SCALE;
  vec3 total = l00 + l10 + l20 + l30 + l01 + l11 + l21 + l31 + l02 + l12 + l22 + l32;
  irr += g3.w * (total * uAmbient + vec3(uAmbientFloor));

  vec3 albedo = alb.rgb * alb.rgb;
  vec3 col = albedo * irr;

  // Embers: slow breathing plus a faster shimmer.
  float mask = alb.a;
  if (mask > 0.003) {
    float slow = vnoise3P(vec3(vUv * vec2(24.0, 13.0), uTime * 0.31), 310.0);
    float slow2 = vnoise3P(vec3(vUv * vec2(9.0, 5.0) + 7.7, uTime * 0.13), 130.0);
    float fast = vnoise3P(vec3(vUv * vec2(80.0, 46.0) + 3.1, uTime * 1.9), 1900.0);
    float pulse = 0.35 + 0.65 * slow * (0.55 + 0.9 * slow2) + 0.25 * (fast - 0.5);
    col += emberColor(misc.g * pulse * uEmberGain) * mask;
  }

  // Flames.
  vec3 rd = cameraRay(vUv);
  float tf = (uFlameZ - uCamPos.z) / rd.z;
  vec2 pf = (uCamPos + rd * tf).xy;
  vec2 fuv = (pf - uDomain.xy) * uDomain.w;
  vec2 dq = fuv * vec2(36.0, 20.0);
  vec2 det = vec2(
    vnoiseP(dq + vec2(0.0, -uTime * 2.4), 2400.0),
    vnoiseP(dq + vec2(19.7, -uTime * 2.4), 2400.0)) - 0.5;
  vec4 st = texture2D(uState, fuv + det * uDetail) * uStateScale;
  float edge = smoothstep(0.0, 0.035, fuv.x) * smoothstep(0.0, 0.035, 1.0 - fuv.x)
             * smoothstep(0.0, 0.06, 1.0 - fuv.y) * step(0.0, fuv.y);
  float vis = misc.r * edge;

  float smoke = smoothstep(0.05, 0.9, st.b) * uSmoke * vis;
  col *= 1.0 - 0.3 * smoke;
  col += smoke * total * vec3(0.05, 0.042, 0.036);

  col += flameColor(st.r) * uFireGain * vis;

  float haze = clamp(st.r * 0.9 + st.b * 0.6, 0.0, 1.0) * edge;
  // 8-bit fallback targets store sqrt(color / range) to keep detail in the shadows.
  vec3 encoded = uOutputScale < 0.999 ? sqrt(max(col * uOutputScale, 0.0)) : col;
  gl_FragColor = vec4(encoded, haze);
}
`;
