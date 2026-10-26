"use client";

import { useState, useCallback, useEffect, useRef, Suspense } from "react";
import Header from "@/app/components/layout/Header";
import MapComponent from "./components/map/MapComponent";
import ImageViewer from "./components/viewer/ImageViewer";
import { useImageData } from "./data/imageData";
import { getCachedFeature, fetchFeatureCached } from "./utils/panoPrefetch";
import { PathStore, PRELOAD_RADIUS } from "./utils/pathStore";
import { neighborId } from "./utils/trackManifest";
import { markPanoSelect } from "./utils/perfMarks";
import { apiUrl } from "./config/api";
import { useSearchParams, useRouter } from "next/navigation";

// Force dynamic rendering for this page
export const dynamic = "force-dynamic";

function HomeContent() {
  const [selectedImageId, setSelectedImageId] = useState(null);
  const [selectedImageData, setSelectedImageData] = useState(null);
  const [showViewer, setShowViewer] = useState(false);
  // The viewer stays mounted after its first open so the WebGL engine and
  // its decoded-texture cache survive close/reopen.
  const [viewerEverOpened, setViewerEverOpened] = useState(false);
  const [isLoadingFeature, setIsLoadingFeature] = useState(false);
  const { isLoading, error, refreshData } = useImageData();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pannellumInstanceRef = useRef(null);
  // Next.js-style in-memory path (tile props → PathStore → next_id)
  const pathStoreRef = useRef(null);
  const captureRegistryRef = useRef(new Map());
  const [sharedViewState, setSharedViewState] = useState(null);
  const [mapFocus, setMapFocus] = useState(null); // Re-centers the main map after exiting to a searched location
  const hasProcessedSharedLink = useRef(false);
  const viewerWasOpenRef = useRef(false); // Track if viewer was previously open
  const hasInitializedView = useRef(false); // Track if view has been initialized
  const selectedImageIdRef = useRef(null); // Fresh id for in-flight reconciles

  useEffect(() => {
    selectedImageIdRef.current = selectedImageId;
  }, [selectedImageId]);

  // Function to update browser URL with current view state
  const updateBrowserUrl = useCallback(
    (imageId, viewState = null) => {
      if (!imageId) return;

      const params = new URLSearchParams();
      params.set("id", imageId);

      if (viewState) {
        if (viewState.yaw !== undefined)
          params.set("yaw", viewState.yaw.toFixed(2));
        if (viewState.pitch !== undefined)
          params.set("pitch", viewState.pitch.toFixed(2));
        if (viewState.hfov !== undefined)
          params.set("hfov", viewState.hfov.toFixed(2));
      }

      // Update URL without page reload
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router]
  );

  // Update URL when image changes (but not on initial shared link load)
  useEffect(() => {
    if (showViewer && selectedImageId) {
      // Skip updating URL if we're still processing a shared link with view state
      if (sharedViewState !== null) {
        return;
      }

      // Get current view state if pannellum is ready
      let viewState = null;
      if (pannellumInstanceRef?.current) {
        try {
          viewState = {
            yaw: pannellumInstanceRef.current.getYaw(),
            pitch: pannellumInstanceRef.current.getPitch(),
            hfov: pannellumInstanceRef.current.getHfov(),
          };
        } catch (error) {
          // Pannellum not ready yet, that's okay
        }
      }

      // Only update URL if pannellum is initialized or we're not from a shared link
      if (hasInitializedView.current || !searchParams.get("yaw")) {
        updateBrowserUrl(selectedImageId, viewState);
      }
    }
  }, [
    selectedImageId,
    showViewer,
    updateBrowserUrl,
    sharedViewState,
    searchParams,
  ]);

  // Clear URL when viewer is closed (but not on initial mount)
  useEffect(() => {
    if (!showViewer && viewerWasOpenRef.current) {
      router.replace("/", { scroll: false });
      viewerWasOpenRef.current = false;
    } else if (showViewer) {
      viewerWasOpenRef.current = true;
    }
  }, [showViewer, router]);

  // Helper function to extract track and image numbers from image ID
  const parseImageId = (id) => {
    // If no id is provided, return default values
    if (!id) return { trackNumber: 0, imageNumber: 0 };

    // For backward compatibility, try to parse from the id directly
    const idMatch = String(id).match(/^(\d+)_(\d+)/);
    if (idMatch) {
      return {
        trackNumber: parseInt(idMatch[1], 10),
        imageNumber: parseInt(idMatch[2], 10),
      };
    }

    return { trackNumber: 0, imageNumber: 0 };
  };

  // Function to fetch feature by ID from API
  // Served from the prefetch cache when the neighbour-prefetcher has already
  // grabbed it — makes prev/next navigation effectively instant. `silent`
  // skips the fullscreen overlay (background reconciles must never flash it).
  const fetchFeatureById = useCallback(async (featureId, { silent = false } = {}) => {
    if (!featureId) return null;

    const cachedProperties = getCachedFeature(featureId);
    if (cachedProperties) {
      return { properties: cachedProperties };
    }

    if (!silent) setIsLoadingFeature(true);
    try {
      // Hard timeout: a stalled request must never pin the loading overlay
      const response = await fetch(apiUrl(`/api/features/${featureId}`), {
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        throw new Error(`API response error: ${response.status}`);
      }

      const featureData = await response.json();
      return featureData;
    } catch (error) {
      console.error(`Failed to fetch feature ${featureId}:`, error);
      return null;
    } finally {
      if (!silent) setIsLoadingFeature(false);
    }
  }, []);

  const handleImageSelect = useCallback((imageData) => {
    markPanoSelect();
    // Check if imageData is a string (old behavior - just ID) or an object (new behavior - full properties)
    if (typeof imageData === "string" || typeof imageData === "number") {
      setSelectedImageId(imageData);
      setSelectedImageData(null);
      pathStoreRef.current = null;
    } else {
      // Tile props → PathStore (same as Next.js registry + reset)
      const reg = captureRegistryRef.current;
      reg.set(imageData.id, imageData);
      const path = new PathStore(reg);
      path.reset(imageData);
      path.extend(PRELOAD_RADIUS + 1);
      pathStoreRef.current = path;

      setSelectedImageId(imageData.id);
      setSelectedImageData(imageData);
    }
    setViewerEverOpened(true);
    setShowViewer(true);
  }, []);

  const handleCloseViewer = useCallback(() => {
    setShowViewer(false);
  }, []);

  // Exit the 360 viewer and re-center the overview map on a searched location
  const handleExitToLocation = useCallback(
    (location) => {
      if (!location || !location.longitude || !location.latitude) return;

      // A one-feature collection makes the main map move to this location
      setMapFocus({
        features: [
          {
            type: "Feature",
            properties: { id: `exit-location-${Date.now()}` },
            geometry: {
              type: "Point",
              coordinates: [
                parseFloat(location.longitude),
                parseFloat(location.latitude),
              ],
            },
          },
        ],
      });

      handleCloseViewer();
    },
    [handleCloseViewer]
  );

  // Step to the next (dir=1) or previous (dir=-1) capture. The paint happens
  // synchronously from derived properties; the authoritative feature is then
  // reconciled in the background (guarded against a newer step overtaking it).
  const stepToImage = useCallback(
    (dir) => {
      // Next.js PathStore.step — in-memory next_id / previous_id only.
      // Zero network on the critical path (same as the demo Next app).
      let path = pathStoreRef.current;
      const current = selectedImageData;
      if (!current?.id) return;

      if (!path) {
        const reg = captureRegistryRef.current;
        reg.set(current.id, current);
        path = new PathStore(reg);
        path.reset(current);
        path.extend(PRELOAD_RADIUS + 1);
        pathStoreRef.current = path;
      } else {
        // Keep registry warm with latest props (reconciles from prior API/tile)
        path.register(current);
        path.setCurrent(current.id);
      }

      const next = path.step(dir > 0 ? 1 : -1);
      if (!next) return;

      setSelectedImageId(next.id);
      setSelectedImageData(next);

      // Synthetic paint (URL swapped, no authoritative chain yet): reconcile
      // silently with the real feature properties so next_id / previous_id
      // come from the API and the walk continues. Never blocks the paint, and
      // a newer step simply overtakes this update.
      if (next.synthetic) {
        fetchFeatureCached(next.id).then((real) => {
          if (!real?.id) return;
          path.register(real);
          setSelectedImageData((cur) => (cur?.id === real.id ? real : cur));
        });
      }
    },
    [selectedImageData]
  );

  const handleNextImage = useCallback(() => stepToImage(1), [stepToImage]);

  // Timeline date click: jump to that date's nearest frame and reset the
  // path so arrows walk within the selected capture date only. The viewer
  // stays open; a cold jump shows the loading overlay (same as map clicks).
  const handleTimelineSelect = useCallback(
    async (entry) => {
      const featureId = entry?.nearest?.feature_id;
      if (!featureId) return;
      let propsData = null;
      try {
        const real = await fetchFeatureById(featureId, { silent: false });
        if (real?.properties) propsData = real.properties;
      } catch {
        propsData = null;
      }
      if (!propsData) {
        propsData = {
          id: featureId,
          imageUrl_Comp: entry.nearest.image_url_comp || "",
          capture_date: entry.label || "",
          latitude_snapped: entry.nearest.lat,
          longitude_snapped: entry.nearest.lon,
        };
      }
      const reg = captureRegistryRef.current;
      reg.set(propsData.id, propsData);
      const path = new PathStore(reg);
      path.reset(propsData);
      path.extend(PRELOAD_RADIUS + 1);
      pathStoreRef.current = path;

      setSelectedImageId(propsData.id);
      setSelectedImageData(propsData);
      setViewerEverOpened(true);
      setShowViewer(true);
    },
    [fetchFeatureById]
  );

  const handlePrevImage = useCallback(() => stepToImage(-1), [stepToImage]);

  // Process shared link from URL parameters on mount
  useEffect(() => {
    if (hasProcessedSharedLink.current) return;

    const imageId = searchParams.get("id");
    const yaw = searchParams.get("yaw");
    const pitch = searchParams.get("pitch");
    const hfov = searchParams.get("hfov");

    if (imageId) {
      hasProcessedSharedLink.current = true;

      // Store the view state to apply after image loads
      if (yaw !== null || pitch !== null || hfov !== null) {
        setSharedViewState({
          yaw: yaw ? parseFloat(yaw) : undefined,
          pitch: pitch ? parseFloat(pitch) : undefined,
          hfov: hfov ? parseFloat(hfov) : undefined,
        });
      }

      // Fetch and display the shared image
      fetchFeatureById(imageId).then((featureData) => {
        if (featureData) {
          const props = featureData.properties;
          const reg = captureRegistryRef.current;
          reg.set(props.id || imageId, props);
          const path = new PathStore(reg);
          path.reset(props);
          path.extend(PRELOAD_RADIUS + 1);
          pathStoreRef.current = path;

          setSelectedImageId(imageId);
          setSelectedImageData(props);
          setViewerEverOpened(true);
          setShowViewer(true);
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Apply shared view state to pannellum when it's ready
  useEffect(() => {
    if (sharedViewState && pannellumInstanceRef.current && showViewer) {
      const timer = setTimeout(() => {
        if (pannellumInstanceRef.current) {
          if (sharedViewState.yaw !== undefined) {
            pannellumInstanceRef.current.setYaw(sharedViewState.yaw);
          }
          if (sharedViewState.pitch !== undefined) {
            pannellumInstanceRef.current.setPitch(sharedViewState.pitch);
          }
          if (sharedViewState.hfov !== undefined) {
            pannellumInstanceRef.current.setHfov(sharedViewState.hfov);
          }
          // Mark that we've initialized the view
          hasInitializedView.current = true;
          // Clear the shared state after applying
          setSharedViewState(null);
        }
      }, 500); // Small delay to ensure pannellum is fully initialized

      return () => clearTimeout(timer);
    }
  }, [sharedViewState, showViewer]);

  // Create a selected image object in the format expected by ImageViewer
  // Now structured to work with both MBTiles data and API responses
  const selectedImage = selectedImageData
    ? {
        properties: selectedImageData,
        geometry: {
          // Use the API response geometry if available, otherwise construct from properties
          coordinates: selectedImageData.geometry?.coordinates || [
            selectedImageData.longitude_snapped ||
              selectedImageData.longitude_original ||
              0,
            selectedImageData.latitude_snapped ||
              selectedImageData.latitude_original ||
              0,
          ],
          type: "Point",
        },
      }
    : null;

  if (isLoading) {
    return (
      <div className="h-screen flex flex-col bg-slate-100 dark:bg-slate-950 text-slate-900 dark:text-slate-100 overflow-hidden select-none">
        <Header />
        <main className="relative flex-1 w-full overflow-hidden flex items-center justify-center">
          <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-b-2 border-emerald-500"></div>
        </main>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-screen flex flex-col bg-slate-100 dark:bg-slate-950 text-slate-900 dark:text-slate-100 overflow-hidden select-none">
        <Header />
        <main className="relative flex-1 w-full overflow-hidden flex items-center justify-center p-4">
          <div className="text-rose-600 p-4 border border-rose-300 rounded-2xl bg-white/90 dark:bg-slate-900/90 shadow-lg max-w-md">
            <h2 className="text-lg font-semibold mb-2">Error loading data</h2>
            <p>{error}</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-slate-100 dark:bg-slate-950 text-slate-900 dark:text-slate-100 overflow-hidden select-none">
      <Header />

      {/* Map canvas — full bleed under the floating glass panels */}
      <main className="relative flex-1 w-full overflow-hidden">
        <div className="absolute inset-0 z-0">
          <MapComponent
            imageData={mapFocus || { features: [] }} // Panorama data comes from MBTiles; a focus feature re-centers the map
            selectedImageId={selectedImageId}
            selectedImageData={selectedImageData} // Pass selectedImageData to MapComponent
            onImageSelect={handleImageSelect}
            refreshData={refreshData}
            isLoading={isLoading}
            selectedImage={selectedImage}
            fullBleed={true}
          />
        </div>

        {/* The viewer stays mounted after its first open (hidden, not
            unmounted) so the WebGL engine and its decoded-texture cache
            survive close/reopen — reopening a pano is then instantaneous. */}
        <div className={showViewer ? "contents" : "hidden"}>
          {viewerEverOpened && selectedImage && (
            <ImageViewer
              selectedImage={selectedImage}
              images={[]} // No longer using array of images - navigation handled by direct track/image manipulation
              onPrevImage={handlePrevImage}
              onNextImage={handleNextImage}
              onClose={handleCloseViewer}
              onImageSelect={handleImageSelect}
              active={showViewer}
              isLoadingFeature={isLoadingFeature}
              pannellumInstanceRef={pannellumInstanceRef}
              sharedViewState={sharedViewState} // Pass shared view state to ImageViewer
              onExitToLocation={handleExitToLocation}
              onTimelineSelect={handleTimelineSelect}
            />
          )}
        </div>
      </main>
    </div>
  );
}

export default function Home() {
  return (
    <Suspense
      fallback={
        <div className="h-screen flex items-center justify-center bg-slate-100 dark:bg-slate-950">
          <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-b-2 border-emerald-500"></div>
        </div>
      }
    >
      <HomeContent />
    </Suspense>
  );
}
