import { createGLContext, type GLCapabilities } from "./gl/context";
import { Program } from "./gl/program";
import { FullscreenTriangle } from "./gl/quad";
import { DoubleTarget, bindTexture, createTarget, disposeTarget, type RenderTarget } from "./gl/targets";
import { FULLSCREEN_VERT, TIME_WRAP, precisionHeader } from "./shaders/common";
import { LIGHT_GRID_FRAG } from "./shaders/sim";
import { BAKE_FRAG, COMPOSITE_FRAG } from "./shaders/scene";
import { DOWNSAMPLE_FRAG, FINAL_FRAG, SPARK_FRAG, SPARK_VERT, UPSAMPLE_FRAG } from "./shaders/post";
import { FluidFire, type FireSource } from "./FluidFire";
import { ProceduralFire } from "./ProceduralFire";
import { FireDynamics } from "./dynamics";
import { SPARK_VERTEX_STRIDE, Sparks } from "./sparks";
import { LOOK_PARAMS } from "./params";
import { detectQuality, type QualitySettings } from "./quality";
import {
  EMBER_LIGHTS,
  FIRE_DOMAIN,
  FLAME_Z,
  LIGHT_CELL_X_EDGES,
  LIGHT_CELL_Y_EDGES,
  LOGS,
  LOG_HEAT,
  fireLightPositions,
  frameCamera,
  logAxis,
  type Camera,
} from "./scene";

export interface FireRendererOptions {
  onContextLost?: () => void;
  onContextRestored?: () => void;
}

/** Frames closer than this are skipped: caps the work around 60-90 fps on high refresh displays. */
const MIN_FRAME_MS = 10.5;
const MAX_DT = 0.05;
/** HDR encoding used when float render targets are unavailable. */
const LDR_HDR_RANGE = 8;
const LDR_GRID_ENCODE = 4;

type ProgramName = "lightGrid" | "bake" | "composite" | "down" | "up" | "final" | "spark";

/**
 * Renders the fireplace into a canvas with WebGL.
 *
 * Frame: fire simulation → light probes → scene composite (baked G-buffer +
 * fire light + embers + flames) → sparks → bloom → tone mapping / grain.
 */
