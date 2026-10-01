import type { GLCapabilities } from "./gl/context";
import { Program } from "./gl/program";
import { FullscreenTriangle } from "./gl/quad";
import { DoubleTarget, bindTexture, createTarget, disposeTarget, type RenderTarget } from "./gl/targets";
import { GRID_VERT, TIME_WRAP, precisionHeader } from "./shaders/common";
import {
  ADVECT_FRAG,
  CURL_FRAG,
  DIVERGENCE_FRAG,
  FORCES_FRAG,
  GRADIENT_FRAG,
  MAX_EMITTERS,
  PRESSURE_FRAG,
  REACT_FRAG,
  SCALE_FRAG,
  VORTICITY_FRAG,
} from "./shaders/sim";
import { SIM_PARAMS } from "./params";
import type { FireDynamics } from "./dynamics";
import type { QualitySettings } from "./quality";

/** Common interface of the flame generators (GPU fluid or procedural fallback). */
export interface FireSource {
  /** Texture holding r = temperature, g = fuel, b = smoke in the fire domain. */
  readonly stateTexture: WebGLTexture;
  /** Multiplier to decode the state texture (1 for float textures). */
  readonly stateScale: number;
  step(dt: number, time: number, dynamics: FireDynamics): void;
  dispose(): void;
}

/** 2D GPU fluid simulation of the flames (velocity, pressure, temperature, fuel, smoke). */
export class FluidFire implements FireSource {
  readonly stateScale = 1;
  private readonly velocity: DoubleTarget;
  private readonly state: DoubleTarget;
  private readonly pressure: DoubleTarget;
  private readonly divergence: RenderTarget;
  private readonly curl: RenderTarget;
  private readonly programs: Record<
    "react" | "forces" | "advect" | "divergence" | "curl" | "vorticity" | "pressure" | "gradient" | "scale",
    Program
  >;
  private readonly emitA = new Float32Array(MAX_EMITTERS * 4);
  private readonly emitB = new Float32Array(MAX_EMITTERS * 4);

  constructor(
    private readonly caps: GLCapabilities,
    private readonly quad: FullscreenTriangle,
    private readonly quality: QualitySettings,
  ) {
    const gl = caps.gl;
    const header = precisionHeader(caps.highp);
    const make = (frag: string, label: string) => new Program(gl, GRID_VERT, header + frag, label);
    this.programs = {
      react: make(REACT_FRAG, "react"),
      forces: make(FORCES_FRAG, "forces"),
      advect: make(ADVECT_FRAG, "advect"),
      divergence: make(DIVERGENCE_FRAG, "divergence"),
      curl: make(CURL_FRAG, "curl"),
      vorticity: make(VORTICITY_FRAG, "vorticity"),
      pressure: make(PRESSURE_FRAG, "pressure"),
      gradient: make(GRADIENT_FRAG, "gradient"),
      scale: make(SCALE_FRAG, "scale"),
    };

    const linear = gl.LINEAR;
    const nearest = gl.NEAREST;
    const vRes = quality.velocityResolution;
    const sRes = quality.simResolution;
    this.velocity = new DoubleTarget(gl, vRes, vRes, { format: caps.rgHdr, type: caps.hdrType, filter: linear });
    this.state = new DoubleTarget(gl, sRes, sRes, { format: caps.rgbaHdr, type: caps.hdrType, filter: linear });
    this.pressure = new DoubleTarget(gl, vRes, vRes, { format: caps.rHdr, type: caps.hdrType, filter: nearest });
    this.divergence = createTarget(gl, vRes, vRes, { format: caps.rHdr, type: caps.hdrType, filter: nearest });
    this.curl = createTarget(gl, vRes, vRes, { format: caps.rHdr, type: caps.hdrType, filter: nearest });
  }

  get stateTexture(): WebGLTexture {
    return this.state.read.texture;
  }

