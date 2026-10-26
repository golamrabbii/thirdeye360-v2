"use client";

import React, { useRef, useState, useEffect, useCallback } from "react";
import { useDispatch, useSelector } from "react-redux";
import {
  toggleControlsVisibility,
  selectShowControls,
} from "../../redux/slices/uiControlsSlice";
import PannellumViewer from "./pannellum/PannellumViewer";
import ViewerHeader from "./ViewerHeader";
import TimelineStrip from "./TimelineStrip";
import { fetchTimeline } from "../../utils/timeline";
import MapComponent from "../map/MapComponent";
import ShareModal from "./ShareModal";
import "../../styles/pannellum-hotspots.css";
import toast from "react-hot-toast";
import {
  PiPlusBold,
  PiMinusBold,
  PiCornersOutBold,
  PiCornersInBold,
  PiEyeBold,
  PiEyeSlashBold,
  PiArrowsOutSimpleBold,
  PiMapTrifoldBold,
} from "react-icons/pi";

// Must match the min/max hfov configured on the pannellum viewer
const MIN_HFOV = 50;
const MAX_HFOV = 120;

// Resolve display coordinates for an image (snapped position when available)
const getSelectedImageCoords = (image) => {
  if (!image) return null;
  const properties = image.properties || {};
  const useSnapped =
    properties.longitude_snapped !== undefined &&
    properties.latitude_snapped !== undefined;

  const longitude = useSnapped
    ? properties.longitude_snapped
    : image.geometry?.coordinates?.[0];
  const latitude = useSnapped
    ? properties.latitude_snapped
    : image.geometry?.coordinates?.[1];

  if (longitude === undefined || latitude === undefined) return null;
  return { longitude, latitude };
};

// Format a capture date for the HUD (null when missing/invalid)
const formatCaptureDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
};

