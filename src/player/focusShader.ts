// WebGL2 renderer of the focus blur (focusBlur.ts): draws the current video
// frame into a canvas through a fragment shader that blurs each pixel by its
// distance past the target ellipse. The frame is uploaded as a mipmapped
// texture; a pixel's blur is 16 Gaussian-weighted taps on a golden-angle
// spiral, read from the mip level that matches their spacing, so wide blurs
// cost the same as narrow ones and don't alias.
//
// Outside the video's content rect (letterbox bars) the canvas stays
// transparent. A tainted (cross-origin) video or a lost context makes draw()
// return false; the caller then gives up.

import type { FocusEllipse } from "./focusBlur.ts";

const VERTEX = `#version 300 es
void main() {
  // one triangle covering the canvas, no buffers
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const TAPS = 16;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_res;      // canvas px
uniform vec4 u_content;  // video content rect: x, y, w, h (canvas px, top-left origin)
uniform vec4 u_ellipse;  // cx, cy, rx, ry (canvas px)
uniform float u_unit;    // ring unit (canvas px)
uniform float u_sigma;   // blur sigma at full reach (canvas px)
uniform float u_reach;   // ring units past the edge where the blur is full
uniform vec2 u_texSize;  // video px
out vec4 outColor;

const int TAPS = ${TAPS};
const float GOLDEN = 2.39996323;

void main() {
  vec2 p = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
  vec2 uv = (p - u_content.xy) / u_content.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) {
    outColor = vec4(0.0);
    return;
  }
  // distance past the ellipse's edge along the ray from its centre (blurAt in focusBlur.ts)
  vec2 d = p - u_ellipse.xy;
  float q = length(d / max(u_ellipse.zw, vec2(1.0)));
  float past = q > 1.0 ? length(d) * (1.0 - 1.0 / q) : 0.0;
  float sigma = u_sigma * clamp(past / max(u_unit * u_reach, 1.0), 0.0, 1.0);
  if (sigma < 0.35) {
    outColor = vec4(textureLod(u_tex, uv, 0.0).rgb, 1.0);
    return;
  }
  vec2 texelsPerPx = u_texSize / u_content.zw;
  float radius = 2.5 * sigma;
  float spacing = radius / sqrt(float(TAPS));
  float lod = max(0.0, log2(spacing * max(texelsPerPx.x, texelsPerPx.y)));
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < TAPS; i++) {
    float fi = float(i) + 0.5;
    float r = radius * sqrt(fi / float(TAPS));
    float a = fi * GOLDEN;
    float w = exp(-(r * r) / (2.0 * sigma * sigma));
    acc += textureLod(u_tex, uv + vec2(cos(a), sin(a)) * r / u_content.zw, lod).rgb * w;
    wsum += w;
  }
  outColor = vec4(acc / wsum, 1.0);
}`;

export interface FocusFrame {
  /** canvas backing size, device px */
  width: number;
  height: number;
  /** where the video content is drawn, canvas px (top-left origin) */
  content: { x: number; y: number; w: number; h: number };
  ellipse: FocusEllipse;
  /** ring unit, canvas px */
  unit: number;
  /** blur sigma at full reach, canvas px */
  sigma: number;
  /** ring units past the edge where the blur is full (FOCUS_REACH, widened by the breath) */
  reach: number;
}

export interface FocusRenderer {
  /** draws the video's current frame; false when it can't (tainted video, lost context) */
  draw(video: HTMLVideoElement, frame: FocusFrame): boolean;
  dispose(): void;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("createShader failed");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader: ${log ?? "compile failed"}`);
  }
  return sh;
}

/** A renderer on the canvas, or undefined without WebGL2. Throws when the shaders don't build. */
export function createFocusRenderer(canvas: HTMLCanvasElement): FocusRenderer | undefined {
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
  if (!gl) return undefined;

  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  const prog = gl.createProgram();
  if (!prog) throw new Error("createProgram failed");
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(prog) ?? "link failed"}`);
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  const vao = gl.createVertexArray();
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const u = {
    tex: gl.getUniformLocation(prog, "u_tex"),
    res: gl.getUniformLocation(prog, "u_res"),
    content: gl.getUniformLocation(prog, "u_content"),
    ellipse: gl.getUniformLocation(prog, "u_ellipse"),
    unit: gl.getUniformLocation(prog, "u_unit"),
    sigma: gl.getUniformLocation(prog, "u_sigma"),
    reach: gl.getUniformLocation(prog, "u_reach"),
    texSize: gl.getUniformLocation(prog, "u_texSize"),
  };

  let disposed = false;
  return {
    draw(video, f) {
      if (disposed || gl.isContextLost()) return false;
      if (canvas.width !== f.width) canvas.width = f.width;
      if (canvas.height !== f.height) canvas.height = f.height;
      gl.viewport(0, 0, f.width, f.height);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      try {
        // top row first: uv (0,0) is the frame's top-left, as in the shader
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      } catch {
        return false; // a cross-origin video taints the canvas
      }
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.uniform1i(u.tex, 0);
      gl.uniform2f(u.res, f.width, f.height);
      gl.uniform4f(u.content, f.content.x, f.content.y, f.content.w, f.content.h);
      gl.uniform4f(u.ellipse, f.ellipse.cx, f.ellipse.cy, f.ellipse.rx, f.ellipse.ry);
      gl.uniform1f(u.unit, f.unit);
      gl.uniform1f(u.sigma, f.sigma);
      gl.uniform1f(u.reach, f.reach);
      gl.uniform2f(u.texSize, video.videoWidth, video.videoHeight);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      gl.deleteTexture(tex);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(prog);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
