'use client';

import React, { useEffect, useRef } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { setCameraOrientation } from '@/app/redux/slices/uiControlsSlice';

const VS_SOURCE = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  v_uv.y = 1.0 - v_uv.y;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const FS_SOURCE = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_texCurr;
uniform sampler2D u_texNext;
uniform float u_mixRatio;
uniform float u_yaw;
uniform float u_pitch;
uniform float u_fov;
uniform float u_aspect;
uniform float u_brightness;
uniform float u_contrast;

#define PI 3.14159265359

vec3 rayDirection(vec2 uv, float fovDeg, float aspect, float yawDeg, float pitchDeg) {
  float fovRad = fovDeg * PI / 180.0;
  float yawRad = yawDeg * PI / 180.0;
  float pitchRad = pitchDeg * PI / 180.0;

  vec2 ndc = uv * 2.0 - 1.0;
  float tanHalfFov = tan(fovRad * 0.5);

  vec3 rayLocal = normalize(vec3(ndc.x * aspect * tanHalfFov, ndc.y * tanHalfFov, -1.0));

  // Pitch rotation (X-axis)
  float cp = cos(pitchRad), sp = sin(pitchRad);
  mat3 rotX = mat3(
    1.0, 0.0, 0.0,
    0.0, cp, -sp,
    0.0, sp, cp
  );

  // Yaw rotation (Y-axis)
  float cy = cos(yawRad), sy = sin(yawRad);
  mat3 rotY = mat3(
    cy, 0.0, sy,
    0.0, 1.0, 0.0,
    -sy, 0.0, cy
  );

  return rotY * (rotX * rayLocal);
}

vec2 dirToEquirectUV(vec3 dir) {
  float lng = atan(dir.x, -dir.z);
  float lat = asin(clamp(dir.y, -1.0, 1.0));
  return vec2(0.5 + lng / (2.0 * PI), 0.5 - lat / PI);
}

void main() {
  vec3 dir = rayDirection(v_uv, u_fov, u_aspect, u_yaw, u_pitch);
  vec2 sphereUV = dirToEquirectUV(dir);

  vec4 colCurr = texture(u_texCurr, sphereUV);
  vec4 colNext = texture(u_texNext, sphereUV);
  vec4 color = mix(colCurr, colNext, u_mixRatio);

  // Brightness & Contrast Adjustment
  vec3 adjusted = (color.rgb - 0.5) * u_contrast + 0.5 + (u_brightness - 1.0);
  fragColor = vec4(clamp(adjusted, 0.0, 1.0), color.a);
}`;

export default function PanoCanvasViewer() {
  const canvasRef = useRef(null);
  const dispatch = useDispatch();

  const { files, currentIndex } = useSelector((state) => state.panorama);
  const { yaw, pitch, fov, brightness, contrast } = useSelector(
    (state) => state.uiControls
  );

  const stateRef = useRef({ yaw, pitch, fov, isDragging: false, startX: 0, startY: 0 });
  stateRef.current.yaw = yaw;
  stateRef.current.pitch = pitch;
  stateRef.current.fov = fov;

  const texturesRef = useRef({ curr: null, next: null, currIndex: -1 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext('webgl2');
    if (!gl) {
      console.error('WebGL2 not supported');
      return;
    }

    // Shader Helper Functions
    const createShader = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const program = gl.createProgram();
    const vs = createShader(gl.VERTEX_SHADER, VS_SOURCE);
    const fs = createShader(gl.FRAGMENT_SHADER, FS_SOURCE);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    // Quad geometry
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const posLoc = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    // Uniform locations
    const uLocs = {
      yaw: gl.getUniformLocation(program, 'u_yaw'),
      pitch: gl.getUniformLocation(program, 'u_pitch'),
      fov: gl.getUniformLocation(program, 'u_fov'),
      aspect: gl.getUniformLocation(program, 'u_aspect'),
      mixRatio: gl.getUniformLocation(program, 'u_mixRatio'),
      brightness: gl.getUniformLocation(program, 'u_brightness'),
      contrast: gl.getUniformLocation(program, 'u_contrast'),
      texCurr: gl.getUniformLocation(program, 'u_texCurr'),
      texNext: gl.getUniformLocation(program, 'u_texNext'),
    };

    // Blank texture helper
    const createPlaceholderTexture = () => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        1,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array([20, 20, 20, 255])
      );
      return tex;
    };

    texturesRef.current.curr = createPlaceholderTexture();
    texturesRef.current.next = createPlaceholderTexture();

    let animId;
    const render = () => {
      if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
        canvas.width = canvas.clientWidth;
        canvas.height = canvas.clientHeight;
        gl.viewport(0, 0, canvas.width, canvas.height);
      }

      gl.useProgram(program);
      gl.bindVertexArray(vao);

      gl.uniform1f(uLocs.yaw, stateRef.current.yaw);
      gl.uniform1f(uLocs.pitch, stateRef.current.pitch);
      gl.uniform1f(uLocs.fov, stateRef.current.fov);
      gl.uniform1f(uLocs.aspect, canvas.width / (canvas.height || 1));
      gl.uniform1f(uLocs.mixRatio, 0.0); // Transition ratio
      gl.uniform1f(uLocs.brightness, brightness);
      gl.uniform1f(uLocs.contrast, contrast);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texturesRef.current.curr);
      gl.uniform1i(uLocs.texCurr, 0);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, texturesRef.current.next);
      gl.uniform1i(uLocs.texNext, 1);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
      animId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animId);
      gl.deleteProgram(program);
    };
  }, [brightness, contrast]);

  // Load Panorama Texture on Index Change
  useEffect(() => {
    if (!files || files.length === 0 || !files[currentIndex]) return;

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = files[currentIndex];
    img.onload = () => {
      const gl = canvasRef.current?.getContext('webgl2');
      if (!gl) return;

      const newTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, newTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.generateMipmap(gl.TEXTURE_2D);

      texturesRef.current.curr = newTex;
      texturesRef.current.currIndex = currentIndex;
    };
  }, [files, currentIndex]);

  // Pointer Controls for Pan & Drag
  const handlePointerDown = (e) => {
    stateRef.current.isDragging = true;
    stateRef.current.startX = e.clientX;
    stateRef.current.startY = e.clientY;
  };

  const handlePointerMove = (e) => {
    if (!stateRef.current.isDragging) return;
    const dx = e.clientX - stateRef.current.startX;
    const dy = e.clientY - stateRef.current.startY;

    stateRef.current.startX = e.clientX;
    stateRef.current.startY = e.clientY;

    const sensitivity = stateRef.current.fov / 400;
    const newYaw = stateRef.current.yaw - dx * sensitivity;
    const newPitch = stateRef.current.pitch + dy * sensitivity;

    dispatch(setCameraOrientation({ yaw: newYaw, pitch: newPitch }));
  };

  const handlePointerUp = () => {
    stateRef.current.isDragging = false;
  };

  const handleWheel = (e) => {
    e.preventDefault();
    const zoomFactor = e.deltaY > 0 ? 3 : -3;
    const newFov = stateRef.current.fov + zoomFactor;
    dispatch(setCameraOrientation({ fov: newFov }));
  };

  return (
    <div className="relative w-full h-full overflow-hidden bg-black select-none">
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onWheel={handleWheel}
        className="w-full h-full cursor-grab active:cursor-grabbing block"
      />
    </div>
  );
}