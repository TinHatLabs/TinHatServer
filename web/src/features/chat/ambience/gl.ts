// gl.ts — the effect layer's renderer (Tin Hat Web): one WebGL2 canvas, one draw call per frame. It draws the shared
// mesh (core.ts AmbienceSim.mesh: triangles, x y r g b a per vertex, colours premultiplied) with no shading at all —
// exactly what the desktop's scene-graph item draws (QSGVertexColorMaterial), so both apps look the same.
const VS = `#version 300 es
in vec2 pos;
in vec4 col;
uniform vec2 view;
out vec4 vcol;
void main() {
  vcol = col;
  gl_Position = vec4(pos.x / view.x * 2.0 - 1.0, 1.0 - pos.y / view.y * 2.0, 0.0, 1.0);
}`;
const FS = `#version 300 es
precision mediump float;
in vec4 vcol;
out vec4 frag;
void main() { frag = vcol; }`;

/** The renderer's name says it rasterises on the CPU. */
export function softwareRenderer(gl: WebGL2RenderingContext): boolean {
  let name = "";
  try {
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    name = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? "");
  } catch {
    name = "";
  }
  return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
}

export class AmbienceGl {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private buf: WebGLBuffer;
  private vao: WebGLVertexArrayObject;
  private uView: WebGLUniformLocation | null;
  private cap = 0;
  private canvas: HTMLCanvasElement;
  lost = false;
  private onLost = (e: Event) => {
    e.preventDefault();
    this.lost = true;
  };

  /** null when there is no WebGL2 on a real GPU (the layer then shows the still background only): a software
   *  rasteriser (SwiftShader, llvmpipe, WARP) would redraw on the CPU every frame. `force` (the worst-case
   *  measurements: force=1 on #/__gallery/ambience) takes one anyway. */
  static create(canvas: HTMLCanvasElement, force = false): AmbienceGl | null {
    let gl: WebGL2RenderingContext | null = null;
    try {
      gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: "low-power", failIfMajorPerformanceCaveat: !force });
    } catch {
      gl = null;
    }
    if (!gl || gl.isContextLost()) return null;
    if (!force && softwareRenderer(gl)) return null;
    try {
      return new AmbienceGl(canvas, gl);
    } catch {
      return null;
    }
  }

  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.gl = gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const why = gl.getShaderInfoLog(s) ?? "shader";
        gl.deleteShader(s);
        throw new Error(why);
      }
      return s;
    };
    const p = gl.createProgram()!;
    const vs = sh(gl.VERTEX_SHADER, VS);
    const fs = sh(gl.FRAGMENT_SHADER, FS);
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.bindAttribLocation(p, 0, "pos");
    gl.bindAttribLocation(p, 1, "col");
    gl.linkProgram(p);
    // the program keeps what it needs: the shaders go now (no leak when effects are switched again and again)
    gl.detachShader(p, vs);
    gl.detachShader(p, fs);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const why = gl.getProgramInfoLog(p) ?? "link";
      gl.deleteProgram(p);
      throw new Error(why);
    }
    this.prog = p;
    this.uView = gl.getUniformLocation(p, "view");
    this.buf = gl.createBuffer()!;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8);
    gl.bindVertexArray(null);
    this.canvas = canvas;
    canvas.addEventListener("webglcontextlost", this.onLost);
  }

  /** Draw `n` vertices of `mesh` into a view of `w` × `h` CSS px (the canvas's backing store is already sized). */
  draw(mesh: Float32Array, n: number, w: number, h: number): void {
    if (this.lost) return;
    const gl = this.gl;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (n === 0) return;
    gl.useProgram(this.prog);
    gl.uniform2f(this.uView, w, h);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const bytes = n * 24;
    if (bytes > this.cap) {
      this.cap = Math.max(bytes, this.cap * 2, 64 * 1024);
      gl.bufferData(gl.ARRAY_BUFFER, this.cap, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, mesh, 0, n * 6);
    gl.drawArrays(gl.TRIANGLES, 0, n);
    gl.bindVertexArray(null);
  }

  clear(): void {
    if (this.lost) return;
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Free what we made. The context itself stays: the canvas keeps it, and turning effects on again (a new
   *  AmbienceGl on the same canvas) gets it back — a lost context would leave them off until the chat remounted. */
  dispose(): void {
    const gl = this.gl;
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    try {
      gl.deleteBuffer(this.buf);
      gl.deleteVertexArray(this.vao);
      gl.deleteProgram(this.prog);
    } catch {
      /* gone already */
    }
  }
}
