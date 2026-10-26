'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  saveViewPosition,
  selectViewPosition,
} from '@/app/redux/slices/panoramaSlice';
import { selectShowControls } from '@/app/redux/slices/uiControlsSlice';
import { MdAddLocation, MdHd, MdOutlineHd } from 'react-icons/md';
import { FaStoreAlt } from 'react-icons/fa';
import toast from 'react-hot-toast';
import { apiUrl } from '@/app/config/api';
import {
  prefetchImage,
  noteTravelDirection,
  neighborCompUrls,
  fetchFeatureCached,
} from '@/app/utils/panoPrefetch';
import { neighborsWithin } from '@/app/utils/trackManifest';
import {
  panoUrlCandidates,
  pickTierUrl,
  pickCompUrl,
  swapIdInUrl,
} from '@/app/utils/panoUrl';
import {
  markPanoStep,
  markPanoRevealed,
  markHdReady,
  reportPanoTtfb,
} from '@/app/utils/perfMarks';
import { getPoiMarkers } from '@/app/utils/poiMarkers';
import PanoGLCanvas from '../pano-gl/PanoGLCanvas';

// Sliding decoded window around the current frame (thirdeye360-next model,
// bounded). Directional: full radius on the travel side, ±1–2 elsewhere.
// Frames are pinned via setPinnedNeighbors and downloaded/decoded through
// the engine's ONE-at-a-time background lane (R2 sees a single sequential
// stream; a clicked frame always jumps the queue). Engine cache dedupes.
const LOW_MEM_DEVICE =
  typeof navigator !== 'undefined' && (navigator.deviceMemory || 8) <= 2;
const WINDOW_RADIUS = LOW_MEM_DEVICE ? 1 : 4;

