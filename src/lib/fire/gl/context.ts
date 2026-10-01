/**
 * WebGL context creation and capability detection.
 *
 * The renderer works on WebGL2 and WebGL1. Everything is written in GLSL ES 1.00
 * (accepted by both), so the only differences between both APIs are the texture
 * formats and the extensions used to render into half-float targets.
 */

export type GL = WebGLRenderingContext | WebGL2RenderingContext;

export interface TextureFormat {
  internalFormat: number;
  format: number;
}

export interface GLCapabilities {
  gl: GL;
  isWebGL2: boolean;
  /** True when we can render into (and linearly filter) half-float textures. */
  floatTargets: boolean;
  /** Pixel type for simulation / HDR targets (HALF_FLOAT or UNSIGNED_BYTE fallback). */
  hdrType: number;
  rgbaHdr: TextureFormat;
  rgHdr: TextureFormat;
  rHdr: TextureFormat;
  rgba8: TextureFormat;
  highp: boolean;
  maxTextureSize: number;
  /** Unmasked GPU name when exposed by the browser (used for quality heuristics). */
  gpu: string;
}

const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: false,
  depth: false,
  stencil: false,
  antialias: false,
  premultipliedAlpha: false,
  preserveDrawingBuffer: false,
  powerPreference: "default",
  failIfMajorPerformanceCaveat: false,
};

function isWebGL2Context(gl: GL): gl is WebGL2RenderingContext {
  return typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
}

/** Checks whether a texture of the given format/type can be attached as a color buffer. */
function canRenderTo(gl: GL, format: TextureFormat, type: number): boolean {
  const texture = gl.createTexture();
  const fbo = gl.createFramebuffer();
  if (!texture || !fbo) return false;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, format.internalFormat, 4, 4, 0, format.format, type, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.deleteFramebuffer(fbo);
  gl.deleteTexture(texture);
  // Swallow any error raised by an unsupported texImage2D call.
  while (gl.getError() !== gl.NO_ERROR) {
    /* drain */
  }
  return ok;
}

function readGpuName(gl: GL): string {
  try {
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    if (info) return String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? "");
    return String(gl.getParameter(gl.RENDERER) ?? "");
  } catch {
    return "";
  }
}

export function createGLContext(canvas: HTMLCanvasElement): GLCapabilities | null {
  let gl: GL | null = null;
  try {
    gl = canvas.getContext("webgl2", CONTEXT_ATTRIBUTES);
    if (!gl) {
      gl =
        (canvas.getContext("webgl", CONTEXT_ATTRIBUTES) as WebGLRenderingContext | null) ??
        (canvas.getContext("experimental-webgl", CONTEXT_ATTRIBUTES) as WebGLRenderingContext | null);
    }
  } catch {
    gl = null;
  }
  if (!gl) return null;

  const isWebGL2 = isWebGL2Context(gl);
  const rgba8: TextureFormat = { internalFormat: gl.RGBA, format: gl.RGBA };

  let hdrType: number = gl.UNSIGNED_BYTE;
  let rgbaHdr = rgba8;
  let rgHdr = rgba8;
  let rHdr = rgba8;
  let floatTargets = false;

  if (isWebGL2) {
    const gl2 = gl as WebGL2RenderingContext;
    const colorFloat = gl2.getExtension("EXT_color_buffer_float") ?? gl2.getExtension("EXT_color_buffer_half_float");
    if (colorFloat) {
      const rgba = { internalFormat: gl2.RGBA16F, format: gl2.RGBA };
      const rg = { internalFormat: gl2.RG16F, format: gl2.RG };
      const r = { internalFormat: gl2.R16F, format: gl2.RED };
      if (canRenderTo(gl2, rgba, gl2.HALF_FLOAT)) {
        floatTargets = true;
        hdrType = gl2.HALF_FLOAT;
        rgbaHdr = rgba;
        rgHdr = canRenderTo(gl2, rg, gl2.HALF_FLOAT) ? rg : rgba;
        rHdr = canRenderTo(gl2, r, gl2.HALF_FLOAT) ? r : rgHdr;
      }
    }
  } else {
    const halfFloat = gl.getExtension("OES_texture_half_float");
    const halfFloatLinear = gl.getExtension("OES_texture_half_float_linear");
    gl.getExtension("EXT_color_buffer_half_float");
    if (halfFloat && halfFloatLinear) {
      const type = halfFloat.HALF_FLOAT_OES;
      if (canRenderTo(gl, rgba8, type)) {
        floatTargets = true;
        hdrType = type;
      }
    }
  }

  let highp = true;
  const precision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
  if (!precision || precision.precision === 0) highp = false;

  return {
    gl,
    isWebGL2,
    floatTargets,
    hdrType,
    rgbaHdr,
    rgHdr,
    rHdr,
    rgba8,
    highp,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    gpu: readGpuName(gl),
  };
}
