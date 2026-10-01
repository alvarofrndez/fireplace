import type { GL } from "./context";
import type { RenderTarget } from "./targets";

/** A single triangle covering the viewport, bound to attribute 0. */
export class FullscreenTriangle {
  private readonly buffer: WebGLBuffer;

  constructor(private readonly gl: GL) {
    const buffer = gl.createBuffer();
    if (!buffer) throw new Error("No se pudo crear el buffer de vértices");
    this.buffer = buffer;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  }

  /** Draws into `target` (or the canvas when null) using the currently bound program. */
  draw(target: RenderTarget | null, canvasWidth = 0, canvasHeight = 0): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, target.width, target.height);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvasWidth, canvasHeight);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    this.gl.deleteBuffer(this.buffer);
  }
}