const PannellumViewer = ({
  selectedImage,
  images,
  onPrevImage,
  onNextImage,
  active = true, // false while the parent keeps the viewer mounted but hidden
  pannellumInstanceRef, // parent handle: gets a pannellum-compatible view API
  sharedViewState, // exact view from a shared link, if present
}) => {
  const glRef = useRef(null); // live PanoEngine handle
  const canvasWrapRef = useRef(null); // container the POI markers project into
  const [glReady, setGlReady] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [urlIdx, setUrlIdx] = useState(0); // index into the candidate chain
  const [isGeneratingPoi, setIsGeneratingPoi] = useState(false);
  const [isPoiDrawerOpen, setIsPoiDrawerOpen] = useState(false);
  const [poiData, setPoiData] = useState([]);
  const [isFetchingPoi, setIsFetchingPoi] = useState(false);
  const lastSaveRef = useRef(0);
  const markerElsRef = useRef({}); // marker key -> DOM element (positioned per frame)
  const [poiMarkers, setPoiMarkers] = useState([]);

  const pendingViewRef = useRef(null); // carried view for the incoming capture
  // True when the next image change came from a ground-arrow / keyboard step.
  // Steps must NEVER show the loading overlay (Next.js app UX).
  const stepNavRef = useRef(false);
  // Last stepped direction (+1 forward / -1 back / 0 unknown) — biases which
  // side of the neighbour prefetch gets its depth-2 extra frame.
  const travelDirRef = useRef(0);

  const props = selectedImage?.properties;
  const currentImageId = props?.id ?? null;

  // Image URL candidates (authoritative property URL first, then configured
  // alternate hosts). A load error walks to the next candidate automatically;
  // both tiers follow the same host switch.
  const compCandidates = panoUrlCandidates(props, 'comp');
  const hdCandidates = panoUrlCandidates(props, 'high');
  // HD toggle: on = the current pano loads its native-resolution image
  const [isHDMode, setIsHDMode] = useState(false);
  useEffect(() => {
    setUrlIdx(0); // reset the fallback walk on every image change
  }, [currentImageId, isHDMode]);
  // No image URL on the feature → fail fast (never spin loading 20–30s)
  useEffect(() => {
    if (!currentImageId) return;
    if (!compCandidates.length && !hdCandidates.length) {
      setIsLoading(false);
      setError('No panorama URL for this point.');
    }
  }, [currentImageId, compCandidates.length, hdCandidates.length]);

  const candidates =
    isHDMode && hdCandidates.length ? hdCandidates : compCandidates;
  const finalComp = candidates[urlIdx] || candidates[0] || '';
  // HD HARD-OFF: first paint = compressed image of the clicked point only.
  // Neighbours (±4) prefetch in background after onLoaded — never blocks UX.
  const hdUpgradeEnabled = false;
  const finalHd = '';

  // Carried view for the incoming capture: the exact view the user had when
  // they clicked a ground arrow (facing back stays facing back). Map clicks
  // and shared links pass their own view; plain track moves keep the camera.
  const carried =
    pendingViewRef.current &&
    pendingViewRef.current.targetId === String(currentImageId) &&
    Date.now() - pendingViewRef.current.at < 15000 &&
    sharedViewState?.yaw === undefined
      ? pendingViewRef.current.view
      : null;
  const normYaw = (y) => ((((y ?? 0) + 180) % 360) + 360) % 360 - 180;
  const incomingView = sharedViewState?.yaw !== undefined
    ? {
        yaw: normYaw(sharedViewState.yaw),
        pitch: sharedViewState.pitch ?? 0,
        hfov: sharedViewState.hfov ?? 75,
      }
    : carried
    ? {
        yaw: normYaw(carried.yaw),
        pitch: carried.pitch ?? 0,
        hfov: carried.hfov ?? 75,
      }
    : null;

  const rememberViewFor = (targetId) => {
    const v = glRef.current?.getView();
    if (!v || !targetId) return;
    pendingViewRef.current = {
      targetId: String(targetId),
      view: v,
      at: Date.now(),
    };
  };

  // Redux
  const dispatch = useDispatch();
  const savedViewPosition = useSelector((state) =>
    selectViewPosition(state, selectedImage?.properties?.id)
  );
  const showControls = useSelector(selectShowControls);

  // Expose a pannellum-compatible view API to the parent via ref
  useEffect(() => {
    if (!pannellumInstanceRef) return;
    pannellumInstanceRef.current = {
      getYaw: () => glRef.current?.getYaw() ?? 0,
      getPitch: () => glRef.current?.getPitch() ?? 0,
      getHfov: () => glRef.current?.getHfov() ?? 75,
      setHfov: (deg) => glRef.current?.setHfov(deg),
      setYaw: (deg) => glRef.current?.setView({ yaw: deg }),
      setPitch: (deg) => glRef.current?.setView({ pitch: deg }),
    };
  }, [pannellumInstanceRef]);

  const saveCurrentViewPosition = useCallback(() => {
    // Mid-dolly FOV is transient — never persist it
    if (glRef.current?.isStepping?.()) return;
    const v = glRef.current?.getView();
    if (!v || !selectedImage) return;
    if (
      !savedViewPosition ||
      Math.abs(savedViewPosition.yaw - v.yaw) > 1 ||
      Math.abs(savedViewPosition.pitch - v.pitch) > 1 ||
      Math.abs(savedViewPosition.hfov - v.hfov) > 1
    ) {
      dispatch(
        saveViewPosition({ imageId: selectedImage.properties.id, position: v })
      );
    }
  }, [dispatch, savedViewPosition, selectedImage]);

  // Generate POI using the feature_id from the selected image
  const generatePoi = async () => {
    if (
      !selectedImage ||
      !selectedImage.properties.latitude_snapped ||
      !selectedImage.properties.longitude_snapped
    ) {
      toast.error('No image selected or missing required coordinates');
      return;
    }

    // POI accuracy benefits from the sharpest available image
    const imageUrl = pickTierUrl(selectedImage.properties, 'high') || '';

    if (!imageUrl) {
      toast.error('Image URL is not available');
      return;
    }

    setIsGeneratingPoi(true);
    try {
      const requestBody = {
        image_url: imageUrl,
        latitude: selectedImage.properties.latitude_snapped,
        longitude: selectedImage.properties.longitude_snapped,
      };
      if (selectedImage.properties.id) {
        requestBody.feature_id = selectedImage.properties.id;
      }

      const response = await fetch(apiUrl('/api/generate-poi'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      const data = await response.json();
      if (response.ok) {
        toast.success('POI generated successfully!');
        if (data.message) toast.success(data.message);
      } else {
        toast.error(`Error: ${data.message || 'Failed to generate POI'}`);
      }
    } catch (error) {
      console.error('Error generating POI:', error);
      toast.error(`Failed to generate POI: ${error.message || 'Network error'}`);
    } finally {
      setIsGeneratingPoi(false);
    }
  };

  const fetchPoiData = async () => {
    if (!props || !props.latitude_snapped || !props.longitude_snapped) {
      toast.error('No image selected or missing coordinates');
      setPoiData([]);
      return;
    }
    setIsFetchingPoi(true);
    try {
      const response = await fetch(
        apiUrl(
          `/api/point-of-interest?lat=${props.latitude_snapped}&lon=${props.longitude_snapped}&rad=5`
        )
      );
      const data = await response.json();
      if (response.ok && data.status === 'success') {
        setPoiData(data.pois || []);
      } else {
        setPoiData([]);
        toast.error(data.message || 'Failed to fetch POI data');
      }
    } catch (error) {
      console.error('Error fetching POI data:', error);
      setPoiData([]);
      toast.error('Failed to fetch POI data: Network error');
    } finally {
      setIsFetchingPoi(false);
    }
  };

  const togglePoiDrawer = () => {
    setIsPoiDrawerOpen((prev) => !prev);
    if (!isPoiDrawerOpen && poiData.length === 0) {
      fetchPoiData();
    }
  };

  // Fetch POI data when the selected image changes
  useEffect(() => {
    setPoiData([]);
    setIsPoiDrawerOpen(false);
  }, [selectedImage]);

  // Roadside POI markers (Google-style, projected onto the GL stage)
  useEffect(() => {
    let active = true;
    if (!selectedImage?.properties) {
      setPoiMarkers([]);
      return undefined;
    }
    getPoiMarkers(selectedImage.properties)
      .then((markers) => {
        if (active) setPoiMarkers(markers || []);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [selectedImage]);

  // POI markers are projected INSIDE the engine's draw loop (same frame the
  // GPU draws) — updating them from a separate loop made them swim behind
  // the canvas while rotating. Each marker stays locked to its lat/lon on
  // the road; it only crosses the screen as the view itself rotates.
  useEffect(() => {
    const update = (hasImage) => {
      const engine = glRef.current;
      if (!engine) return;
      const els = markerElsRef.current;
      if (!engine.hasImage) {
        Object.values(els).forEach((el) => {
          el.style.display = 'none';
        });
        return;
      }
      for (const m of poiMarkers) {
        const el = els[m.id];
        if (!el) continue;
        const s = engine.project(m.yaw, m.pitch);
        if (!s || !s.visible) {
          el.style.display = 'none';
          continue;
        }
        el.style.display = 'block';
        el.style.left = `${s.x}px`;
        el.style.top = `${s.y}px`;
      }
    };
    glRef.current?.setMarkerOverlay(update);
    update();
    return () => glRef.current?.setMarkerOverlay(null);
  }, [poiMarkers]);

  // Fixed in-shader ground arrows (Street View style, ported from
  // pano-viewer.html): they sit painted on the road ahead/behind on every
  // device. Hover highlights an arrow, clicking it moves; nothing follows
  // the mouse.
  useEffect(() => {
    const p = selectedImage?.properties;
    glRef.current?.setSpotAvailability(!!p?.next_id, !!p?.previous_id);
  }, [glReady, selectedImage]);

  // Jump vs step:
  //  • Arrow/keyboard step (stepNavRef) → never show loading, keep stage
  //  • Map / shared-link jump → loading overlay + clear stage
  //  • Fallback: chain/numeric neighbour detection (optimistic props)
  const prevPropsRef = useRef(null);
  useEffect(() => {
    const prev = prevPropsRef.current;
    prevPropsRef.current = props || null;
    if (!props?.id || !prev || prev.id === props.id) return;

    // Explicit step from ground arrow / keyboard — same UX as Next.js app
    if (stepNavRef.current) {
      stepNavRef.current = false;
      setIsLoading(false); // never spinner mid-track
      return;
    }

    const chainedStep =
      prev.next_id === props.id || prev.previous_id === props.id;
    const numericStep = (() => {
      const a = /^(\d+)_(\d+)$/.exec(String(prev.id));
      const b = /^(\d+)_(\d+)$/.exec(String(props.id));
      return (
        !!a &&
        !!b &&
        a[1] === b[1] &&
        Math.abs(Number(b[2]) - Number(a[2])) <= 4 // allow small gaps without spinner
      );
    })();
    if (chainedStep || numericStep) {
      setIsLoading(false);
      return;
    }
    // True jump (map click to a distant point)
    setIsLoading(true);
    glRef.current?.clearStage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentImageId]);

  // Neighbour prefetch is re-armed here on EVERY committed frame — warm and
  // cold steps alike. This used to live in handleEngineLoaded, but on warm
  // steps (stepFromCache) onLoaded fires synchronously BEFORE the React
  // commit, so it always read the previous frame's properties and the frame
  // ahead was never fetched — every second arrow click held on the network.
  // Model: ±1 pinned sync (instant), then the full sliding window (±4 both
  // directions — thirdeye360-next model) resolved from the track manifest
  // and pinned too. The engine downloads window frames up to 4-at-a-time in
  // parallel and a clicked frame always jumps the queue. Steady walking
  // still costs ~1 new image per step — the engine cache dedupes anything
  // already in flight.
  useEffect(() => {
    if (!glReady) return undefined;
    const p = selectedImage?.properties;
    if (!p?.id) return undefined;
    const base = pickCompUrl(p);
    if (!base) return undefined;
    const engine = glRef.current;
    const urlFor = (id) => (id ? swapIdInUrl(base, p.id, id) : null);

    const urls = [];
    if (p.next_id) urls.push(urlFor(p.next_id));
    if (p.previous_id) urls.push(urlFor(p.previous_id));
    engine?.setPinnedNeighbors(urls);
    const nextU = urlFor(p.next_id);
    if (nextU) engine?.prewarmUrl?.(nextU);

    // Full parallel window, reference-app style: ±4 in BOTH directions,
    // fetched concurrently through the engine's bounded-parallel lane. Ids
    // beyond ±1 must be exact — guessed numeric neighbours can be gaps
    // (779_125 -> 779_127) and 404. Manifest first; chain-link fallback.
    const dir = travelDirRef.current;
    const fwd = WINDOW_RADIUS;
    const back = WINDOW_RADIUS;
    let active = true;
    (async () => {
      let winUrls = null;
      try {
        const around = await neighborsWithin(p.id, { fwd, back });
        if (around) {
          const ids = [];
          const depth = Math.max(around.fwd.length, around.back.length);
          // Nearest-first, alternating sides — queue order follows this.
          for (let d = 0; d < depth; d++) {
            if (around.fwd[d]) ids.push(around.fwd[d]);
            if (around.back[d]) ids.push(around.back[d]);
          }
          winUrls = ids.map((id) => urlFor(id)).filter(Boolean);
        }
      } catch {
        winUrls = null;
      }
      if (!active || !engine || engine.destroyed) return;
      if (!winUrls || !winUrls.length) {
        // No manifest for this track — keep the chain-link fallback: one
        // extra frame beyond the travel side via the neighbour's properties.
        const nearId = dir > 0 ? p.next_id : dir < 0 ? p.previous_id : null;
        if (!nearId) return;
        try {
          const nb = await fetchFeatureCached(nearId);
          const farId = nb ? (dir > 0 ? nb.next_id : nb.previous_id) : null;
          if (!farId || String(farId) === String(p.id)) return;
          const farUrl = urlFor(farId);
          if (farUrl) winUrls = [farUrl];
        } catch {
          return;
        }
      }
      if (!winUrls || !winUrls.length) return;
      engine.setPinnedNeighbors([...new Set([...urls, ...winUrls])]);
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentImageId, glReady]);

  // Reset the POI drawer when the image changes
  useEffect(() => {
    setPoiData([]);
    setIsPoiDrawerOpen(false);
  }, [selectedImage]);

  // Fixed ground arrow clicked: forward → next capture, back → previous.
  // Move-style dolly (optical flow from FOE) + mid-path crossfade to the
  // prefetched frame. FOV is not changed.
  const handleSpot = (dir) => {
    const p = selectedImage?.properties;
    if (!p) return;
    noteTravelDirection(dir);
    travelDirRef.current = dir > 0 ? 1 : -1;
    markPanoStep(dir);
    const targetId = dir === 1 ? p.next_id : p.previous_id;
    if (!targetId) return;

    const targetUrl = swapIdInUrl(pickCompUrl(p), p.id, targetId);
    stepNavRef.current = true;
    setIsLoading(false);

    // Next.js warm path: cache hit → GPU swap + dolly NOW (no React wait)
    if (targetUrl && glRef.current?.isReady?.(targetUrl)) {
      glRef.current.stepFromCache(targetUrl, dir);
      if (dir === 1) onNextImage();
      else onPrevImage();
      return;
    }

    // Cold path: mark dolly dir, then parent setState → loadImage
    glRef.current?.beginStepDolly(dir);
    if (dir === 1) onNextImage();
    else onPrevImage();
  };

  // Hovering a ground arrow signals intent to move — prefetch that neighbour
  // (bytes + decoded texture) so the click crossfades instantly.
  const handleSpotHover = (dir) => {
    const p = selectedImage?.properties;
    if (!p) return;
    noteTravelDirection(dir);
    travelDirRef.current = dir > 0 ? 1 : -1;
    const targetId = dir === 1 ? p.next_id : p.previous_id;
    const url = targetId && swapIdInUrl(pickCompUrl(p), p.id, targetId);
    if (!url) return;
    // Engine cache only (same cache the step will read)
    glRef.current?.preload(url);
  };

  const handleEngineLoaded = () => {
    // First paint is ready — drop loading overlay immediately.
    // (Neighbour pinning/prewarm lives in the committed-frame effect above:
    // onLoaded fires before the React commit on warm steps, so reading
    // selectedImage here saw the previous frame and starved the prefetch.)
    setIsLoading(false);
    setGlReady(true);
    markPanoRevealed();
    if (finalComp) reportPanoTtfb(finalComp);
  };

  // The HD tier finished upgrading the frame on screen
  const handleEngineUpgraded = () => {
    markHdReady();
  };

  const handleEngineError = (err) => {
    console.error('PanoGLCanvas error:', err);
    if (urlIdx + 1 < candidates.length) {
      // Walk to the next URL candidate — the stage reloads automatically.
      setUrlIdx((i) => i + 1);
    } else {
      setIsLoading(false);
      setError('Could not load this panorama.');
    }
  };

  const [error, setError] = useState(null);

  // Persist the view: periodic save plus a save shortly after each
  // interaction with the stage.
  const saveTimeoutRef = useRef(0);
  useEffect(() => {
    if (!glReady || !selectedImage) return undefined;
    const saveInterval = setInterval(saveCurrentViewPosition, 5000);
    const handleInteraction = () => {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(saveCurrentViewPosition, 500);
    };
    const wrap = canvasWrapRef.current;
    wrap?.addEventListener('mousedown', handleInteraction);
    wrap?.addEventListener('wheel', handleInteraction);
    wrap?.addEventListener('touchstart', handleInteraction);
    return () => {
      clearInterval(saveInterval);
      wrap?.removeEventListener('mousedown', handleInteraction);
      wrap?.removeEventListener('wheel', handleInteraction);
      wrap?.removeEventListener('touchstart', handleInteraction);
      clearTimeout(saveTimeoutRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glReady, selectedImage?.properties?.id]);

  // Engine view updates fire on every animated frame while the user pans or
  // zooms — debounce the redux save so a drag never dispatches per frame.
  const handleEngineViewChange = useCallback(() => {
    clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(saveCurrentViewPosition, 500);
  }, [saveCurrentViewPosition]);

  return (
    <>
      <div ref={canvasWrapRef} className='relative h-full w-full'>
        <PanoGLCanvas
          ref={glRef}
          imageUrl={finalComp}
          hdImageUrl={undefined}
          view={incomingView}
          canNext={!!props?.next_id}
          canPrev={!!props?.previous_id}
          active={active}
          onSpot={handleSpot}
          onSpotHover={handleSpotHover}
          onLoaded={handleEngineLoaded}
          onUpgraded={handleEngineUpgraded}
          onError={handleEngineError}
          onViewChange={handleEngineViewChange}
        />

        {/* Roadside POI markers, projected from yaw/pitch every frame. */}
        {poiMarkers.map((m) => (
          <div
            key={m.id}
            ref={(el) => {
              if (el) markerElsRef.current[m.id] = el;
              else delete markerElsRef.current[m.id];
            }}
            className='poi-marker'
            style={{ position: 'absolute', left: -999, top: -999 }}
          >
            <div className='poi-marker-icon'>
              <svg viewBox='0 0 24 24' fill='none' aria-hidden='true'>
                <path
                  d='M12 21s-7-5.1-7-11a7 7 0 1 1 14 0c0 5.9-7 11-7 11z'
                  stroke='currentColor'
                  strokeWidth='2'
                />
                <circle cx='12' cy='10' r='2.6' fill='currentColor' />
              </svg>
            </div>
            <div className='poi-card'>
              <div className='poi-card-badges'>
                <span className='poi-chip poi-chip-dim'>
                  CODE <b>{m.poi.place_code}</b>
                </span>
              </div>
              <div className='poi-card-name'>{m.poi.name}</div>
              {m.poi.address && (
                <div className='poi-card-addr'>{m.poi.address}</div>
              )}
            </div>
          </div>
        ))}
      </div>

      {isLoading && (
        <div className='absolute inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-md'>
          <div className='relative h-14 w-14'>
            <div className='absolute inset-0 rounded-full border border-white/10' />
            <div className='absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-brand-400 [animation-duration:0.9s]' />
            <div className='absolute inset-0 flex items-center justify-center'>
              <div className='h-1.5 w-1.5 animate-pulse rounded-full bg-brand-400' />
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className='absolute inset-x-0 top-4 z-50 mx-auto w-fit rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-xs font-semibold text-rose-700'>
          {error}
        </div>
      )}

      {glReady && selectedImage && showControls && (
        <>
          {/* Glass dock extension of the right control stack in ImageViewer
              (HD quality, generate POI, POI drawer) */}
          <div className='pointer-events-auto absolute bottom-[17rem] right-4 z-30 md:right-6'>
            <div className='glass-dock flex flex-col space-y-1 rounded-2xl border border-white/20 p-1 shadow-floating-dark'>
              {/* HD quality toggle — on loads the native-resolution image */}
              <button
                type='button'
                className={`glass-btn flex h-9 w-9 items-center justify-center rounded-xl ${
                  isHDMode
                    ? '!bg-emerald-500 !text-slate-950 hover:!bg-emerald-500'
                    : 'text-slate-300 hover:text-white'
                }`}
                onClick={() => setIsHDMode((prev) => !prev)}
                aria-label='Toggle HD quality'
                title={isHDMode ? 'HD quality (on)' : 'HD quality (off)'}
              >
                {isHDMode ? (
                  <MdHd className='text-lg' />
                ) : (
                  <MdOutlineHd className='text-lg' />
                )}
              </button>

              <div className='mx-1.5 h-px bg-white/10'></div>

              {/* Generate POI */}
              <button
                type='button'
                className={`glass-btn flex h-9 w-9 items-center justify-center rounded-xl text-slate-300 ${
                  isGeneratingPoi ? 'cursor-not-allowed opacity-70' : ''
                }`}
                onClick={generatePoi}
                aria-label='Generate POI'
                disabled={isGeneratingPoi}
                title='Generate POI for this location'
              >
                {isGeneratingPoi ? (
                  <svg
                    className='h-4 w-4 animate-spin'
                    xmlns='http://www.w3.org/2000/svg'
                    fill='none'
                    viewBox='0 0 24 24'
                  >
                    <circle
                      className='opacity-25'
                      cx='12'
                      cy='12'
                      r='10'
                      stroke='currentColor'
                      strokeWidth='4'
                    ></circle>
                    <path
                      className='opacity-75'
                      fill='currentColor'
                      d='M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z'
                    ></path>
                  </svg>
                ) : (
                  <MdAddLocation className='text-lg' />
                )}
              </button>

              {/* POI drawer toggle */}
              <button
                type='button'
                className={`glass-btn flex h-9 w-9 items-center justify-center rounded-xl text-slate-300 ${
                  isFetchingPoi ? 'cursor-not-allowed opacity-60' : ''
                }`}
                onClick={togglePoiDrawer}
                aria-label='Toggle Points of Interest Drawer'
                disabled={isFetchingPoi}
                title='View Points of Interest'
              >
                {isFetchingPoi ? (
                  <svg
                    className='h-4 w-4 animate-spin'
                    xmlns='http://www.w3.org/2000/svg'
                    fill='none'
                    viewBox='0 0 24 24'
                  >
                    <circle
                      className='opacity-25'
                      cx='12'
                      cy='12'
                      r='10'
                      stroke='currentColor'
                      strokeWidth='4'
                    ></circle>
                    <path
                      className='opacity-75'
                      fill='currentColor'
                      d='M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z'
                    ></path>
                  </svg>
                ) : (
                  <FaStoreAlt className='text-base' />
                )}
              </button>
            </div>
          </div>

          {/* POI Drawer */}
          {isPoiDrawerOpen && (
            <div className='dark glass-dock absolute left-1/2 top-44 z-50 max-h-[50vh] w-full max-w-xs -translate-x-1/2 overflow-y-auto rounded-2xl border border-white/15 p-3 shadow-floating-dark transition-all duration-300 ease-out'>
              <h3 className='text-base font-semibold text-slate-800 dark:text-slate-100 mb-2'>
                Points of Interest
              </h3>
              {isFetchingPoi ? (
                <div className='flex items-center justify-center py-4'>
                  <svg
                    className='animate-spin h-5 w-5 text-emerald-500'
                    xmlns='http://www.w3.org/2000/svg'
                    fill='none'
                    viewBox='0 0 24 24'
                  >
                    <circle
                      className='opacity-25'
                      cx='12'
                      cy='12'
                      r='10'
                      stroke='currentColor'
                      strokeWidth='4'
                    ></circle>
                    <path
                      className='opacity-75'
                      fill='currentColor'
                      d='M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z'
                    ></path>
                  </svg>
                </div>
              ) : poiData.length > 0 ? (
                <ul className='space-y-3'>
                  {poiData.map((poi) => (
                    <li
                      key={poi.id}
                      className='bg-white/80 dark:bg-slate-900/80 rounded-2xl shadow-sm hover:shadow-md transition-shadow duration-300 p-4 border border-slate-100 dark:border-slate-700'
                    >
                      {/* Title */}
                      <div className='font-semibold text-slate-800 dark:text-slate-100 text-base flex items-center gap-2'>
                        <span className='w-2 h-2 rounded-full bg-emerald-500'></span>
                        {poi.text}
                      </div>

                      {/* Meta Info */}
                      <div className='mt-3 text-xs text-slate-600 dark:text-slate-300 space-y-1'>
                        <div className='flex items-center gap-2'>
                          <span className='font-medium text-slate-700 dark:text-slate-200'>
                            Type:
                          </span>
                          <span className='px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 font-medium'>
                            {poi.type}
                          </span>
                        </div>

                        <div className='flex items-center gap-2'>
                          <span className='font-medium text-slate-700 dark:text-slate-200'>
                            Location:
                          </span>
                          <span className='truncate'>{poi.location}</span>
                        </div>

                        <div className='flex items-center gap-2'>
                          <span className='font-medium text-slate-700 dark:text-slate-200'>
                            Confidence:
                          </span>
                          <span className='px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-300 font-medium'>
                            {(poi.confidence * 100).toFixed(0)}%
                          </span>
                        </div>

                        <div className='flex items-center gap-2'>
                          <span className='font-medium text-slate-700 dark:text-slate-200'>
                            Language:
                          </span>
                          <span className='px-2 py-0.5 rounded-full bg-teal-50 dark:bg-teal-900/30 text-teal-600 dark:text-teal-300 font-medium'>
                            {poi.language}
                          </span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className='text-slate-500 dark:text-slate-400 text-sm py-2'>
                  No data available
                </div>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
};

export default React.memo(PannellumViewer, (prevProps, nextProps) => {
  return (
    prevProps.selectedImage === nextProps.selectedImage &&
    prevProps.sharedViewState === nextProps.sharedViewState &&
    prevProps.active === nextProps.active
  );
});
