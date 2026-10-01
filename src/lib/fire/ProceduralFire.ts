import type { GLCapabilities } from "./gl/context";
import { Program } from "./gl/program";
import { FullscreenTriangle } from "./gl/quad";
import { createTarget, disposeTarget, type RenderTarget } from "./gl/targets";
import { FULLSCREEN_VERT, NOISE_GLSL, TIME_WRAP, precisionHeader } from "./shaders/common";
import { MAX_EMITTERS } from "./shaders/sim";
import type { FireSource } from "./FluidFire";
import type { FireDynamics } from "./dynamics";

/**
 * Fallback for devices that cannot render into floating point textures:
 * noise-shaped flame tongues driven by the same emitters as the fluid
 * simulation. Written into an 8-bit texture (temperature / 2).
 */
const PROCEDURAL_FRAG = /* glsl */ `
${NOISE_GLSL}
uniform vec4 uEmitA[${MAX_EMITTERS}];
uniform vec4 uEmitB[${MAX_EMITTERS}];
uniform float uTime;
varying vec2 vUv;

void main() {
  float T = 0.0;
  float smoke = 0.0;
  for (int i = 0; i < ${MAX_EMITTERS}; i++) {
    vec4 a = uEmitA[i];
    vec4 b = uEmitB[i];
    if (b.x <= 0.0) continue;
    float height = 0.1 + 0.2 * b.x;
    vec2 d = vUv - a.xy;
    float y = d.y / height;
    if (y < -0.3 || y > 1.6) continue;
    float rate = 1.4 + b.w;
    float t = uTime * rate;
    float n1 = vnoiseP(vec2(vUv.x * 9.0 + b.y, vUv.y * 6.0 - t), floor(rate * 1000.0 + 0.5)) - 0.5;
    float n2 = vnoiseP(vec2(vUv.x * 23.0 - b.y, vUv.y * 15.0 - t * 2.0), floor(rate * 2000.0 + 0.5)) - 0.5;
    float lift = smoothstep(-0.1, 1.0, y);
    float dx = d.x + (n1 * 0.08 + n2 * 0.035) * lift;
    float width = a.z * 1.25 * (1.0 - 0.8 * clamp(y, 0.0, 1.0));
    float profile = 1.0 - smoothstep(0.0, max(width, 0.002), abs(dx));
    float top = 0.45 + 0.5 * (n1 + 0.5);
    float vertical = smoothstep(-0.3, 0.05, y) * (1.0 - smoothstep(top, 1.25, y + n2 * 0.7));
    // Same temperature range as the fluid simulation: ~1.1 in the core, ~0.5 at the edges.
    float flame = profile * vertical * (0.55 + 0.4 * min(b.x, 1.4));
    T = max(T, flame * (1.15 - 0.5 * clamp(y, 0.0, 1.0)));
    smoke = max(smoke, profile * smoothstep(0.6, 1.4, y) * 0.5);
  }
  gl_FragColor = vec4(clamp(T * 0.5, 0.0, 1.0), 0.0, clamp(smoke * 0.5, 0.0, 1.0), 1.0);
}
`;

export class ProceduralFire implements FireSource {
  readonly stateScale = 2;
  private readonly target: RenderTarget;
  private readonly program: Program;
  private readonly emitA = new Float32Array(MAX_EMITTERS * 4);
  private readonly emitB = new Float32Array(MAX_EMITTERS * 4);

  constructor(
    private readonly caps: GLCapabilities,
    private readonly quad: FullscreenTriangle,
  ) {
    const gl = caps.gl;
    this.program = new Program(gl, FULLSCREEN_VERT, precisionHeader(caps.highp) + PROCEDURAL_FRAG, "procedural-fire");
    this.target = createTarget(gl, 256, 256, { format: caps.rgba8, type: gl.UNSIGNED_BYTE, filter: gl.LINEAR });
  }

  get stateTexture(): WebGLTexture {
    return this.target.texture;
  }

  step(dt: number, time: number, dynamics: FireDynamics): void {
    if (dt <= 0) return;
    const gl = this.caps.gl;
    gl.disable(gl.BLEND);
    dynamics.fillUniforms(this.emitA, this.emitB);
    this.program
      .use()
      .set4fv("uEmitA", this.emitA)
      .set4fv("uEmitB", this.emitB)
      .set1f("uTime", time % TIME_WRAP);
    this.quad.draw(this.target);
  }

  dispose(): void {
    disposeTarget(this.caps.gl, this.target);
    this.program.dispose();
  }
}
