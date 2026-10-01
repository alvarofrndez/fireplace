import type { GL, TextureFormat } from "./context";

export interface RenderTarget {
  texture: WebGLTexture;
  fbo: WebGLFramebuffer;
  width: number;
  height: number;
  texelX: number;
  texelY: number;
}

export interface TargetOptions {
  format: TextureFormat;
  type: number;
  filter: number;
  wrap?: number;
}

export function createTarget(gl: GL, width: number, height: number, options: TargetOptions): RenderTarget {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const wrap = options.wrap ?? gl.CLAMP_TO_EDGE;

  const texture = gl.createTexture();
  const fbo = gl.createFramebuffer();
  if (!texture || !fbo) throw new Error("No se pudo crear un render target");

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, options.filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, options.filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  gl.texImage2D(gl.TEXTURE_2D, 0, options.format.internalFormat, w, h, 0, options.format.format, options.type, null);

  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  return { texture, fbo, width: w, height: h, texelX: 1 / w, texelY: 1 / h };
}

export function disposeTarget(gl: GL, target: RenderTarget | null | undefined): void {
  if (!target) return;
  gl.deleteTexture(target.texture);
  gl.deleteFramebuffer(target.fbo);
}

/** Ping-pong pair used by simulation passes that read and write the same field. */
export class DoubleTarget {
  read: RenderTarget;
  write: RenderTarget;

  constructor(gl: GL, width: number, height: number, options: TargetOptions) {
    this.read = createTarget(gl, width, height, options);
    this.write = createTarget(gl, width, height, options);
  }

  get width(): number {
    return this.read.width;
  }

  get height(): number {
    return this.read.height;
  }

  swap(): void {
    const tmp = this.read;
    this.read = this.write;
    this.write = tmp;
  }

  dispose(gl: GL): void {
    disposeTarget(gl, this.read);
    disposeTarget(gl, this.write);
  }
}

/** Binds a texture to the given unit and returns the unit index (for sampler uniforms). */
export function bindTexture(gl: GL, unit: number, texture: WebGLTexture): number {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  return unit;
}
