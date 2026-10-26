'use client';

import { forwardRef, useEffect, useRef, useImperativeHandle } from 'react';
import { PanoEngine } from './panoEngine';

/**
 * WebGL panorama stage (engine ported from pano-viewer.html).
 *
 * Rendering contract:
 *   - `imageUrl` changes → the incoming image loads into the hidden texture
 *     and crossfades over the current one (350 ms) — no rebuild, no black.
 *   - `view` ({yaw, pitch, hfov} in degrees) is applied to the incoming
 *     image; pass null to keep the current camera (track-sequence moves).
 *   - `canNext` / `canPrev` toggle the in-shader ground arrows; clicking one
 *     fires `onSpot(+1 | -1)`. Keyboard arrows do the same.
 *
 * Imperative handle: getYaw/getPitch/getHfov/setHfov (degrees), getView/
 * setView, project(yawDeg, pitchDeg) → {x, y, visible} for DOM overlays,
 * preload(url).
 */
const PanoGLCanvas = forwardRef(function PanoGLCanvas(
  {
    imageUrl,
    hdImageUrl,
    view = null,
    canNext = false,
    canPrev = false,
    active = true,
    onSpot,
    onSpotHover,
    onLoaded,
    onError,
    onUpgraded,
    onViewChange,
  },
  ref
) {
  const canvasRef = useRef(null);
  const engineRef = useRef(null);
  const cbRef = useRef({});
  cbRef.current = {
    onSpot,
    onSpotHover,
    onLoaded,
    onError,
    onUpgraded,
    onViewChange,
    imageUrl,
  };

  useEffect(() => {
    const engine = new PanoEngine(canvasRef.current, {
      onSpot: (dir) => cbRef.current.onSpot?.(dir),
      onSpotHover: (dir) => cbRef.current.onSpotHover?.(dir),
      onLoaded: () => cbRef.current.onLoaded?.(),
      onError: (e) => cbRef.current.onError?.(e),
      onUpgraded: () => cbRef.current.onUpgraded?.(),
      onViewChange: (v) => cbRef.current.onViewChange?.(v),
    });
    engineRef.current = engine;
    return () => {
      engineRef.current = null;
      engine.destroy();
    };
  }, []);

  // The viewer stays mounted while hidden — tell the engine so it stops
  // eating keyboard input and frames, and repaints on reveal.
  useEffect(() => {
    engineRef.current?.setActive(active);
  }, [active]);

  // Show a panorama with the two-tier flow: the instant tier (comp) reveals
  // first, HD upgrades it in the background. The applied view rides along
  // with the change so the camera state is settled before the crossfade.
  useEffect(() => {
    // Comp-only first paint. Skip if engine already shows this URL
    // (warm stepFromCache path applied it before React re-rendered).
    if (!imageUrl || !engineRef.current) return;
    const eng = engineRef.current;
    if (eng.currentUrl === imageUrl && eng.hasImage) {
      return;
    }
    eng.loadImage(imageUrl, { view, fade: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl]);

  useEffect(() => {
    engineRef.current?.setSpotAvailability(canNext, canPrev);
  }, [canNext, canPrev]);

  useImperativeHandle(
    ref,
    () => ({
      getYaw: () => engineRef.current?.getYaw() ?? 0,
      getPitch: () => engineRef.current?.getPitch() ?? 0,
      getHfov: () => engineRef.current?.getHfov() ?? 75,
      setHfov: (deg) => engineRef.current?.setHfov(deg),
      getView: () =>
        engineRef.current?.getView() ?? { yaw: 0, pitch: 0, hfov: 75 },
      setView: (v) => engineRef.current?.setView(v),
      setSpotAvailability: (canNext, canPrev) =>
        engineRef.current?.setSpotAvailability(canNext, canPrev),
      clearStage: () => engineRef.current?.clearStage(),
      setMarkerOverlay: (fn) => engineRef.current?.setMarkerOverlay(fn),
      beginStepDolly: (dir) => engineRef.current?.beginStepDolly(dir),
      stepFromCache: (url, dir) =>
        engineRef.current?.stepFromCache?.(url, dir) || false,
      isReady: (url) => engineRef.current?.isReady?.(url) || false,
      isStepping: () => engineRef.current?.isStepping?.() || false,
      setPinnedNeighbors: (urls) => engineRef.current?.setPinnedNeighbors(urls),
      groundPoint: (clientX, clientY) =>
        engineRef.current?.groundPoint(clientX, clientY) ?? null,
      project: (yawDeg, pitchDeg) =>
        engineRef.current?.project(yawDeg, pitchDeg) ?? { visible: false },
      preload: (url) => engineRef.current?.preload(url),
      prewarmUrl: (url) => engineRef.current?.prewarmUrl?.(url),
    }),
    []
  );

  return (
    <canvas
      ref={canvasRef}
      className='pano-gl-canvas absolute inset-0 h-full w-full'
    />
  );
});

export default PanoGLCanvas;
