import type { GL } from "./context";

export type Uniforms = Record<string, WebGLUniformLocation>;

function compileShader(gl: GL, type: number, source: string, label: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error(`[${label}] No se pudo crear el shader`);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(shader) ?? "";
    const numbered = source
      .split("\n")
      .map((line, index) => `${String(index + 1).padStart(4, " ")}: ${line}`)
      .join("\n");
    gl.deleteShader(shader);
    throw new Error(`[${label}] Error compilando shader:\n${log}\n${numbered}`);
  }
  return shader;
}

/**
 * A linked GLSL program with its active uniform locations cached by name.
 * Array uniforms are reachable both as `name` and `name[0]`.
 */
export class Program {
  readonly program: WebGLProgram;
  readonly uniforms: Uniforms = {};
  private readonly gl: GL;

  constructor(gl: GL, vertexSource: string, fragmentSource: string, label: string) {
    this.gl = gl;
    const program = gl.createProgram();
    if (!program) throw new Error(`[${label}] No se pudo crear el programa`);
    const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource, `${label}.vert`);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource, `${label}.frag`);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    // Every program reads its vertices from attribute 0.
    gl.bindAttribLocation(program, 0, "aPosition");
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
      const log = gl.getProgramInfoLog(program) ?? "";
      gl.deleteProgram(program);
      throw new Error(`[${label}] Error enlazando programa: ${log}`);
    }
    this.program = program;

    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i);
      if (!info) continue;
      const location = gl.getUniformLocation(program, info.name);
      if (!location) continue;
      this.uniforms[info.name] = location;
      if (info.name.endsWith("[0]")) this.uniforms[info.name.slice(0, -3)] = location;
    }
  }

  use(): this {
    this.gl.useProgram(this.program);
    return this;
  }

  has(name: string): boolean {
    return name in this.uniforms;
  }

  set1i(name: string, value: number): this {
    const u = this.uniforms[name];
    if (u) this.gl.uniform1i(u, value);
    return this;
  }

  set1f(name: string, value: number): this {
    const u = this.uniforms[name];
    if (u) this.gl.uniform1f(u, value);
    return this;
  }

  set2f(name: string, x: number, y: number): this {
    const u = this.uniforms[name];
    if (u) this.gl.uniform2f(u, x, y);
    return this;
  }

  set3f(name: string, x: number, y: number, z: number): this {
    const u = this.uniforms[name];
    if (u) this.gl.uniform3f(u, x, y, z);
    return this;
  }

  set4f(name: string, x: number, y: number, z: number, w: number): this {
    const u = this.uniforms[name];
    if (u) this.gl.uniform4f(u, x, y, z, w);
    return this;
  }

  set1fv(name: string, values: Float32Array | number[]): this {
    const u = this.uniforms[name];
    if (u) this.gl.uniform1fv(u, values);
    return this;
  }

  set3fv(name: string, values: Float32Array | number[]): this {
    const u = this.uniforms[name];
    if (u) this.gl.uniform3fv(u, values);
    return this;
  }

  set4fv(name: string, values: Float32Array | number[]): this {
    const u = this.uniforms[name];
    if (u) this.gl.uniform4fv(u, values);
    return this;
  }

  dispose(): void {
    this.gl.deleteProgram(this.program);
  }
}
