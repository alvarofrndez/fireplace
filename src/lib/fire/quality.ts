import type { GLCapabilities } from "./gl/context";

export interface QualitySettings {
  name: "high" | "medium" | "low";
  /** Upper bound for the number of rendered pixels. */
  maxPixels: number;
  /** Upper bound for the device pixel ratio used. */
  maxDpr: number;
  /** Resolution of the fire state grid. */
  simResolution: number;
  /** Resolution of the velocity / pressure grid. */
  velocityResolution: number;
  pressureIterations: number;
  bloomLevels: number;
  haze: boolean;
}

const PRESETS: Record<QualitySettings["name"], QualitySettings> = {
  high: {
    name: "high",
    maxPixels: 2560 * 1440,
    maxDpr: 2,
    simResolution: 320,
    velocityResolution: 128,
    pressureIterations: 24,
    bloomLevels: 7,
    haze: true,
  },
  medium: {
    name: "medium",
    maxPixels: 1920 * 1080,
    maxDpr: 1.5,
    simResolution: 256,
    velocityResolution: 112,
    pressureIterations: 20,
    bloomLevels: 6,
    haze: true,
  },
  low: {
    name: "low",
    maxPixels: 1280 * 720,
    maxDpr: 1,
    simResolution: 192,
    velocityResolution: 80,
    pressureIterations: 14,
    bloomLevels: 5,
    haze: false,
  },
};

const WEAK_GPU = /(swiftshader|llvmpipe|softpipe|mali-[234]|mali-t[67]|adreno \(tm\) [2-4]|powervr sgx|intel\(r\) hd graphics [2-5]\d{2,3}\b|gma)/i;
const TV_AGENT = /(smart-?tv|smarttv|tizen|web0s|webos|hbbtv|netcast|viera|bravia|aftb|aftm|crkey|appletv)/i;

export function detectQuality(caps: GLCapabilities): QualitySettings {
  if (typeof navigator === "undefined") return PRESETS.medium;
  const ua = navigator.userAgent;
  const gpu = caps.gpu;
  const coarse = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (coarse && navigator.maxTouchPoints > 1);
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 4;

  if (!caps.highp || WEAK_GPU.test(gpu) || TV_AGENT.test(ua) || memory <= 2 || cores <= 2) {
    return { ...PRESETS.low };
  }
  if (mobile) return { ...PRESETS.medium };
  return { ...PRESETS.high };
}

/** One step down, used when the frame rate cannot keep up. */
export function lowerQuality(current: QualitySettings): QualitySettings | null {
  if (current.name === "high") return { ...PRESETS.medium };
  if (current.name === "medium") return { ...PRESETS.low };
  return null;
}
