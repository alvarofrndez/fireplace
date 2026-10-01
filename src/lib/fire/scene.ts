/**
 * Scene description shared by the CPU (camera, emitters, sparks) and the GPU
 * (ray-traced fireplace). Units are meters. The fireplace opening is the plane
 * z = 0, the camera lives at z > 0 looking towards -z and +y is up.
 */

export type Vec3 = [number, number, number];

const DEG = Math.PI / 180;

export const FIREBOX = {
  openHalfWidth: 0.5,
  openHeight: 0.76,
  lintelDepth: 0.09,
  backZ: -0.44,
  backHalfWidth: 0.33,
  /** Height where the back wall starts leaning forward (smoke shelf). */
  shelfY: 0.6,
  /** Depth reached by the leaning back wall at the top of the firebox. */
  throatZ: -0.3,
  topY: 0.9,
} as const;

export const HEARTH = {
  depth: 0.48,
  halfWidth: 0.86,
  height: 0.07,
} as const;

/** Depth of the plane on which the flames are simulated (center of the log pile). */
export const FLAME_Z = -0.22;

/** Square simulation domain on the flame plane. */
export const FIRE_DOMAIN = {
  x0: -0.5,
  y0: 0.0,
  size: 1.0,
} as const;

export interface LogSpec {
  center: Vec3;
  /** Rotation around the vertical axis in degrees (positive: right end goes back). */
  yaw: number;
  /** Tilt of the log axis in degrees (positive: right end goes up). */
  pitch: number;
  radius: number;
  halfLength: number;
  seed: number;
  /** 0 = fresh bark, 1 = fully charred. */
  char: number;
}

export const LOGS: LogSpec[] = [
  // Back log (largest), resting on the coal bed.
  { center: [0.015, 0.082, -0.315], yaw: 3, pitch: 0.8, radius: 0.075, halfLength: 0.26, seed: 1.7, char: 0.85 },
  // Front log.
  { center: [-0.025, 0.066, -0.115], yaw: -5, pitch: -1.2, radius: 0.061, halfLength: 0.235, seed: 4.3, char: 0.7 },
  // Top log crossing over both.
  { center: [0.03, 0.178, -0.215], yaw: 15, pitch: 5, radius: 0.054, halfLength: 0.215, seed: 7.9, char: 0.95 },
  // Thin branch leaning from the floor onto the back log.
  { center: [-0.262, 0.094, -0.215], yaw: 58, pitch: 34, radius: 0.024, halfLength: 0.135, seed: 9.4, char: 1.0 },
];

/** How hot each log is (drives the glow of its cracks). */
export const LOG_HEAT = [0.95, 0.75, 1.0, 0.85];

export function logAxis(log: LogSpec): Vec3 {
  const cy = Math.cos(log.yaw * DEG);
  const sy = Math.sin(log.yaw * DEG);
  const cp = Math.cos(log.pitch * DEG);
  const sp = Math.sin(log.pitch * DEG);
  return [cy * cp, sp, -sy * cp];
}

/** Bed of embers lying under the logs (ellipse on the floor). */
export const COAL_BED = {
  cx: 0.0,
  cz: -0.215,
  rx: 0.36,
  rz: 0.215,
} as const;

/**
 * Fire light probes: a 4x3 grid of cells on the flame plane. Each frame the
 * emission of the simulated flames is integrated per cell and used as the
 * intensity of a point light placed at the cell center.
 */
export const LIGHT_COLUMNS = [-0.27, -0.09, 0.09, 0.27] as const;
export const LIGHT_ROWS = [0.275, 0.43, 0.63] as const;
export const LIGHT_CELL_X_EDGES = [-0.5, -0.18, 0.0, 0.18, 0.5] as const;
export const LIGHT_CELL_Y_EDGES = [0.04, 0.34, 0.52, 0.95] as const;

export function fireLightPositions(): Vec3[] {
  const out: Vec3[] = [];
  for (const y of LIGHT_ROWS) {
    for (const x of LIGHT_COLUMNS) out.push([x, y, FLAME_Z]);
  }
  return out;
}

/** Point lights representing the glow of the ember bed (left, center, right). */
export const EMBER_LIGHTS: Vec3[] = [
  [-0.19, 0.035, -0.2],
  [0.0, 0.03, -0.25],
  [0.19, 0.035, -0.22],
];

export interface Camera {
  position: Vec3;
  right: Vec3;
  up: Vec3;
  forward: Vec3;
  tanHalfFovY: number;
  aspect: number;
}

/**
 * Frames the fireplace for any aspect ratio. The fire (region of interest) is
 * always fully visible; wide screens reveal more of the stone surround while
 * portrait screens move the camera back and show more wall and hearth.
 */
export function frameCamera(aspect: number): Camera {
  const fovY = 34 * DEG;
  const tanHalfFovY = Math.tan(fovY / 2);
  // On narrow / portrait screens the side walls are allowed to leave the frame
  // so the fire keeps a generous size.
  const portrait = Math.min(1, Math.max(0, (1.12 - aspect) / 0.6));
  const roiWidth = 1.04 - 0.3 * portrait;
  const roiHeight = 0.93;
  const visibleHeight = Math.max(roiHeight, roiWidth / aspect);
  const distance = visibleHeight / 2 / tanHalfFovY;

  // Landscape: frame slightly high so the lintel shows at the top edge.
  // Portrait: keep the fire a little below the center.
  const targetY = 0.37 + 0.06 * portrait;
  const pitch = (3 + 4 * portrait) * DEG;

  const target: Vec3 = [0, targetY, FLAME_Z];
  const position: Vec3 = [0, targetY + Math.sin(pitch) * distance, FLAME_Z + Math.cos(pitch) * distance];
  const forward = normalize(sub(target, position));
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);

  return { position, right, up, forward, tanHalfFovY, aspect };
}

/** Projects a world position to normalized device coordinates (x, y in [-1, 1]); returns null if behind. */
export function projectToNdc(camera: Camera, p: Vec3): [number, number, number] | null {
  const d = sub(p, camera.position);
  const z = dot(d, camera.forward);
  if (z <= 0.01) return null;
  const x = dot(d, camera.right) / (z * camera.tanHalfFovY * camera.aspect);
  const y = dot(d, camera.up) / (z * camera.tanHalfFovY);
  return [x, y, z];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
