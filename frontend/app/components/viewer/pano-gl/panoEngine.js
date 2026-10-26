/**
 * PanoEngine — the WebGL2 equirectangular renderer from pano-viewer.html,
 * ported as a headless class for React.
 *
 * Why this exists: stock pannellum has no setPanorama, so the old viewer had
 * to be destroyed and rebuilt on every navigation (the black flash). This
 * engine is double-buffered instead: the outgoing image's TEXTURE stays on
 * the GPU while the incoming image uploads into the free texture, and the
 * render loop draws outgoing opaque + incoming alpha-ramped for CROSSFADE_MS
 * — both images are rendered for the whole blend, so there is never a blank
 * frame. Moving along a track keeps the camera (yaw/pitch/fov continue).
 *
 * Only the panorama path of the reference file is ported: the "photo"
 * (flat 2D) mode, brightness/contrast/sharpness adjustments and the
 * roll/tilt/heading correction are left out.
 */

const CROSSFADE_MS = 350;
const MOVE_DOLLY_MS = 800; // Move-style step (same as finalized viewer)
const FOV_MIN = (30 * Math.PI) / 180;
const FOV_MAX = (100 * Math.PI) / 180;
const PITCH_LIMIT = (85 * Math.PI) / 180;
const CAM_HEIGHT = 2.4;
const ARROW_DIST = 9;  // fixed ground distance (Next.js / finalized viewer)
const ARROW_SIZE = 7.5; // disc half-width in degrees (finalized)
// The disc is re-anchored every frame so its centre rides this far below
// the centre of the view — it stays painted on the visible road near the
// camera even when the capture is tilted or the user pitches up.
const ARROW_DROP_DEG = 16;
const ARROW_DIST_MIN = 3;
const ARROW_DIST_MAX = 35;
// Textures decode at 4096×2048 (~33 MB) instead of the full 8192×4096
// (~134 MB): visually identical at viewer field-of-view, 4× less memory.
const DECODE_MAX_WIDTH = 4096;
const DECODE_MAX_HEIGHT = 2048;

const VERT = `#version 300 es
  in vec2 a_pos; out vec2 v_uv;
  void main(){ v_uv = a_pos; gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
  precision highp float;
  in vec2 v_uv; out vec4 o;
  uniform sampler2D u_tex;
  uniform float u_aspect, u_yaw, u_pitch, u_tanHalf;
  uniform float u_bright, u_contrast, u_sharp;
  uniform float u_flat, u_imgAspect;
  uniform mat3 u_rot;
  uniform vec3 u_spot[2];
  uniform float u_camH, u_spotDist, u_spotR;
  uniform float u_photo, u_zoom, u_pfit, u_pang;
  uniform vec2 u_pan;
  uniform float u_globalAlpha;
  // Move-style dolly (optical flow expansion from focus of expansion)
  uniform float u_moveAmt;
  uniform vec2 u_foe;
  const float PI = 3.14159265359;

  vec3 sampleAt(vec2 suv) {
    vec2 uv; vec2 gx; vec2 gy; bool inside = true; vec3 dw = vec3(0.0, 1.0, 0.0);
    if (u_photo > 0.5) {
      float fit = u_pfit > 0.5
        ? (u_imgAspect > u_aspect ? u_aspect / u_imgAspect : 1.0)
        : (u_imgAspect > u_aspect ? 1.0 : u_imgAspect / u_aspect);
      float sx = u_zoom * fit * (u_imgAspect > u_aspect ? u_imgAspect / u_aspect : 1.0);
      float sy = u_zoom * fit * (u_imgAspect > u_aspect ? 1.0 : u_aspect / u_imgAspect);
      float ang = u_pang; float ca = cos(ang), sa = sin(ang);
      vec2 p = suv - u_pan;
      vec2 q = vec2(p.x * ca - p.y * sa, p.x * sa + p.y * ca);
      uv = vec2(q.x / sx * 0.5 + 0.5, 0.5 - q.y / sy * 0.5);
      inside = uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
      gx = dFdx(uv); gy = dFdy(uv);
    } else if (u_flat > 0.5) {
      float sc = max(u_imgAspect / u_aspect, 1.0);
      uv = vec2(suv.x * sc * 0.5 / u_imgAspect + 0.5, 0.5 - suv.y * sc * 0.5);
      inside = uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
      gx = dFdx(uv); gy = dFdy(uv);
    } else {
      vec3 d = normalize(vec3(suv.x * u_aspect * u_tanHalf, suv.y * u_tanHalf, -1.0));
      float cp = cos(u_pitch), sp = sin(u_pitch);
      d = vec3(d.x, d.y * cp - d.z * sp, d.y * sp + d.z * cp);
      float cy = cos(u_yaw), sy = sin(u_yaw);
      d = vec3(d.x * cy - d.z * sy, d.y, d.x * sy + d.z * cy);
      dw = d;
      d = u_rot * d;
      uv = vec2(atan(d.x, -d.z) / (2.0 * PI) + 0.5, 0.5 - asin(clamp(d.y, -1.0, 1.0)) / PI);
      vec2 uv2 = vec2(fract(uv.x + 0.5), uv.y);
      vec2 dx1 = dFdx(uv), dx2 = dFdx(uv2), dy1 = dFdy(uv), dy2 = dFdy(uv2);
      gx = dot(dx1, dx1) < dot(dx2, dx2) ? dx1 : dx2;
      gy = dot(dy1, dy1) < dot(dy2, dy2) ? dy1 : dy2;
    }
    vec3 c = textureGrad(u_tex, uv, gx, gy).rgb;
    if (u_sharp > 0.001) {
      vec3 blur = 0.25 * (textureGrad(u_tex, uv + gx, gx, gy).rgb + textureGrad(u_tex, uv - gx, gx, gy).rgb
                        + textureGrad(u_tex, uv + gy, gx, gy).rgb + textureGrad(u_tex, uv - gy, gx, gy).rgb);
      c += u_sharp * (c - blur);
    }
    c = (c - 0.5) * u_contrast + 0.5;
    c *= u_bright;
    vec3 rgb = inside ? clamp(c, 0.0, 1.0) : vec3(0.0);

    if (u_flat < 0.5 && u_moveAmt < 0.001) {
      float valid = step(dw.y, -0.02);
      vec2 P = dw.xz * (-u_camH / min(dw.y, -0.02));
      for (int i = 0; i < 2; i++) {
        vec3 sp = u_spot[i];
        if (sp.x > 0.5) {
          vec2 fwd = vec2(sin(sp.y), -cos(sp.y));
          vec2 rgt = vec2(cos(sp.y), sin(sp.y));
          vec2 q = P - fwd * u_spotDist;
          float r = length(q);
          float aa = max(fwidth(r), 1e-4);
          float disc = (1.0 - smoothstep(u_spotR - aa, u_spotR, r)) * valid;
          float uu = dot(q, rgt) / u_spotR, vv = dot(q, fwd) / u_spotR, an = aa / u_spotR;
          float g = vv + 0.85 * abs(uu);
          float band = smoothstep(0.08 - an, 0.08 + an, g) * (1.0 - smoothstep(0.42 - an, 0.42 + an, g));
          float side = 1.0 - smoothstep(0.62 - an, 0.62 + an, abs(uu));
          rgb = mix(rgb, vec3(1.0), disc * mix(0.5, 0.85, sp.z));
          rgb = mix(rgb, vec3(0.13), disc * band * side * 0.6);
        }
      }
    }
    return rgb;
  }

  void main(){
    vec2 suv = v_uv;
    if (u_moveAmt > 0.001) {
      // Optical flow of walking toward the arrow (focus of expansion)
      vec2 d = v_uv - u_foe;
      suv = u_foe + d * (1.0 + u_moveAmt * 0.18);
    }
    vec3 rgb = sampleAt(suv);
    o = vec4(rgb, u_globalAlpha);
  }`;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const easeOutQuad = (t) => 1 - (1 - t) * (1 - t);