export class FireRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly options: FireRendererOptions;
  private caps!: GLCapabilities;
  private quality!: QualitySettings;
  private quad!: FullscreenTriangle;
  private fire!: FireSource;
  private programs!: Record<ProgramName, Program>;
  private sparkBuffer!: WebGLBuffer;
  private sparkData = -1;
  private sparkColor = -1;
  private lightGrid!: DoubleTarget;
  private gbuffer: RenderTarget[] = [];
  private hdr: RenderTarget | null = null;
  private bloom: RenderTarget[] = [];

  private width = 0;
  private height = 0;
  private camera: Camera = frameCamera(16 / 9);
  private readonly dynamics = new FireDynamics();
  private readonly sparks = new Sparks();
  private readonly lightUniform = new Float32Array(15 * 3);
  private readonly logPos = new Float32Array(LOGS.length * 4);
  private readonly logAxis = new Float32Array(LOGS.length * 4);
  private readonly logInfo = new Float32Array(LOGS.length * 4);
  private readonly emberUniform = new Float32Array(9);
  private readonly cellX = new Float32Array(LIGHT_CELL_X_EDGES.length);
  private readonly cellY = new Float32Array(LIGHT_CELL_Y_EDGES.length);

  private time = 0;
  private frame = 0;
  private lastDt = 1 / 60;
  private loopActive = false;
  private rafId = 0;
  private lastTs = -1;
  /** Whether the user wants the fire animated (play) or frozen (pause). */
  private playing = false;
  private timeScale = 0;
  private timeScaleTarget = 0;
  private fade = 1;
  private fadeTarget = 1;
  private needsBake = true;
  private contextLost = false;
  private disposed = false;
  private renderScale = 1;
  private resizeTimer: number | null = null;
  private readonly resizeObserver: ResizeObserver | null = null;
  private perfSamples: number[] = [];
  private slowWindows = 0;
  private warmup = 0;

  constructor(canvas: HTMLCanvasElement, options: FireRendererOptions = {}) {
    this.canvas = canvas;
    this.options = options;
    this.initGL();

    const fillCells = (target: Float32Array, edges: readonly number[], origin: number) =>
      edges.forEach((e, i) => (target[i] = (e - origin) / FIRE_DOMAIN.size));
    fillCells(this.cellX, LIGHT_CELL_X_EDGES, FIRE_DOMAIN.x0);
    fillCells(this.cellY, LIGHT_CELL_Y_EDGES, FIRE_DOMAIN.y0);
    this.fillSceneUniforms();

    canvas.addEventListener("webglcontextlost", this.handleContextLost, false);
    canvas.addEventListener("webglcontextrestored", this.handleContextRestored, false);
    document.addEventListener("visibilitychange", this.handleVisibility);
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.scheduleResize());
      this.resizeObserver.observe(canvas);
    } else {
      window.addEventListener("resize", this.scheduleResize);
    }
    this.applyResize();
  }

  /** Starts the flames (ember bed glowing → logs catching fire). */
  ignite(): void {
    this.dynamics.ignite();
  }

  play(): void {
    this.playing = true;
    this.timeScaleTarget = 1;
    this.fadeTarget = 1;
    this.startLoop();
  }

  /** Smoothly slows the fire down to a still, dimmed image. */
  pause(): void {
    this.playing = false;
    this.timeScaleTarget = 0;
    this.fadeTarget = 0.55;
    this.startLoop();
  }

  /** Spark burst + local flare, triggered by loud pops of the audio engine. */
  sparkBurst(strength: number, pan: number): void {
    if (!this.loopActive || !this.playing) return;
    this.sparks.burst(this.dynamics, strength, pan);
    this.dynamics.flare(pan * 0.22, 0.25 + strength * 0.6);
  }

  /** Renders a single frame without advancing the animation. */
  renderStill(): void {
    if (this.contextLost || this.disposed) return;
    this.render();
  }

  get qualityName(): string {
    return this.quality.name;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopLoop();
    if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
    this.resizeObserver?.disconnect();
    window.removeEventListener("resize", this.scheduleResize);
    document.removeEventListener("visibilitychange", this.handleVisibility);
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost, false);
    this.canvas.removeEventListener("webglcontextrestored", this.handleContextRestored, false);
    if (!this.contextLost) this.destroyGL();
  }

  // ------------------------------------------------------------------ setup

  private initGL(): void {
    const caps = createGLContext(this.canvas);
    if (!caps) throw new Error("WebGL no está disponible en este navegador");
    this.caps = caps;
    if (!this.quality) this.quality = detectQuality(caps);
    const gl = caps.gl;
    const header = precisionHeader(caps.highp);
    const make = (vert: string, frag: string, label: string) => new Program(gl, vert, header + frag, label);

    this.quad = new FullscreenTriangle(gl);
    this.programs = {
      lightGrid: make(FULLSCREEN_VERT, LIGHT_GRID_FRAG, "light-grid"),
      bake: make(FULLSCREEN_VERT, BAKE_FRAG, "bake"),
      composite: make(FULLSCREEN_VERT, COMPOSITE_FRAG, "composite"),
      down: make(FULLSCREEN_VERT, DOWNSAMPLE_FRAG, "bloom-down"),
      up: make(FULLSCREEN_VERT, UPSAMPLE_FRAG, "bloom-up"),
      final: make(FULLSCREEN_VERT, FINAL_FRAG, "final"),
      spark: make(SPARK_VERT, SPARK_FRAG, "sparks"),
    };

    const buffer = gl.createBuffer();
    if (!buffer) throw new Error("No se pudo crear el buffer de chispas");
    this.sparkBuffer = buffer;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.sparks.vertexData.byteLength, gl.DYNAMIC_DRAW);
    this.sparkData = gl.getAttribLocation(this.programs.spark.program, "aData");
    this.sparkColor = gl.getAttribLocation(this.programs.spark.program, "aColor");

    this.fire = caps.floatTargets ? new FluidFire(caps, this.quad, this.quality) : new ProceduralFire(caps, this.quad);
    this.lightGrid = new DoubleTarget(gl, 4, 3, { format: caps.rgbaHdr, type: caps.hdrType, filter: gl.NEAREST });
    this.needsBake = true;
  }

  private destroyGL(): void {
    const gl = this.caps.gl;
    this.disposeScreenTargets();
    this.lightGrid.dispose(gl);
    this.fire.dispose();
    for (const program of Object.values(this.programs)) program.dispose();
    gl.deleteBuffer(this.sparkBuffer);
    this.quad.dispose();
  }

  private fillSceneUniforms(): void {
    LOGS.forEach((log, i) => {
      const axis = logAxis(log);
      this.logPos.set([log.center[0], log.center[1], log.center[2], log.radius], i * 4);
      this.logAxis.set([axis[0], axis[1], axis[2], log.halfLength], i * 4);
      this.logInfo.set([log.seed, log.char, LOG_HEAT[i] ?? 0.8, 0], i * 4);
    });
    const lights = [...fireLightPositions(), ...EMBER_LIGHTS];
    lights.forEach((l, i) => this.lightUniform.set(l, i * 3));
  }

  private get hdrOutputScale(): number {
    return this.caps.floatTargets ? 1 : 1 / LDR_HDR_RANGE;
  }

  private get gridEncode(): number {
    return this.caps.floatTargets ? 1 : LDR_GRID_ENCODE;
  }

  // ----------------------------------------------------------------- resize

  private scheduleResize = (): void => {
    if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
    // The first layout is applied right away, later ones are debounced (re-baking is not free).
    const delay = this.hdr ? 180 : 0;
    this.resizeTimer = window.setTimeout(() => {
      this.resizeTimer = null;
      this.applyResize();
    }, delay);
  };

  private applyResize(): void {
    if (this.contextLost || this.disposed) return;
    const cssWidth = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const cssHeight = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, this.quality.maxDpr);
    let w = cssWidth * dpr * this.renderScale;
    let h = cssHeight * dpr * this.renderScale;
    const pixels = w * h;
    if (pixels > this.quality.maxPixels) {
      const k = Math.sqrt(this.quality.maxPixels / pixels);
      w *= k;
      h *= k;
    }
    const maxSize = Math.min(this.caps.maxTextureSize, 4096);
    w = Math.max(16, Math.min(maxSize, Math.round(w)));
    h = Math.max(16, Math.min(maxSize, Math.round(h)));
    if (w === this.width && h === this.height && this.hdr) return;

    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.camera = frameCamera(w / h);
    this.createScreenTargets();
    this.needsBake = true;
    if (!this.loopActive) this.render();
  }

  private disposeScreenTargets(): void {
    const gl = this.caps.gl;
    for (const t of this.gbuffer) disposeTarget(gl, t);
    for (const t of this.bloom) disposeTarget(gl, t);
    disposeTarget(gl, this.hdr);
    this.gbuffer = [];
    this.bloom = [];
    this.hdr = null;
  }

  private createScreenTargets(): void {
    const gl = this.caps.gl;
    const caps = this.caps;
    this.disposeScreenTargets();
    const w = this.width;
    const h = this.height;
    for (let i = 0; i < 6; i++) {
      this.gbuffer.push(createTarget(gl, w, h, { format: caps.rgba8, type: gl.UNSIGNED_BYTE, filter: gl.NEAREST }));
    }
    this.hdr = createTarget(gl, w, h, { format: caps.rgbaHdr, type: caps.hdrType, filter: gl.LINEAR });
    let bw = w;
    let bh = h;
    for (let i = 0; i < this.quality.bloomLevels; i++) {
      bw = Math.floor(bw / 2);
      bh = Math.floor(bh / 2);
      if (bw < 2 || bh < 2) break;
      this.bloom.push(createTarget(gl, bw, bh, { format: caps.rgbaHdr, type: caps.hdrType, filter: gl.LINEAR }));
    }
  }

  // ------------------------------------------------------------------- loop

  private startLoop(): void {
    if (this.loopActive || this.disposed || this.contextLost) return;
    if (typeof document !== "undefined" && document.hidden) return;
    this.loopActive = true;
    this.lastTs = -1;
    this.rafId = requestAnimationFrame(this.tick);
  }

  private stopLoop(): void {
    this.loopActive = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private handleVisibility = (): void => {
    if (document.hidden) {
      this.stopLoop();
    } else if (this.playing || Math.abs(this.timeScale - this.timeScaleTarget) > 0.001) {
      this.startLoop();
    }
  };

  private handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextLost = true;
    this.stopLoop();
    this.options.onContextLost?.();
  };

  private handleContextRestored = (): void => {
    if (this.disposed) return;
    this.contextLost = false;
    try {
      this.hdr = null;
      this.gbuffer = [];
      this.bloom = [];
      this.width = 0;
      this.height = 0;
      this.initGL();
      this.applyResize();
      if (this.playing) this.startLoop();
      this.options.onContextRestored?.();
    } catch (error) {
      console.error(error);
    }
  };

  private tick = (ts: number): void => {
    if (!this.loopActive) return;
    this.rafId = requestAnimationFrame(this.tick);
    if (this.lastTs < 0) {
      this.lastTs = ts - 1000 / 60;
    }
    const elapsed = ts - this.lastTs;
    if (elapsed < MIN_FRAME_MS) return;
    this.lastTs = ts;
    const dt = Math.min(elapsed / 1000, MAX_DT);
    this.trackPerformance(elapsed);
    this.advance(dt);
    this.render();

    const settled =
      Math.abs(this.timeScale - this.timeScaleTarget) < 0.002 && Math.abs(this.fade - this.fadeTarget) < 0.002;
    if (!this.playing && settled) this.stopLoop();
  };

  private advance(realDt: number): void {
    this.lastDt = realDt;
    this.timeScale += (this.timeScaleTarget - this.timeScale) * (1 - Math.exp(-realDt * 3.2));
    this.fade += (this.fadeTarget - this.fade) * (1 - Math.exp(-realDt * 3.0));
    if (Math.abs(this.timeScale - this.timeScaleTarget) < 0.002) this.timeScale = this.timeScaleTarget;
    if (Math.abs(this.fade - this.fadeTarget) < 0.002) this.fade = this.fadeTarget;
    const dt = realDt * this.timeScale;
    if (dt <= 1e-6) return;
    this.time += dt;
    this.dynamics.update(dt);
    this.sparks.update(dt, this.dynamics);
    this.fire.step(dt, this.time, this.dynamics);
  }

  /** Lowers the render resolution when the device cannot keep a fluid frame rate. */
  private trackPerformance(frameMs: number): void {
    if (!this.playing || this.timeScale < 0.95) return;
    if (this.warmup < 120) {
      this.warmup++;
      return;
    }
    this.perfSamples.push(frameMs);
    if (this.perfSamples.length < 90) return;
    const sorted = this.perfSamples.sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    this.perfSamples = [];
    if (median > 23) {
      this.slowWindows++;
      if (this.slowWindows >= 2 && this.renderScale > 0.55) {
        this.slowWindows = 0;
        this.renderScale = Math.max(0.5, this.renderScale * 0.82);
        this.applyResize();
      }
    } else {
      this.slowWindows = 0;
    }
  }

  // ----------------------------------------------------------------- render

  private render(): void {
    if (this.contextLost || this.disposed || !this.hdr) return;
    const gl = this.caps.gl;
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    if (this.needsBake) this.bake();
    this.renderLightGrid();
    this.renderComposite();
    this.renderSparks();
    this.renderBloom();
    this.renderFinal();
    this.frame = (this.frame + 1) % 100000;
  }

  private setCamera(p: Program): Program {
    const c = this.camera;
    return p
      .set3f("uCamPos", c.position[0], c.position[1], c.position[2])
      .set3f("uCamRight", c.right[0], c.right[1], c.right[2])
      .set3f("uCamUp", c.up[0], c.up[1], c.up[2])
      .set3f("uCamFwd", c.forward[0], c.forward[1], c.forward[2])
      .set2f("uViewScale", c.tanHalfFovY * c.aspect, c.tanHalfFovY);
  }

  private setFlameColor(p: Program): Program {
    const [k0, k1, gain, exponent] = LOOK_PARAMS.flame;
    return p.set4f("uFlame", k0, k1, gain, exponent).set2f("uFlameRange", LOOK_PARAMS.flameRange[0], LOOK_PARAMS.flameRange[1]);
  }

  private bake(): void {
    const p = this.programs.bake.use();
    this.setCamera(p)
      .set4fv("uLogPos", this.logPos)
      .set4fv("uLogAxis", this.logAxis)
      .set4fv("uLogInfo", this.logInfo)
      .set3fv("uLights", this.lightUniform)
      .set1f("uFlameZ", FLAME_Z);
    for (let i = 0; i < this.gbuffer.length; i++) {
      p.set1f("uOutput", i);
      this.quad.draw(this.gbuffer[i]);
    }
    this.needsBake = false;
  }

  private renderLightGrid(): void {
    const gl = this.caps.gl;
    const p = this.programs.lightGrid.use();
    this.setFlameColor(p)
      .set1i("uState", bindTexture(gl, 0, this.fire.stateTexture))
      .set1i("uPrevious", bindTexture(gl, 1, this.lightGrid.read.texture))
      .set1f("uStateScale", this.fire.stateScale)
      .set1f("uBlend", 1 - Math.exp(-this.lastDt / 0.03))
      .set1f("uEncode", this.gridEncode)
      .set1fv("uCellX", this.cellX)
      .set1fv("uCellY", this.cellY);
    this.quad.draw(this.lightGrid.write);
    this.lightGrid.swap();
  }

  private renderComposite(): void {
    const gl = this.caps.gl;
    const L = LOOK_PARAMS;
    const d = this.dynamics;
    d.emberLights.forEach((l, i) => this.emberUniform.set([l.r, l.g, l.b], i * 3));
    const p = this.programs.composite.use();
    this.setCamera(p);
    this.setFlameColor(p)
      .set1i("uAlbedo", bindTexture(gl, 0, this.gbuffer[0].texture))
      .set1i("uMisc", bindTexture(gl, 1, this.gbuffer[1].texture))
      .set1i("uG0", bindTexture(gl, 2, this.gbuffer[2].texture))
      .set1i("uG1", bindTexture(gl, 3, this.gbuffer[3].texture))
      .set1i("uG2", bindTexture(gl, 4, this.gbuffer[4].texture))
      .set1i("uG3", bindTexture(gl, 5, this.gbuffer[5].texture))
      .set1i("uLightGrid", bindTexture(gl, 6, this.lightGrid.read.texture))
      .set1i("uState", bindTexture(gl, 7, this.fire.stateTexture))
      .set1f("uStateScale", this.fire.stateScale)
      .set3fv("uEmberLights", this.emberUniform)
      .set1f("uLightScale", L.lightScale)
      .set1f("uAmbient", L.ambient)
      .set1f("uAmbientFloor", L.ambientFloor)
      .set1f("uTime", this.time % TIME_WRAP)
      .set1f("uEmberGain", d.emberGain)
      .set1f("uFireGain", L.fireGain)
      .set1f("uFlameZ", FLAME_Z)
      .set4f("uDomain", FIRE_DOMAIN.x0, FIRE_DOMAIN.y0, FIRE_DOMAIN.size, 1 / FIRE_DOMAIN.size)
      .set1f("uSmoke", L.smoke)
      .set1f("uDetail", L.detail)
      .set1f("uOutputScale", this.hdrOutputScale)
      .set1f("uGridDecode", 1 / this.gridEncode);
    this.quad.draw(this.hdr);
  }

  private renderSparks(): void {
    const gl = this.caps.gl;
    const hdr = this.hdr;
    if (!hdr) return;
    this.sparks.build(this.camera, this.height);
    const count = this.sparks.vertexCount;
    if (count === 0) return;
    const p = this.programs.spark.use();
    p.set1i("uMisc", bindTexture(gl, 0, this.gbuffer[1].texture)).set1f("uOutputScale", this.hdrOutputScale);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.sparkBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.sparks.vertexData.subarray(0, (count * SPARK_VERTEX_STRIDE) / 4));
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, SPARK_VERTEX_STRIDE, 0);
    if (this.sparkData >= 0) {
      gl.enableVertexAttribArray(this.sparkData);
      gl.vertexAttribPointer(this.sparkData, 4, gl.FLOAT, false, SPARK_VERTEX_STRIDE, 8);
    }
    if (this.sparkColor >= 0) {
      gl.enableVertexAttribArray(this.sparkColor);
      gl.vertexAttribPointer(this.sparkColor, 3, gl.FLOAT, false, SPARK_VERTEX_STRIDE, 24);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, hdr.fbo);
    gl.viewport(0, 0, hdr.width, hdr.height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArrays(gl.TRIANGLES, 0, count);
    gl.disable(gl.BLEND);
    if (this.sparkData >= 0) gl.disableVertexAttribArray(this.sparkData);
    if (this.sparkColor >= 0) gl.disableVertexAttribArray(this.sparkColor);
  }

  private renderBloom(): void {
    const gl = this.caps.gl;
    if (!this.hdr || this.bloom.length === 0) return;
    const down = this.programs.down.use();
    let source: RenderTarget = this.hdr;
    this.bloom.forEach((target, i) => {
      down
        .set2f("uTexel", source.texelX, source.texelY)
        .set1f("uKaris", i === 0 ? 1 : 0)
        .set1i("uSource", bindTexture(gl, 0, source.texture));
      this.quad.draw(target);
      source = target;
    });
    const up = this.programs.up.use();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = this.bloom.length - 2; i >= 0; i--) {
      const src = this.bloom[i + 1];
      up.set2f("uTexel", src.texelX, src.texelY)
        .set1f("uRadius", LOOK_PARAMS.bloomRadius)
        .set1f("uWeight", 1)
        .set1i("uSource", bindTexture(gl, 0, src.texture));
      this.quad.draw(this.bloom[i]);
    }
    gl.disable(gl.BLEND);
  }

  private renderFinal(): void {
    const gl = this.caps.gl;
    if (!this.hdr) return;
    const L = LOOK_PARAMS;
    const bloom = this.bloom[0] ?? this.hdr;
    this.programs.final
      .use()
      .set1i("uScene", bindTexture(gl, 0, this.hdr.texture))
      .set1i("uBloom", bindTexture(gl, 1, bloom.texture))
      .set1f("uBloomStrength", this.bloom.length ? L.bloomStrength : 0)
      .set1f("uExposure", L.exposure * this.fade)
      .set1f("uTime", this.time % TIME_WRAP)
      .set1f("uHaze", this.quality.haze ? L.haze : 0)
      .set1f("uGrain", L.grain)
      .set1f("uVignette", L.vignette)
      .set1f("uFrame", this.frame % 1000)
      .set1f("uHdrScale", 1 / this.hdrOutputScale)
      .set1f("uBloomLevels", this.bloom.length)
      .set2f("uAspect", this.width / this.height, 1);
    this.quad.draw(null, this.width, this.height);
  }
}