const ImageViewer = ({
  selectedImage,
  images = [], // Default to empty array
  onPrevImage,
  onNextImage,
  onClose,
  pathData,
  onImageSelect,
  onTimelineSelect, // (timeline entry) => jump to that date's nearest frame
  active = true, // false while the viewer is kept mounted but hidden
  isLoadingFeature = false, // Add prop to indicate API loading state
  pannellumInstanceRef, // New prop to get pannellum instance
  sharedViewState, // Add sharedViewState prop
  onExitToLocation, // Optional: exit the viewer and fly the overview map to a location
}) => {
  const [showMiniMap, setShowMiniMap] = useState(true); // Default to shown
  const [miniMapExpanded, setMiniMapExpanded] = useState(false);
  // Add state to track the minimap center position
  const [miniMapViewState, setMiniMapViewState] = useState({
    longitude: selectedImage?.geometry?.coordinates[0] || 0,
    latitude: selectedImage?.geometry?.coordinates[1] || 0,
    zoom: 14,
  });
  const showControls = useSelector(selectShowControls); // Get UI controls visibility state from Redux
  const dispatch = useDispatch();
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [shareUrl, setShareUrl] = useState("");
  const viewerRootRef = useRef(null); // Fullscreen target for the HUD
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [viewerYaw, setViewerYaw] = useState(0); // Live yaw for the compass
  // Timeline (Street View-style date strip)
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [timelineDates, setTimelineDates] = useState([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState("");

  const properties = selectedImage?.properties || {};
  const currentImageId = properties?.id || null;
  const captureDate = formatCaptureDate(properties.capture_date);
  const activeDay = (() => {
    const d = new Date(properties.capture_date);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  })();

  // Timeline open/toggle — fetching is handled by the effect below, which
  // always describes the frame currently on screen.
  const openTimeline = () => {
    setTimelineOpen((v) => !v);
  };

  // Timeline always describes the frame on screen: refetch the capture dates
  // whenever the frame changes while the strip is open — never show the
  // previous frame's dates on a new image.
  useEffect(() => {
    if (!timelineOpen || !currentImageId) return;
    const lat = properties.latitude_snapped ?? properties.latitude_original;
    const lng = properties.longitude_snapped ?? properties.longitude_original;
    if (lat == null || lng == null) return;
    let cancelled = false;
    setTimelineLoading(true);
    fetchTimeline(lat, lng, 25)
      .then((dates) => {
        if (cancelled) return;
        setTimelineDates(dates);
        setTimelineError("");
      })
      .catch(() => {
        if (cancelled) return;
        setTimelineError("Could not load capture dates.");
        setTimelineDates([]);
      })
      .finally(() => {
        if (!cancelled) setTimelineLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentImageId, timelineOpen]);

  // Toggle mini-map visibility
  const toggleMiniMap = () => {
    setShowMiniMap((prev) => !prev);
  };

  // Toggle HUD visibility (redux driven)
  const handleToggleControls = () => {
    dispatch(toggleControlsVisibility());
  };

  // Share functionality - Updated to use custom modal
  const handleShare = useCallback(async () => {
    if (!selectedImage) {
      toast.error("No image selected to share");
      return;
    }

    try {
      // Get current view state from pannellum instance if available
      let viewState = {};
      if (pannellumInstanceRef?.current) {
        viewState = {
          yaw: pannellumInstanceRef.current.getYaw(),
          pitch: pannellumInstanceRef.current.getPitch(),
          hfov: pannellumInstanceRef.current.getHfov(),
        };
      }

      // Build the shareable URL
      const baseUrl = window.location.origin;
      const imageId =
        selectedImage.properties.id || selectedImage.properties.id;

      const params = new URLSearchParams({
        id: imageId,
        ...(viewState.yaw !== undefined && { yaw: viewState.yaw.toFixed(2) }),
        ...(viewState.pitch !== undefined && {
          pitch: viewState.pitch.toFixed(2),
        }),
        ...(viewState.hfov !== undefined && {
          hfov: viewState.hfov.toFixed(2),
        }),
      });

      const generatedShareUrl = `${baseUrl}?${params.toString()}`;

      // Set the share URL and open the modal
      setShareUrl(generatedShareUrl);
      setIsShareModalOpen(true);
    } catch (error) {
      console.error("Error generating share link:", error);
      toast.error("Failed to generate share link. Please try again.");
    }
  }, [selectedImage, pannellumInstanceRef]);


  // Update minimap position when selected image changes
  useEffect(() => {
    const coords = getSelectedImageCoords(selectedImage);
    if (selectedImage && coords) {
      // TEMP DEBUG (mini-map jump) — remove after diagnosis
      console.log(
        '[MINIMAP-DBG] setMiniMapViewState',
        selectedImage.properties.id,
        coords.longitude,
        coords.latitude
      );
      // Update the minimap view state to center on the selected image
      setMiniMapViewState({
        longitude: coords.longitude,
        latitude: coords.latitude,
        zoom: 15, // A good zoom level for the minimap
        transitionDuration: 500, // Smooth animation
        transitionInterpolator: {
          around: [coords.longitude, coords.latitude],
        },
      });
    }
  }, [selectedImage?.properties?.id]); // Using id to ensure we respond to all image changes

  // Poll the live pannellum yaw for the HUD compass (quantized to 0.5° steps
  // so the HUD only re-renders when the heading actually changes)
  useEffect(() => {
    const interval = setInterval(() => {
      const instance = pannellumInstanceRef?.current;
      if (instance && typeof instance.getYaw === "function") {
        try {
          const yaw = Math.round(instance.getYaw() * 2) / 2;
          setViewerYaw((prev) => (prev === yaw ? prev : yaw));
        } catch (error) {
          // Viewer not ready yet, keep the last heading
        }
      }
    }, 120);

    return () => clearInterval(interval);
  }, [pannellumInstanceRef]);

  // Track fullscreen state (Fullscreen API on the viewer root)
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  const toggleFullscreen = () => {
    const element = viewerRootRef.current;
    if (!element) return;

    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch((error) => {
        console.error("Error exiting fullscreen:", error);
      });
    } else if (element.requestFullscreen) {
      element.requestFullscreen().catch((error) => {
        console.error("Error entering fullscreen:", error);
      });
    }
  };

  // Zoom helpers (hfov based, clamped to the viewer limits)
  const zoomBy = (delta) => {
    const instance = pannellumInstanceRef?.current;
    if (!instance || typeof instance.getHfov !== "function") return;

    try {
      const next = Math.min(
        MAX_HFOV,
        Math.max(MIN_HFOV, instance.getHfov() + delta)
      );
      instance.setHfov(next);
    } catch (error) {
      console.error("Error changing zoom:", error);
    }
  };

  // Reset the view to the initial yaw/pitch/hfov of the current image
  const resetView = () => {
    const instance = pannellumInstanceRef?.current;
    if (!instance) return;

    try {
      instance.setYaw(properties.initialYaw || 0);
      instance.setPitch(properties.initialPitch || 0);
      instance.setHfov(properties.initialHfov || 100);
    } catch (error) {
      console.error("Error resetting view:", error);
    }
  };

  // Escape closes the viewer
  useEffect(() => {
    if (!selectedImage) return undefined;
    const handleEscape = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [selectedImage, onClose]);

  // Live compass heading (0-360) and needle rotation
  const compassHeading = Math.round(((viewerYaw % 360) + 360) % 360);
  const needleRotation = -((((viewerYaw % 360) + 540) % 360) - 180);

  // Display strings for the header card and minimap radar
  const displayTitle = properties.address
    ? properties.address
    : `360° Image ${properties.id ?? ""}`.trim();
  const displayCoords = getSelectedImageCoords(selectedImage);

  return (
    <div
      ref={viewerRootRef}
      className='fixed inset-0 z-50 select-none bg-black'
    >
      <div className='relative h-full w-full overflow-hidden'>
        <PannellumViewer
          selectedImage={selectedImage}
          images={images}
          onPrevImage={onPrevImage}
          onNextImage={onNextImage}
          active={active}
          showControls={showControls}
          isLoading={isLoadingFeature}
          pannellumInstanceRef={pannellumInstanceRef}
          sharedViewState={sharedViewState} // Pass shared view state to PannellumViewer
        />
        {timelineOpen && (
          <TimelineStrip
            dates={timelineDates}
            loading={timelineLoading}
            error={timelineError}
            activeDate={activeDay}
            onSelect={(entry) => onTimelineSelect?.(entry)}
            onBackToLatest={(entry) => onTimelineSelect?.(entry)}
            onClose={() => setTimelineOpen(false)}
          />
        )}

        {/* Loading overlay - Only show when fetching next/prev image */}
        {isLoadingFeature && (
          <div className='absolute inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-md'>
            <div className='flex w-64 flex-col items-center gap-5'>
              {/* Spinner ring with pulsing core */}
              <div className='relative h-14 w-14'>
                <div className='absolute inset-0 rounded-full border border-white/10' />
                <div className='absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-brand-400 [animation-duration:0.9s]' />
                <div className='absolute inset-0 flex items-center justify-center'>
                  <div className='h-1.5 w-1.5 animate-pulse rounded-full bg-brand-400' />
                </div>
              </div>
              {/* Status */}
              <div className='text-center'>
                <p className='text-sm font-semibold tracking-wide text-white'>
                  Loading panorama
                </p>
                <p className='mt-1 text-[11px] font-medium tracking-wide text-white/50'>
                  ThirdEye360 · fetching imagery
                </p>
              </div>
              {/* Indeterminate progress bar */}
              <div className='h-[3px] w-48 overflow-hidden rounded-full bg-white/10'>
                <div className='h-full w-1/3 animate-shimmer rounded-full bg-gradient-to-r from-transparent via-brand-400 to-transparent' />
              </div>
            </div>
          </div>
        )}

        {showControls && (
          <ViewerHeader
            selectedImage={selectedImage}
            onClose={onClose}
            onShare={handleShare}
            onExitToLocation={onExitToLocation}
            onOpenTimeline={openTimeline}
          />
        )}

        {showControls && (
          <>
            {/* Floating mini-map radar */}
            {showMiniMap && (
              <div
                className={`absolute bottom-20 left-3 z-20 transition-all duration-300 sm:left-6 ${
                  miniMapExpanded ? "w-40 sm:w-96" : "w-40 sm:w-64"
                }`}
              >
                <div className='glass-dock overflow-hidden rounded-2xl border border-white/25 shadow-floating-dark'>
                  {/* Radar header bar */}
                  <div className='flex items-center justify-between border-b border-white/10 bg-slate-900/95 px-3 py-2'>
                    <div className='flex min-w-0 items-center gap-2'>
                      <span className='h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-400'></span>
                      <span
                        className='truncate text-xs font-bold tracking-tight text-white'
                        title={displayTitle}
                      >
                        {displayTitle}
                      </span>
                    </div>
                    <div className='flex shrink-0 items-center gap-1'>
                      <button
                        type='button'
                        onClick={() => setMiniMapExpanded((prev) => !prev)}
                        title={
                          miniMapExpanded
                            ? "Collapse mini-map"
                            : "Expand mini-map"
                        }
                        aria-label={
                          miniMapExpanded
                            ? "Collapse mini-map"
                            : "Expand mini-map"
                        }
                        className='rounded p-1 text-slate-400 transition-colors hover:bg-white/10 hover:text-white'
                      >
                        <PiArrowsOutSimpleBold className='text-xs' />
                      </button>
                      <button
                        type='button'
                        onClick={toggleMiniMap}
                        title='Minimize mini-map'
                        aria-label='Minimize mini-map'
                        className='rounded p-1 text-slate-400 transition-colors hover:bg-white/10 hover:text-white'
                      >
                        <PiMinusBold className='text-xs' />
                      </button>
                    </div>
                  </div>

                  {/* Real compact map, centered on the selected image */}
                  <div
                    className={`relative w-full overflow-hidden bg-slate-950 ${
                      miniMapExpanded ? "h-72" : "h-48"
                    }`}
                  >
                    <MapComponent
                      imageData={{ features: images }}
                      pathData={pathData}
                      selectedImageId={selectedImage.properties.id}
                      onImageSelect={onImageSelect}
                      isCompact={true}
                      fullBleed={true}
                      initialViewState={miniMapViewState} // Center on selected point
                      followTarget={{
                        longitude: properties.longitude_snapped ?? 0,
                        latitude: properties.latitude_snapped ?? 0,
                      }} // Glide to each frame as the user moves along the track
                      selectedImage={selectedImage} // Pass the entire selected image object
                    />
                  </div>

                  {/* Footer strip with live coordinates */}
                  <div className='flex items-center justify-between border-t border-white/10 bg-slate-950 px-2.5 py-1.5 font-mono text-[9px] text-slate-400'>
                    <span className='truncate'>
                      {displayCoords
                        ? `Lat ${displayCoords.latitude.toFixed(
                            5
                          )} • Lng ${displayCoords.longitude.toFixed(5)}`
                        : "Lat — • Lng —"}
                    </span>
                    <span className='font-semibold text-emerald-400'>GPS</span>
                  </div>
                </div>
              </div>
            )}

            {/* Restore button when the mini-map is hidden */}
            {!showMiniMap && (
              <button
                type='button'
                onClick={toggleMiniMap}
                title='Show mini-map'
                aria-label='Show mini-map'
                className='glass-dock pointer-events-auto absolute bottom-20 left-3 z-20 rounded-full p-3 text-slate-300 shadow-floating-dark transition-all hover:scale-110 hover:text-white sm:left-6'
              >
                <PiMapTrifoldBold className='text-xl' />
              </button>
            )}

            {/* Attribution strip */}
            <div className='pointer-events-auto absolute bottom-2 right-4 z-20 hidden select-none items-center gap-2 rounded-md border border-white/10 bg-slate-950/70 px-2.5 py-1 text-[9px] text-slate-400 backdrop-blur-md md:flex'>
              {captureDate && (
                <>
                  <span>Image capture: {captureDate}</span>
                  <span className='text-slate-600'>•</span>
                </>
              )}
              <span>© ThirdEye360 / Barikoi</span>
              <span className='text-slate-600'>•</span>
              <button
                type='button'
                onClick={() => toast("Terms of service coming soon")}
                className='underline transition-colors hover:text-slate-200'
              >
                Terms
              </button>
              <span className='text-slate-600'>•</span>
              <button
                type='button'
                onClick={() => toast("Privacy policy coming soon")}
                className='underline transition-colors hover:text-slate-200'
              >
                Privacy
              </button>
              <span className='text-slate-600'>•</span>
              <a
                href={`mailto:info@barikoi.com?subject=${encodeURIComponent(
                  `ThirdEye360 issue - Image ${properties.id ?? ""}`
                )}`}
                className='underline transition-colors hover:text-rose-400'
              >
                Report an issue
              </a>
            </div>
          </>
        )}

        {/* Right camera & spatial control stack (always available so the HUD can be
            restored). PannellumViewer renders its HD/POI dock directly above this
            stack at bottom-[17rem] - keep the two positions in sync. */}
        <aside
          aria-label='Camera and spatial controls'
          className='pointer-events-auto absolute bottom-24 right-4 z-30 md:right-6'
        >
          <div className='glass-dock flex flex-col space-y-1 rounded-2xl border border-white/20 p-1 shadow-floating-dark'>
            {/* Live compass - click to reset the view */}
            <button
              type='button'
              onClick={resetView}
              title={`Reset view (heading ${compassHeading}°)`}
              aria-label='Reset view'
              className='group flex h-9 w-9 items-center justify-center rounded-xl text-slate-300 transition-all hover:bg-white/10 hover:text-emerald-400 active:scale-95'
            >
              <div
                className='relative flex h-6 w-6 items-center justify-center'
                style={{ transform: `rotate(${needleRotation}deg)` }}
              >
                <div className='h-4 w-0.5 rounded-full bg-slate-600'></div>
                <div className='absolute top-1 h-0 w-0 border-b-[9px] border-l-[3.5px] border-l-transparent border-r-[3.5px] border-r-transparent border-b-rose-500'></div>
                <div className='absolute bottom-1 h-0 w-0 border-t-[9px] border-l-[3.5px] border-l-transparent border-r-[3.5px] border-r-transparent border-t-white'></div>
              </div>
            </button>

            <div className='mx-1.5 h-px bg-white/10'></div>

            <button
              type='button'
              onClick={() => zoomBy(-10)}
              title='Zoom in'
              aria-label='Zoom in'
              className='flex h-9 w-9 items-center justify-center rounded-xl text-slate-300 transition-all hover:bg-white/10 hover:text-white active:scale-95'
            >
              <PiPlusBold className='text-sm' />
            </button>
            <button
              type='button'
              onClick={() => zoomBy(10)}
              title='Zoom out'
              aria-label='Zoom out'
              className='flex h-9 w-9 items-center justify-center rounded-xl text-slate-300 transition-all hover:bg-white/10 hover:text-white active:scale-95'
            >
              <PiMinusBold className='text-sm' />
            </button>

            <div className='mx-1.5 h-px bg-white/10'></div>

            <button
              type='button'
              onClick={toggleFullscreen}
              title={
                isFullscreen ? "Exit fullscreen mode" : "Fullscreen mode"
              }
              aria-label={
                isFullscreen ? "Exit fullscreen mode" : "Fullscreen mode"
              }
              className='flex h-9 w-9 items-center justify-center rounded-xl text-slate-300 transition-all hover:bg-white/10 hover:text-white active:scale-95'
            >
              {isFullscreen ? (
                <PiCornersInBold className='text-base' />
              ) : (
                <PiCornersOutBold className='text-base' />
              )}
            </button>

            <div className='mx-1.5 h-px bg-white/10'></div>

            <button
              type='button'
              onClick={handleToggleControls}
              title={
                showControls ? "Hide UI controls" : "Show UI controls"
              }
              aria-label={
                showControls ? "Hide UI controls" : "Show UI controls"
              }
              className='flex h-9 w-9 items-center justify-center rounded-xl text-slate-300 transition-all hover:bg-white/10 hover:text-white active:scale-95'
            >
              {showControls ? (
                <PiEyeSlashBold className='text-sm' />
              ) : (
                <PiEyeBold className='text-sm' />
              )}
            </button>
          </div>
        </aside>

        {/* Share Modal */}
        <ShareModal
          isOpen={isShareModalOpen}
          onClose={() => setIsShareModalOpen(false)}
          shareUrl={shareUrl}
          imageId={
            selectedImage?.properties?.id || selectedImage?.properties?.id
          }
          pannellumInstanceRef={pannellumInstanceRef}
        />
      </div>
    </div>
  );
};

export default React.memo(ImageViewer, (prevProps, nextProps) => {
  return (
    prevProps.selectedImage === nextProps.selectedImage &&
    prevProps.isLoadingFeature === nextProps.isLoadingFeature &&
    prevProps.sharedViewState === nextProps.sharedViewState &&
    prevProps.onExitToLocation === nextProps.onExitToLocation &&
    prevProps.active === nextProps.active
  );
});
