/** Tuned constants of the fire simulation and of the final look. */

export const SIM_PARAMS = {
  /** Fuel released per second by an emitter of strength 1. */
  fuelRate: 14,
  /** Temperature at which fuel starts burning (negative: always burning). */
  ignition: -1,
  /** Fraction of fuel burned per second. */
  burnRate: 6,
  /** Temperature released per unit of burned fuel. */
  heat: 1.5,
  /** Radiative cooling coefficient (dT/dt = -k T²). */
  cooling: 10,
  /** Smoke produced per unit of burned fuel. */
  soot: 0.4,
  smokeDecay: 0.85,
  fuelDecay: 0.7,
  /** Upward acceleration per unit of temperature (uv / s²). */
  buoyancy: 4.5,
  smokeWeight: 0.05,
  /** Lateral flicker forcing. */
  turbulence: 0.9,
  drag: 0.6,
  /** Extra upward push right at the emitters. */
  jet: 1.5,
  vorticity: 6,
  velocityDissipation: 0.12,
  pressureWarmStart: 0.8,
} as const;

export const LOOK_PARAMS = {
  /** Flame colour: kelvin at T = 0, kelvin per unit T, gain, edge exponent. */
  flame: [650, 900, 4.6, 1.6] as [number, number, number, number],
  /** Temperature range of the luminous edge of the flames. */
  flameRange: [0.4, 0.74] as [number, number],
  lightScale: 0.75,
  ambient: 0.09,
  ambientFloor: 0.0018,
  fireGain: 1,
  smoke: 0.35,
  /** UV jitter applied when sampling the simulation (sub-grid detail). */
  detail: 0.006,
  exposure: 1.0,
  bloomStrength: 0.07,
  bloomRadius: 1.0,
  haze: 0.0032,
  grain: 0.032,
  vignette: 0.55,
} as const;