// Identity image-correction matrix (u_rot uniform)
const IDENTITY_ROT = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

export class PanoEngine {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts { onSpot(dir), onLoaded(), onError(err), onViewChange({yaw,pitch,hfov}) }
   *                    angles in degrees. All callbacks optional.
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    canvas.classList.add('pano-gl-canvas');

    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
    if (!gl) {
      opts.onError?.(new Error('WebGL2 is not supported by this browser'));
      throw new Error('WebGL2 unavailable');
    }
    // React StrictMode mounts → unmounts → remounts the same canvas in dev.
    // If a previous engine lost this context, restore it instead of failing.
    if (gl.isContextLost()) {
      gl.getExtension('WEBGL_lose_context')?.restoreContext();
    }
    this.gl = gl;

    // ---- program ----
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(s) || 'shader compile failed');
      }
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(prog));
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    this.U = {
      tex: gl.getUniformLocation(prog, 'u_tex'),
      aspect: gl.getUniformLocation(prog, 'u_aspect'),
      yaw: gl.getUniformLocation(prog, 'u_yaw'),
      pitch: gl.getUniformLocation(prog, 'u_pitch'),
      tanHalf: gl.getUniformLocation(prog, 'u_tanHalf'),
      imgAspect: gl.getUniformLocation(prog, 'u_imgAspect'),
      spot: gl.getUniformLocation(prog, 'u_spot'),
      globalAlpha: gl.getUniformLocation(prog, 'u_globalAlpha'),
      camH: gl.getUniformLocation(prog, 'u_camH'),
      spotDist: gl.getUniformLocation(prog, 'u_spotDist'),
      spotR: gl.getUniformLocation(prog, 'u_spotR'),
      bright: gl.getUniformLocation(prog, 'u_bright'),
      contrast: gl.getUniformLocation(prog, 'u_contrast'),
      sharp: gl.getUniformLocation(prog, 'u_sharp'),
      flat: gl.getUniformLocation(prog, 'u_flat'),
      rot: gl.getUniformLocation(prog, 'u_rot'),
      photo: gl.getUniformLocation(prog, 'u_photo'),
      zoom: gl.getUniformLocation(prog, 'u_zoom'),
      pan: gl.getUniformLocation(prog, 'u_pan'),
      pfit: gl.getUniformLocation(prog, 'u_pfit'),
      pang: gl.getUniformLocation(prog, 'u_pang'),
      moveAmt: gl.getUniformLocation(prog, 'u_moveAmt'),
      foe: gl.getUniformLocation(prog, 'u_foe'),
    };
    gl.uniform1i(this.U.tex, 0);

    // ---- double-buffered textures ----
    this.texA = gl.createTexture();
    this.texB = gl.createTexture();
    this.curTex = this.texA;
    this.otherTex = this.texB; // free to load the next image into
    this.imgAspectCur = 2;
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    this.aniso = aniso;

    // ---- view state (radians; yaw wrapped to (-PI, PI]) ----
    this.yaw = 0;
    this.pitch = 0;
    this.fov = (75 * Math.PI) / 180;

    // ---- ground arrows: [0] forward = next, [1] back = previous ----
    this.spots = [
      { yaw: 0, dir: 1, on: false, hover: false },
      { yaw: Math.PI, dir: -1, on: false, hover: false },
    ];

    this.hasImage = false;
    this.transition = null; // { from: {tex, imgAspect}, t0 } while crossfading
    this.dirty = true;
    this.raf = 0;
    this.destroyed = false;
    this.active = true; // false while the viewer is hidden (kept mounted)
    this.currentUrl = null; // decoded image on screen — never evicted
    this.tierToken = null; // guards the background HD upgrade
    this._loadCtl = null; // AbortController for the in-flight image fetch
    this._markerOverlayFn = null; // per-frame DOM marker updater (viewer sets it)
    this._dolly = null; // active step-dolly state { id, baseFov }
    this._dollyId = 0;
    this._fovAnimId = 0;
    this._pendingStepDir = null; // +1 / -1 while a neighbour step is in flight
    this._stepReveal = null; // resolves when the next frame reveals
    this.pinned = new Set(); // decoded neighbours immune to eviction
    this.cache = new Map(); // url -> Promise<ImageBitmap|HTMLImageElement>
    this.cacheBytes = new Map(); // url -> decoded size estimate
    // Low-memory devices get a smaller budget and a serial background lane.
    const lowMemory =
      typeof navigator !== 'undefined' &&
      navigator.deviceMemory &&
      navigator.deviceMemory <= 4;
    // Two parallel tracks (dolly stays smooth):
    //  • Primary / step: high-priority load + GPU dolly on already-ready textures
    //  • Background: the ±4 window prefetch runs up to _maxBgDecode jobs IN
    //    PARALLEL (thirdeye360-next model) so walking never outruns the
    //    pipeline. A clicked frame still jumps the queue and starts at once;
    //    the browser's per-host connection pool (~6) self-throttles the rest.
    this._bgPaused = false;
    this._decodeActive = 0;
    this._decodeQueue = []; // { url, signal, decodeOpts, resolve, reject, primary }
    this._maxBgDecode = lowMemory ? 1 : 4;
    this._primaryWaiting = 0; // >0 while a visible-frame decode is queued/running

    // Decoded frames are ~33 MB each (4096×2048) — cap the cache by bytes.
    this.cacheBudget = lowMemory ? 192 * 1024 * 1024 : 384 * 1024 * 1024;
    this.cacheMaxEntries = lowMemory ? 8 : 12;
    // Keep a Mapillary-sized window hot (±4 ≈ 9 frames). Byte estimate is
    // conservative; eviction was the cause of the hitch every ~4 steps.
    this.cacheBudget = lowMemory ? 192 * 1024 * 1024 : 384 * 1024 * 1024;
    this.cacheMaxEntries = lowMemory ? 8 : 12;
    this._prewarmedUrl = null; // URL already uploaded into otherTex

    // ---- input ----
    this.ptrs = new Map();
    this.press = null;
    this.pinch0 = 0;
    this.fov0 = this.fov;
    this._bindInput();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
    this.startLoop();
  }

  /* ---------- textures ---------- */

  uploadTexture(img, targetTex) {
    const gl = this.gl;
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    // ImageBitmap (preferred decode path) has width/height; <img> has natural*
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    let source = img;
    if (w > max || h > max) {
      const s = Math.min(1, max / w, max / h);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.floor(w * s));
      c.height = Math.max(1, Math.floor(h * s));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      source = c;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, targetTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); // 360 wraps around
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (this.aniso) {
      const maxA = gl.getParameter(this.aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
      gl.texParameterf(gl.TEXTURE_2D, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, maxA));
    }
  }

  /* ---------- sizing + render loop ---------- */

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.dirty = true;
  }

  rotate(dyaw, dpitch) {
    this.yaw = (((this.yaw + dyaw + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    this.pitch = clamp(this.pitch + dpitch, -PITCH_LIMIT, PITCH_LIMIT);
    this.dirty = true;
  }

  /**
   * Ground distance for the arrows, re-anchored per frame so the disc paints
   * ARROW_DROP_DEG below the centre of the view. A fixed world anchor floats
   * above the road when the capture is tilted/rolled or the view is pitched
   * up; this keeps the arrow seated on the visible road at all times.
   * Returns null when the view points too far up for road to be under the
   * disc (callers hide the arrows).
   */
  arrowDist() {
    // Fixed distance matches finalized viewer (ARROW_DIST = 9).
    const tanHalfV =
      Math.tan(this.fov / 2) /
      (this.canvas.width / Math.max(1, this.canvas.height));
    const bottomDep =
      (Math.atan(tanHalfV) * 180) / Math.PI - (this.pitch * 180) / Math.PI;
    if (bottomDep <= 1) return null;
    return ARROW_DIST;
  }

  currentSpots() {
    const buf = new Float32Array(6);
    const dist = this.arrowDist();
    for (let i = 0; i < 2; i++) {
      buf[i * 3] = this.spots[i].on && dist !== null ? 1 : 0;
      buf[i * 3 + 1] = this.spots[i].yaw;
      buf[i * 3 + 2] = this.spots[i].hover ? 1 : 0;
    }
    return buf;
  }

  // One full-screen pass; alpha < 1 blends over whatever was drawn before.
  drawPass(tex, imgAspect, alpha, blend, spots, opts = {}) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1f(this.U.aspect, this.canvas.width / this.canvas.height);
    gl.uniform1f(this.U.yaw, this.yaw);
    gl.uniform1f(this.U.pitch, this.pitch);
    gl.uniform1f(this.U.tanHalf, Math.tan(this.fov / 2));
    gl.uniform1f(this.U.bright, 1.0);
    gl.uniform1f(this.U.contrast, 1.0);
    gl.uniform1f(this.U.sharp, 0.0);
    gl.uniform1f(this.U.flat, 0.0);
    gl.uniform1f(this.U.imgAspect, imgAspect);
    gl.uniformMatrix3fv(this.U.rot, false, IDENTITY_ROT);
    gl.uniform1f(this.U.photo, 0.0);
    gl.uniform1f(this.U.zoom, 1.0);
    gl.uniform2f(this.U.pan, 0.0, 0.0);
    gl.uniform1f(this.U.pfit, 1.0);
    gl.uniform1f(this.U.pang, 0.0);
    gl.uniform3fv(this.U.spot, spots);
    gl.uniform1f(this.U.camH, CAM_HEIGHT);
    const spotDist = this.arrowDist() ?? ARROW_DIST;
    gl.uniform1f(this.U.spotDist, spotDist);
    gl.uniform1f(this.U.spotR, spotDist * Math.tan(ARROW_SIZE * (Math.PI / 180)));
    gl.uniform1f(this.U.globalAlpha, alpha);
    gl.uniform1f(this.U.moveAmt, opts.moveAmt || 0);
    const foe = opts.foe || [0, 0];
    gl.uniform2f(this.U.foe, foe[0], foe[1]);
    if (blend) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    } else {
      gl.disable(gl.BLEND);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }


  _smoother(t) {
    t = clamp(t, 0, 1);
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  /**
   * One render pass: draw the scene, then update the DOM marker overlay in
   * the SAME frame — overlays positioned from a separate loop swim behind
   * the canvas while the view rotates.
   */
  draw() {
    this.drawScene();
    if (this._markerOverlayFn) this._markerOverlayFn(this.hasImage);
  }

  drawScene() {
    if (this.canvas.width < 2 || this.canvas.height < 2) return;
    if (!this.hasImage) {
      this.gl.clearColor(0.0, 0.0, 0.0, 0.0);
      this.gl.clear(this.gl.COLOR_BUFFER_BIT);
      return;
    }
    const now = performance.now();
    if (this.transition) {
      const tr = this.transition;
      const t = clamp((now - tr.t0) / tr.dur, 0, 1);
      if (t >= 1) {
        this.transition = null;
        if (this._dolly) this._dolly = null;
        this._pumpDecodeQueue(); // continue bg after dolly frame settles
      } else if (tr.style === 'move') {
        // Move-style: expand from FOE (arrow direction), crossfade mid-path
        const fwd = (tr.dir == null ? 1 : tr.dir) >= 0;
        const tA = this._smoother(clamp(t / 0.48, 0, 1));
        const tC = this._smoother(clamp((t - 0.55) / 0.45, 0, 1));
        const alphaTo = this._smoother(clamp((t - 0.25) / 0.5, 0, 1));
        const showFrom = alphaTo < 0.999;
        const foe = fwd ? [0, -0.15] : [0, 0.15];
        const moveFrom = (fwd ? 1 : 0.55) * tA;
        const moveTo = (fwd ? 1 : 0.55) * (1 - tC);
        const zero = new Float32Array(6);
        if (showFrom) {
          this.drawPass(tr.from.tex, tr.from.imgAspect, 1, false, zero, {
            moveAmt: moveFrom,
            foe,
          });
        } else {
          this.drawPass(this.curTex, this.imgAspectCur, 1, false, zero, {
            moveAmt: moveTo,
            foe,
          });
        }
        if (showFrom && alphaTo > 0.01) {
          this.drawPass(this.curTex, this.imgAspectCur, alphaTo, true, zero, {
            moveAmt: moveTo,
            foe,
          });
        }
        this.gl.disable(this.gl.BLEND);
        return;
      } else {
        // Simple crossfade (map jump / HD upgrade)
        this.drawPass(tr.from.tex, tr.from.imgAspect, 1, false, new Float32Array(6));
        this.drawPass(
          this.curTex,
          this.imgAspectCur,
          easeOutQuad(t),
          true,
          this.currentSpots()
        );
        this.gl.disable(this.gl.BLEND);
        return;
      }
    }
    this.drawPass(this.curTex, this.imgAspectCur, 1, false, this.currentSpots());
  }

  startLoop() {
    if (this.raf) return;
    const frame = () => {
      this.raf = requestAnimationFrame(frame);
      if (this.destroyed) return;
      if (this.transition) this.dirty = true;
      if (this.dirty) {
        this.dirty = false;
        this.draw();
        this.opts.onViewChange?.(this.getView());
      }
    };
    this.raf = requestAnimationFrame(frame);
  }

  /* ---------- public API ---------- */

  /** Degrees. */
  getView() {
    return {
      yaw: (this.yaw * 180) / Math.PI,
      pitch: (this.pitch * 180) / Math.PI,
      hfov: (this.fov * 180) / Math.PI,
    };
  }

  /** Degrees. */
  setView({ yaw, pitch, hfov } = {}) {
    if (yaw != null) this.yaw = (((yaw * Math.PI) / 180 + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    if (pitch != null) this.pitch = clamp((pitch * Math.PI) / 180, -PITCH_LIMIT, PITCH_LIMIT);
    if (hfov != null) this.fov = clamp((hfov * Math.PI) / 180, FOV_MIN, FOV_MAX);
    this.dirty = true;
  }

  getYaw() {
    return (this.yaw * 180) / Math.PI;
  }

  getPitch() {
    return (this.pitch * 180) / Math.PI;
  }

  getHfov() {
    return (this.fov * 180) / Math.PI;
  }

  setHfov(deg) {
    this.fov = clamp((deg * Math.PI) / 180, FOV_MIN, FOV_MAX);
    this.dirty = true;
  }

  /** Arrow availability (drives the in-shader ground arrows). */
  /**
   * Register a per-frame marker updater. It runs at the end of every draw
   * with `hasImage`, so DOM overlays stay pixel-locked to the exact frame
   * the GPU just drew.
   */
  setMarkerOverlay(fn) {
    this._markerOverlayFn = typeof fn === 'function' ? fn : null;
    this.dirty = true;
    this.startLoop();
  }

  setSpotAvailability(canNext, canPrev) {
    if (this.spots[0].on !== !!canNext || this.spots[1].on !== !!canPrev) {
      this.spots[0].on = !!canNext;
      this.spots[1].on = !!canPrev;
      this.dirty = true;
    }
  }

  /** Preload + decode an image into the cache (neighbour prefetch). */
  preload(url) {
    if (!url) return;
    // Background track — runs in parallel with dolly (low concurrency)
    this.fetchImage(url, null, { background: true });
  }

  /** True when url is fully decoded in the engine cache (Next.js isReady). */
  isReady(url) {
    if (!url || !this.cache.has(url)) return false;
    const p = this.cache.get(url);
    return !!(p && p.__ready && p.__img);
  }

  /** Soft yield — primary always wins; bg keeps running in parallel. */
  pauseBackground() {
    // Intentionally does NOT stop bg network/decode. Dolly uses GPU textures
    // already on-screen; bg preload continues at low concurrency.
    this._bgPaused = false;
    this._pumpDecodeQueue();
  }

  resumeBackground() {
    this._bgPaused = false;
    this._pumpDecodeQueue();
  }

  /** Decoded image (ImageBitmap or <img>) for a url, cached. */
  fetchImage(url, signal, decodeOpts) {
    if (!this.cache.has(url)) {
      const primary = !decodeOpts?.background;
      const p = this._enqueueDecode(url, signal, decodeOpts, primary).then((img) => {
        p.__ready = true;
        p.__img = img;
        return img;
      });
      p.__ready = false;
      p.__img = null;
      p.catch(() => {
        if (this.cache.get(url) === p) {
          this.cache.delete(url);
          this.cacheBytes.delete(url);
        }
      });
      this.cache.set(url, p);
    }
    return this.cache.get(url);
  }

  /**
   * Primary (visible) frames jump the queue and always start immediately.
   * Background (window prefetch) frames run up to _maxBgDecode at once, and
   * keep filling their lane even while a primary decode is in flight.
   */
  _enqueueDecode(url, signal, decodeOpts, primary) {
    return new Promise((resolve, reject) => {
      const job = { url, signal, decodeOpts, resolve, reject, primary: !!primary };
      if (primary) this._decodeQueue.unshift(job);
      else this._decodeQueue.push(job);
      this._pumpDecodeQueue();
    });
  }

  _pumpDecodeQueue() {
    // Parallel model:
    //  - Always start a waiting primary job immediately (dolly / visible frame)
    //  - Also run up to _maxBgDecode background jobs at the same time
    //  - Primary never waits behind background
    while (this._decodeQueue.length) {
      const primaryIdx = this._decodeQueue.findIndex((j) => j.primary);
      const wantPrimary = primaryIdx >= 0;
      const activePrimary = this._primaryWaiting > 0 && this._decodeActive > 0;
      // Count how many non-primary are running via slots
      const canStartPrimary = wantPrimary;
      const bgRunning = this._decodeActive - (this._primaryWaiting > 0 ? 1 : 0);
      const canStartBg =
        !wantPrimary && this._decodeActive < this._maxBgDecode + (wantPrimary ? 1 : 0);

      let idx = -1;
      if (wantPrimary) {
        idx = primaryIdx;
      } else if (this._decodeActive < this._maxBgDecode) {
        idx = 0;
      } else {
        break;
      }

      // While a primary decode runs, bg may fill the REST of its lane — but
      // never take a slot beyond _maxBgDecode (primary adds its own).
      if (
        !wantPrimary &&
        this._primaryWaiting > 0 &&
        this._decodeActive >= this._maxBgDecode
      ) {
        break;
      }

      const job = this._decodeQueue.splice(idx, 1)[0];
      this._decodeActive++;
      if (job.primary) this._primaryWaiting++;
      this.decodeUrl(job.url, job.signal, { ...(job.decodeOpts || {}), background: !job.primary })
        .then(job.resolve, job.reject)
        .finally(() => {
          this._decodeActive--;
          if (job.primary) this._primaryWaiting = Math.max(0, this._primaryWaiting - 1);
          this._pumpDecodeQueue();
        });
    }
  }

  /**
   * Decode exactly like the Next.js app ImageCache:
   * HTMLImageElement + img.decode() — no createImageBitmap resize storms.
   * Background jobs run through the bounded-parallel decode queue.
   */
  async decodeUrl(url, signal, decodeOpts) {
    if (signal?.aborted) {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.decoding = 'async';
      el.crossOrigin = 'anonymous';
      const onAbort = () => {
        el.onload = null;
        el.onerror = null;
        el.src = '';
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
      // Soft timeout (12s) matching Next.js UX — never hang a minute
      const t = setTimeout(() => onAbort(), 12000);
      el.onload = () => {
        clearTimeout(t);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(el);
      };
      el.onerror = () => {
        clearTimeout(t);
        if (signal) signal.removeEventListener('abort', onAbort);
        reject(new Error('unreadable'));
      };
      el.src = url;
    });
    try {
      if (img.decode) await img.decode();
    } catch (_) { /* decode() failure is non-fatal; drawImage still works */ }
    this.cacheBytes.set(
      url,
      (img.naturalWidth || img.width || 0) * (img.naturalHeight || img.height || 0) * 4
    );
    return img;
  }

  async loadImage(url, { view, fade = true } = {}) {
    if (!url) return;
    // Already on screen (e.g. stepFromCache just applied) — no double work
    if (url === this.currentUrl && this.hasImage && this._pendingStepDir == null) {
      this.opts.onLoaded?.();
      return;
    }
    // Preserve step direction across in-flight abort so the Move dolly still
    // runs when the newer load finishes (rapid arrow clicks).
    const savedStepDir = this._pendingStepDir;
    this.transition = null;
    if (this._loadCtl) this._loadCtl.abort();
    const ctl = new AbortController();
    this._loadCtl = ctl;
    this.tierToken = url;
    if (savedStepDir != null) this._pendingStepDir = savedStepDir;
    let img;
    try {
      img = await this.fetchImage(url, ctl.signal);
    } catch (e) {
      if (e && e.name === 'AbortError') return; // superseded by a newer load
      this.opts.onError?.(e);
      return;
    }
    if (this.destroyed) return;
    if (view) this.setView(view);

    this._revealImage(img, url, { fade, stepDir: this._pendingStepDir });
  }

  /**
   * Show a panorama that has an instant tier (comp) and a quality tier (HD):
   * straight to HD when it is already decoded; otherwise reveal the comp
   * fast and crossfade to HD once it decodes in the background. The camera
   * view rides only on the first reveal; the HD upgrade never moves it.
   * HD failures are silent — comp stays on screen.
   * @returns {Promise<void>} resolves once the first tier is on screen
   */
  async loadPanoTiered({ compUrl, hdUrl, view, fade = true } = {}) {
    // Navigation UX: never pull HD for the reveal path. Comp only.
    if (!compUrl && !hdUrl) return;
    if (compUrl && !hdUrl) {
      await this.loadImage(compUrl, { view, fade });
      return;
    }

    // Single-tier cases: no HD (or identical) → plain load of what we have
    if (!hdUrl || hdUrl === compUrl) {
      await this.loadImage(hdUrl || compUrl, { view, fade });
      return;
    }
    if (!compUrl) {
      await this.loadImage(hdUrl, { view, fade });
      return;
    }

    // HD already decoded (warmed track / revisited frame): single sharp load
    if (this.cache.has(hdUrl)) {
      await this.loadImage(hdUrl, { view, fade });
      return;
    }

    // First reveal from the instant tier
    const token = hdUrl;
    this.tierToken = token;
    await this.loadImage(compUrl, { view, fade });
    // loadImage re-arms the token per URL — restore ours so the pending
    // HD upgrade is not treated as stale
    this.tierToken = token;
    if (this.destroyed || this.tierToken !== token) return;

    // Give the comp reveal (and an immediate next step) first claim on
    // bandwidth before starting the multi-MB HD fetch.
    await new Promise((r) => setTimeout(r, 1200));
    if (this.destroyed || this.tierToken !== token) return;

    // Full-resolution HD only makes sense where the GPU can display it.
    // On 4096-max devices (most mobile) the comp frame is already final.
    try {
      if (this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) < 8192) return;
    } catch {
      return;
    }

    // Background HD upgrade, best-effort; aborted automatically when the
    // next image load starts (shared AbortController). Decoded at native
    // resolution, and the bitmap is closed + dropped from the cache right
    // after upload — the GPU texture owns the pixels from then on, so the
    // big frame never sits in the decoded cache.
    try {
      const hd = await this.fetchImage(
        hdUrl,
        this._loadCtl && this._loadCtl.signal,
        { fullSize: true }
      );
      if (this.destroyed || this.tierToken !== token || !this.hasImage) return;
      // Reuse the crossfade machinery for the sharpness upgrade — no view
      // change, no onLoaded (the pano is already on screen)
      this.uploadTexture(hd, this.otherTex);
      // Read dimensions BEFORE closing — a closed bitmap reports 0s
      const hdW = hd.naturalWidth || hd.width;
      const hdH = hd.naturalHeight || hd.height;
      const from = { tex: this.curTex, imgAspect: this.imgAspectCur };
      this.imgAspectCur = hdW / Math.max(1, hdH);
      // The GPU texture owns the pixels now — release the big bitmap and
      // drop it from the cache so a closed bitmap is never reused
      if (hd.close) {
        hd.close();
        if (this.cache.get(hdUrl)) {
          this.cache.delete(hdUrl);
          this.cacheBytes.delete(hdUrl);
        }
      }
      [this.curTex, this.otherTex] = [this.otherTex, this.curTex];
      this.currentUrl = hdUrl;
      this.transition = this.hasImage
        ? { from, t0: performance.now(), dur: CROSSFADE_MS }
        : null;
      this.dirty = true;
      this.startLoop();
      this.trimCache(hdUrl);
      this.opts.onUpgraded?.();
    } catch {
      // HD unavailable — the comp frame remains, silently
    }
  }

  /**
   * Pin the decoded neighbour frames: pinned URLs are decoded immediately
   * and are immune to cache eviction, so an arrow step always finds its
   * frame ready and the dolly never holds at peak waiting for a decode.
   * Unpinned URLs (previously pinned, now out of range) stay cached until
   * the budget forces them out.
   */
  setPinnedNeighbors(urls = []) {
    this.pinned = new Set(urls.filter(Boolean));
    const list = [...this.pinned].filter((u) => u && u !== this.currentUrl);
    // Decode all pinned (± window), then GPU-prewarm the first (usually next)
    list.forEach((u, i) => {
      if (i === 0) {
        // Background best-effort — a missing/blocked neighbour must not leak
        // an unhandled 'unreadable' rejection; a real step retries as primary
        this.fetchImage(u, null, { background: true })
          .then(() => this.prewarmUrl(u))
          .catch(() => {});
      } else {
        this.preload(u);
      }
    });
    this.trimCache(this.currentUrl);
  }

  /** Decoded neighbours that must never be evicted. */
  get pinnedNeighbors() {
    return this.pinned;
  }

  /**
   * Byte-budget LRU over decoded frames. Evicted ImageBitmaps are closed
   * explicitly — Chrome collects them lazily otherwise, so tab memory can
   * grow for hundreds of MB while waiting for GC. Pinned neighbours and the
   * frame on screen are never evicted.
   */
  trimCache(keepUrl) {
    const isProtected = (k) =>
      k === keepUrl || k === this.currentUrl || this.pinned.has(k) || k === this._prewarmedUrl;

    const evictOne = (k) => {
      this.cacheBytes.delete(k);
      const p = this.cache.get(k);
      this.cache.delete(k);
      if (p) {
        Promise.resolve(p)
          .then((img) => img.close && img.close())
          .catch(() => {});
      }
    };

    // Prefer entry-count limit (stable Mapillary-like window)
    while (this.cache.size > this.cacheMaxEntries) {
      let victim = null;
      for (const k of this.cache.keys()) {
        if (!isProtected(k)) {
          victim = k;
          break;
        }
      }
      if (!victim) break;
      evictOne(victim);
    }

    let total = 0;
    for (const b of this.cacheBytes.values()) total += b;
    for (const k of [...this.cache.keys()]) {
      if (total <= this.cacheBudget) break;
      if (isProtected(k)) continue;
      total -= this.cacheBytes.get(k) || 0;
      evictOne(k);
    }
  }

  /**
   * Clear the stage for a navigation jump (map click to a non-adjacent
   * frame): the previous location's image is wiped so nothing bleeds
   * through, and the next loadImage cuts in instantly (no crossfade, since
   * hasImage is false). Pending HD upgrades bail via their token check.
   */

  /**
   * Mapillary-style: when the next frame is already decoded, upload it into
   * otherTex so the next arrow click only swaps + dollies (zero decode hitch).
   */
  prewarmUrl(url) {
    if (!url || url === this.currentUrl) return;
    this.fetchImage(url, null, { background: true }).then((img) => {
      if (this.destroyed || !img) return;
      // Only prewarm when idle (no active transition / step load)
      if (this.transition || this._pendingStepDir != null) return;
      if (this.currentUrl === url) return;
      try {
        this.uploadTexture(img, this.otherTex);
        this._prewarmedUrl = url;
        this._prewarmedAspect =
          (img.naturalWidth || img.width) / Math.max(1, img.naturalHeight || img.height);
      } catch (_) { /* ignore */ }
    }).catch(() => {});
  }

  clearStage() {
    this.hasImage = false;
    this.transition = null;
    this.dirty = true;
    this.startLoop();
    // A pending step dolly has nothing to wait for anymore
    if (this._stepReveal) {
      const waiter = this._stepReveal;
      this._stepReveal = null;
      waiter.resolve();
    }
  }

  /* ---------- step dolly (Street View-style forward motion) ---------- */

  /**
   * Begin the dolly phase of an intentional step (ground arrow / keyboard —
   * never jumps): FOV eases toward the heading (zoom in moving forward, out
   * moving backward) and holds at the peak until the next frame reveals,
   * then eases back while the crossfade finishes. Falls back gracefully:
   * if the next frame takes longer than ~900 ms the FOV returns to normal
   * and the frame's own crossfade plays whenever it is ready.
   */
  beginStepDolly(dir) {
    // Move-style dolly. Background prefetch keeps running in parallel at low
    // priority — only primary (this step's image) jumps the queue.
    if (!this.hasImage) return;
    this._fovAnimId = (this._fovAnimId || 0) + 1;
    this._pendingStepDir = dir > 0 ? 1 : -1;
    const id = (this._dollyId = (this._dollyId || 0) + 1);
    this._dolly = { id, baseFov: this.fov, dir: this._pendingStepDir };
    setTimeout(() => {
      if (this._dolly && this._dolly.id === id && !this.transition) {
        this._dolly = null;
      }
    }, 8000);
  }

  /** True while a step dolly is animating (mid-dolly FOV is transient). */
  isStepping() {
    return !!(this._dolly || (this.transition && this.transition.style === 'move'));
  }

  /**
   * Next.js showById warm path: image already in cache → GPU swap + Move
   * dolly in the same turn. No network, no React-effect wait.
   * @returns {boolean} true if the step was applied from cache
   */
  stepFromCache(url, dir) {
    if (!url || !this.hasImage) return false;
    const p = this.cache.get(url);
    if (!p || !p.__ready || !p.__img) return false;
    const img = p.__img;
    this._pendingStepDir = dir > 0 ? 1 : -1;
    this._dollyId = (this._dollyId || 0) + 1;
    this._dolly = { id: this._dollyId, baseFov: this.fov, dir: this._pendingStepDir };
    this._revealImage(img, url, { fade: true, stepDir: this._pendingStepDir });
    this._pendingStepDir = null;
    return true;
  }

  /**
   * Shared reveal used by loadImage and stepFromCache (Next.js upload +
   * commitTransition equivalent).
   */
  _revealImage(img, url, { fade = true, stepDir = null } = {}) {
    const alreadyOnGpu = this._prewarmedUrl === url;
    if (!alreadyOnGpu) {
      this.uploadTexture(img, this.otherTex);
    }
    const from = { tex: this.curTex, imgAspect: this.imgAspectCur };
    this.imgAspectCur =
      alreadyOnGpu && this._prewarmedAspect
        ? this._prewarmedAspect
        : (img.naturalWidth || img.width) /
          Math.max(1, img.naturalHeight || img.height);
    [this.curTex, this.otherTex] = [this.otherTex, this.curTex];
    this._prewarmedUrl = null;
    this._prewarmedAspect = 0;

    const doFade = fade && this.hasImage;
    this.hasImage = true;
    this.currentUrl = url;

    const dir = stepDir != null ? stepDir : this._pendingStepDir;
    this._pendingStepDir = null;

    if (doFade && dir != null) {
      this.transition = {
        from,
        t0: performance.now(),
        dur: MOVE_DOLLY_MS,
        dir,
        style: 'move',
      };
    } else if (doFade) {
      this.transition = {
        from,
        t0: performance.now(),
        dur: CROSSFADE_MS,
        style: 'fade',
      };
    } else {
      this.transition = null;
    }
    this.dirty = true;
    this.startLoop();
    if (this._stepReveal) {
      const waiter = this._stepReveal;
      this._stepReveal = null;
      waiter.resolve();
    }
    this.opts.onLoaded?.();
    this.trimCache(url);
    this._pumpDecodeQueue();
  }

  /**
   * Ease FOV to `targetRad` over `duration` ms. A newer animation
   * supersedes an older one automatically.
   */
  animateFov(targetRad, duration) {
    const myId = (this._fovAnimId = (this._fovAnimId || 0) + 1);
    const from = this.fov;
    const t0 = performance.now();
    return new Promise((resolve) => {
      const step = () => {
        if (this.destroyed || this._fovAnimId !== myId) return resolve();
        const t = Math.min(1, (performance.now() - t0) / duration);
        this.fov = from + (targetRad - from) * easeOutQuad(t);
        this.dirty = true;
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  /**
   * While the viewer is hidden (kept mounted) it must not eat keyboard input
   * or burn frames; on reactivation it resizes and repaints.
   */
  setActive(active) {
    const next = !!active;
    if (this.active === next) return;
    this.active = next;
    if (next && !this.destroyed) {
      this.resize();
      this.startLoop();
    } else if (!next) {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  /* ---------- projection + picking ---------- */

  /** World-space ray through a client point (same maths as the shader). */
  viewRay(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const t = Math.tan(this.fov / 2);
    let x = ((clientX - r.left) / r.width * 2 - 1) * (r.width / r.height) * t;
    let y = (1 - (clientY - r.top) / r.height * 2) * t;
    let z = -1;
    const n = Math.hypot(x, y, z);
    x /= n; y /= n; z /= n;
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    [y, z] = [y * cp - z * sp, y * sp + z * cp];
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    [x, z] = [x * cy - z * sy, x * sy + z * cy];
    return [x, y, z];
  }

  /** Screen yaw/pitch (degrees) under a client point, or null above horizon. */
  screenToYawPitch(clientX, clientY) {
    const [x, y, z] = this.viewRay(clientX, clientY);
    if (y > -0.02) return null; // above the ground
    const yaw = ((Math.atan2(x, -z) * 180) / Math.PI + 360) % 360;
    return { yaw, pitch: null };
  }

  /**
   * Ground intersection of the ray through a client point:
   * { yaw (radians), dist (meters) } — or null when the ray misses the ground
   * (points at the sky).
   */
  groundPoint(clientX, clientY) {
    const [x, y, z] = this.viewRay(clientX, clientY);
    if (y > -0.02) return null;
    const t = -CAM_HEIGHT / y;
    const px = x * t;
    const pz = z * t;
    return {
      yaw: Math.atan2(px, -pz),
      dist: Math.hypot(px, pz),
    };
  }

  /** Project a world direction (yaw/pitch degrees) to screen pixels. */
  project(yawDeg, pitchDeg) {
    const lon = (yawDeg * Math.PI) / 180;
    const lat = (pitchDeg * Math.PI) / 180;
    // world dir for this longitude/latitude (same convention as the shader)
    const w = [Math.cos(lat) * Math.sin(lon), Math.sin(lat), -Math.cos(lat) * Math.cos(lon)];
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    let [x, y, z] = [w[0], w[1], w[2]];
    [y, z] = [y * cp + z * sp, -y * sp + z * cp]; // inverse pitch
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    [x, z] = [x * cy + z * sy, -x * sy + z * cy]; // inverse yaw
    if (z >= -0.02) return { visible: false };
    const t = Math.tan(this.fov / 2);
    const A = this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight);
    const sxPx = (x / -z / t / A + 1) * 0.5 * this.canvas.clientWidth;
    const syPx = (1 - y / -z / t) * 0.5 * this.canvas.clientHeight;
    return { x: sxPx, y: syPx, visible: true };
  }

  /* ---------- input ---------- */

  _bindInput() {
    const canvas = this.canvas;
    const dist = () => {
      const [a, b] = [...this.ptrs.values()];
      return Math.hypot(a.x - b.x, a.y - b.y) || 1;
    };

    // Which arrow (0 = forward, 1 = back) is under the pointer? -1 if none.
    const spotAt = (clientX, clientY) => {
      const dist = this.arrowDist();
      if (dist === null) return -1; // arrows hidden — nothing to pick
      const [x, y, z] = this.viewRay(clientX, clientY);
      if (y > -0.02) return -1;
      const t = -CAM_HEIGHT / y;
      const px = x * t;
      const pz = z * t;
      const spotR = dist * Math.tan(ARROW_SIZE * (Math.PI / 180));
      for (let i = 0; i < 2; i++) {
        if (!this.spots[i].on) continue;
        const cx = dist * Math.sin(this.spots[i].yaw);
        const cz = -dist * Math.cos(this.spots[i].yaw);
        if (Math.hypot(px - cx, pz - cz) <= spotR * 1.08) return i;
      }
      return -1;
    };

    const setHover = (i) => {
      let changed = false;
      this.spots.forEach((sp, k) => {
        const h = k === i;
        if (sp.hover !== h) {
          sp.hover = h;
          changed = true;
        }
      });
      if (changed) {
        canvas.classList.toggle('over-spot', i >= 0);
        this.dirty = true;
        // Hovering an arrow signals intent — the app prefetches that
        // neighbour so the click is instant (Street View behaviour).
        if (i >= 0) this.opts.onSpotHover?.(this.spots[i].dir);
      }
    };

    const onPointerDown = (e) => {
      canvas.setPointerCapture(e.pointerId);
      this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.press =
        this.ptrs.size === 1
          ? { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false }
          : null;
      if (this.ptrs.size === 2) {
        this.pinch0 = dist();
        this.fov0 = this.fov;
      }
      canvas.classList.add('grabbing');
    };

    const onPointerMove = (e) => {
      const p = this.ptrs.get(e.pointerId);
      if (!p) {
        if (e.pointerType === 'mouse') setHover(spotAt(e.clientX, e.clientY));
        return;
      }
      if (this.press && Math.hypot(e.clientX - this.press.x, e.clientY - this.press.y) > 6) {
        this.press.moved = true;
      }
      const r = canvas.getBoundingClientRect();
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (this.ptrs.size === 2) {
        this.fov = clamp((this.fov0 * this.pinch0) / dist(), FOV_MIN, FOV_MAX);
        this.dirty = true;
        return;
      }
      const k = this.fov / r.height; // radians per pixel
      this.rotate(-dx * k, dy * k); // drag right = look left (grab the scene)
    };

    const endPointer = (e) => {
      const wasClick =
        e.type === 'pointerup' &&
        this.press &&
        this.press.id === e.pointerId &&
        !this.press.moved &&
        this.ptrs.size === 1;
      this.ptrs.delete(e.pointerId);
      if (this.ptrs.size === 0) {
        canvas.classList.remove('grabbing');
        this.press = null;
      }
      if (wasClick) {
        const i = spotAt(e.clientX, e.clientY);
        if (i >= 0) this.opts.onSpot?.(this.spots[i].dir);
      }
    };

    const onWheel = (e) => {
      e.preventDefault();
      this.fov = clamp(this.fov + e.deltaY * 0.0006, FOV_MIN, FOV_MAX);
      this.dirty = true;
    };

    const onKey = (e) => {
      if (!this.active) return; // viewer hidden (kept mounted) — ignore keys
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
        e.preventDefault();
        this.opts.onSpot?.(1);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
        e.preventDefault();
        this.opts.onSpot?.(-1);
      }
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);
    canvas.addEventListener('pointerleave', () => setHover(-1));
    canvas.addEventListener('wheel', onWheel, { passive: false });
    document.addEventListener('keydown', onKey);

    this._off = () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', endPointer);
      canvas.removeEventListener('pointercancel', endPointer);
      canvas.removeEventListener('pointerleave', () => setHover(-1));
      canvas.removeEventListener('wheel', onWheel);
      document.removeEventListener('keydown', onKey);
    };
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this._loadCtl) this._loadCtl.abort();
    this._dolly = null;
    this._off?.();
    this.ro?.disconnect();
    // NOTE: the WebGL context is deliberately NOT lost here — React
    // (StrictMode) remounts the same canvas in dev, and a lost context
    // would break shader compilation for the next engine on it. The canvas
    // and its context are released together by the garbage collector.
  }
}