  step(dt: number, time: number, dynamics: FireDynamics): void {
    if (dt <= 0) return;
    const gl = this.caps.gl;
    const p = this.programs;
    const P = SIM_PARAMS;
    const t = time % TIME_WRAP;
    const vel = this.velocity;
    const vTexX = vel.read.texelX;
    const vTexY = vel.read.texelY;
    gl.disable(gl.BLEND);

    dynamics.fillUniforms(this.emitA, this.emitB);

    // 1. Fuel injection, combustion and cooling.
    p.react
      .use()
      .set2f("uTexel", this.state.read.texelX, this.state.read.texelY)
      .set1i("uState", bindTexture(gl, 0, this.state.read.texture))
      .set1f("uDt", dt)
      .set1f("uTime", t)
      .set4fv("uEmitA", this.emitA)
      .set4fv("uEmitB", this.emitB)
      .set1f("uFuelRate", P.fuelRate)
      .set1f("uIgnition", P.ignition)
      .set1f("uBurnRate", P.burnRate)
      .set1f("uHeat", P.heat)
      .set1f("uCooling", P.cooling)
      .set1f("uSoot", P.soot)
      .set1f("uSmokeDecay", P.smokeDecay)
      .set1f("uFuelDecay", P.fuelDecay);
    this.quad.draw(this.state.write);
    this.state.swap();

    // 2. Buoyancy, turbulence, draft and jets.
    p.forces
      .use()
      .set2f("uTexel", vTexX, vTexY)
      .set1i("uVelocity", bindTexture(gl, 0, vel.read.texture))
      .set1i("uState", bindTexture(gl, 1, this.state.read.texture))
      .set1f("uDt", dt)
      .set1f("uTime", t)
      .set1f("uBuoyancy", P.buoyancy)
      .set1f("uSmokeWeight", P.smokeWeight)
      .set1f("uTurbulence", P.turbulence * (0.85 + 0.3 * dynamics.vigor))
      .set1f("uWind", dynamics.wind)
      .set1f("uDrag", P.drag)
      .set1f("uJet", P.jet)
      .set4fv("uEmitA", this.emitA)
      .set4fv("uEmitB", this.emitB);
    this.quad.draw(vel.write);
    vel.swap();

    // 3. Vorticity confinement.
    p.curl.use().set2f("uTexel", vTexX, vTexY).set1i("uVelocity", bindTexture(gl, 0, vel.read.texture));
    this.quad.draw(this.curl);
    p.vorticity
      .use()
      .set2f("uTexel", vTexX, vTexY)
      .set1i("uVelocity", bindTexture(gl, 0, vel.read.texture))
      .set1i("uCurl", bindTexture(gl, 1, this.curl.texture))
      .set1f("uStrength", P.vorticity)
      .set1f("uDt", dt);
    this.quad.draw(vel.write);
    vel.swap();

    // 4. Pressure projection (incompressibility).
    p.divergence.use().set2f("uTexel", vTexX, vTexY).set1i("uVelocity", bindTexture(gl, 0, vel.read.texture));
    this.quad.draw(this.divergence);

    p.scale
      .use()
      .set2f("uTexel", vTexX, vTexY)
      .set1i("uSource", bindTexture(gl, 0, this.pressure.read.texture))
      .set1f("uScale", P.pressureWarmStart);
    this.quad.draw(this.pressure.write);
    this.pressure.swap();

    p.pressure.use().set2f("uTexel", vTexX, vTexY).set1i("uDivergence", bindTexture(gl, 1, this.divergence.texture));
    for (let i = 0; i < this.quality.pressureIterations; i++) {
      p.pressure.set1i("uPressure", bindTexture(gl, 0, this.pressure.read.texture));
      this.quad.draw(this.pressure.write);
      this.pressure.swap();
    }

    p.gradient
      .use()
      .set2f("uTexel", vTexX, vTexY)
      .set1i("uPressure", bindTexture(gl, 0, this.pressure.read.texture))
      .set1i("uVelocity", bindTexture(gl, 1, vel.read.texture));
    this.quad.draw(vel.write);
    vel.swap();

    // 5. Advection of velocity and of the fire state.
    p.advect
      .use()
      .set2f("uTexel", vTexX, vTexY)
      .set1i("uVelocity", bindTexture(gl, 0, vel.read.texture))
      .set1i("uSource", bindTexture(gl, 0, vel.read.texture))
      .set1f("uDt", dt)
      .set1f("uDissipation", P.velocityDissipation);
    this.quad.draw(vel.write);
    vel.swap();

    p.advect
      .set2f("uTexel", this.state.read.texelX, this.state.read.texelY)
      .set1i("uVelocity", bindTexture(gl, 0, vel.read.texture))
      .set1i("uSource", bindTexture(gl, 1, this.state.read.texture))
      .set1f("uDissipation", 0);
    this.quad.draw(this.state.write);
    this.state.swap();
  }

  dispose(): void {
    const gl = this.caps.gl;
    this.velocity.dispose(gl);
    this.state.dispose(gl);
    this.pressure.dispose(gl);
    disposeTarget(gl, this.divergence);
    disposeTarget(gl, this.curl);
    for (const program of Object.values(this.programs)) program.dispose();
  }
}
