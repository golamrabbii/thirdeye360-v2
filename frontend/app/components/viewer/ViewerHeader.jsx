"use client";

import React, { useState, useEffect, useRef } from "react";
import toast from "react-hot-toast";
import { copyToClipboard } from "@/app/utils/clipboard";
import {
  PiArrowLeftBold,
  PiMapPinBold,
  PiDotsThreeVerticalBold,
  PiCameraBold,
  PiCaretRightBold,
  PiCopyBold,
  PiLinkBold,
} from "react-icons/pi";


// Format the capture date for the header card (null when missing/invalid)
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

const ViewerHeader = ({
  onClose,
  selectedImage,
  onShare,
  onExitToLocation,
  onOpenTimeline,
}) => {
  const [isOptionsOpen, setIsOptionsOpen] = useState(false);
  const optionsRef = useRef(null);

  const properties = selectedImage?.properties || {};

  // Title: address when available, otherwise a generic image label
  const displayTitle = properties.address
    ? properties.address
    : `360° Image ${properties.id ?? ""}`.trim();

  // Subtitle: area/city when available, otherwise a generic fallback
  const displaySubtitle = [properties.area, properties.city]
    .filter(Boolean)
    .join(", ");
  const subtitleText = displaySubtitle || "Dhaka, Bangladesh";

  const captureDate = formatCaptureDate(properties.capture_date);

  // Resolve the display coordinates (snapped when available, like the minimap)
  const getCoordinates = () => {
    if (!selectedImage) return null;
    const useSnapped =
      properties.latitude_snapped !== undefined &&
      properties.longitude_snapped !== undefined;

    const latitude = useSnapped
      ? properties.latitude_snapped
      : selectedImage.geometry?.coordinates?.[1];
    const longitude = useSnapped
      ? properties.longitude_snapped
      : selectedImage.geometry?.coordinates?.[0];

    if (latitude === undefined || longitude === undefined) return null;
    return { latitude, longitude };
  };

  // Close the options popover on outside clicks
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (optionsRef.current && !optionsRef.current.contains(event.target)) {
        setIsOptionsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  const handleCopyCoordinates = async () => {
    const coords = getCoordinates();
    if (!coords) {
      toast.error("No coordinates available for this image");
      return;
    }

    try {
      await copyToClipboard(`${coords.latitude},${coords.longitude}`);
      toast.success("Coordinates copied to clipboard");
    } catch (error) {
      toast.error("Failed to copy coordinates");
    } finally {
      setIsOptionsOpen(false);
    }
  };

  const handleCopyShareLink = async () => {
    setIsOptionsOpen(false);
    if (!onShare) {
      toast.error("Share link is not available");
      return;
    }
    // handleShare surfaces its own errors via toast
    await onShare();
  };

  return (
    <header className='pointer-events-none absolute inset-x-0 top-0 z-30 flex w-full items-start justify-between gap-3 px-4 pt-3'>
      {/* Location card dock */}
        <div className='pointer-events-auto glass-dock flex w-80 max-w-full flex-col gap-1.5 rounded-2xl border border-white/15 p-3 shadow-floating-dark'>
          <div className='flex items-start justify-between'>
            <div className='flex min-w-0 items-center gap-2.5'>
              <button
                type='button'
                onClick={onClose}
                title='Back to overview map (ESC)'
                aria-label='Back to overview map'
                className='flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-white/10 text-white transition-all hover:bg-emerald-500 hover:text-slate-950'
              >
                <PiArrowLeftBold className='text-xs' />
              </button>
              <div className='min-w-0'>
                <div className='flex items-center gap-1.5'>
                  <h1
                    className='truncate text-xs font-bold leading-none tracking-tight text-white'
                    title={displayTitle}
                  >
                    {displayTitle}
                  </h1>
                  <PiMapPinBold className='shrink-0 text-[11px] text-emerald-400' />
                </div>
                <span className='block truncate text-[10px] font-medium text-slate-400'>
                  {subtitleText}
                </span>
              </div>
            </div>

            {/* More options popover */}
            <div ref={optionsRef} className='relative shrink-0'>
              <button
                type='button'
                onClick={() => setIsOptionsOpen((prev) => !prev)}
                title='More options'
                aria-label='More options'
                className='rounded p-1 text-slate-400 transition-colors hover:text-white'
              >
                <PiDotsThreeVerticalBold className='text-xs' />
              </button>
              {isOptionsOpen && (
                <div className='glass-dock absolute right-0 z-40 mt-1 w-44 overflow-hidden rounded-xl py-1 shadow-floating-dark'>
                  <button
                    type='button'
                    onClick={handleCopyCoordinates}
                    className='flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-slate-200 transition-colors hover:bg-white/10 hover:text-white'
                  >
                    <PiCopyBold className='text-xs text-emerald-400' />
                    Copy coordinates
                  </button>
                  <button
                    type='button'
                    onClick={handleCopyShareLink}
                    className='flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-slate-200 transition-colors hover:bg-white/10 hover:text-white'
                  >
                    <PiLinkBold className='text-xs text-emerald-400' />
                    Copy share link
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className='flex items-center justify-between border-t border-white/10 pt-1 text-[10px]'>
            <div className='flex min-w-0 items-center gap-1.5 text-slate-300'>
              <PiCameraBold className='shrink-0 text-xs text-emerald-400' />
              <span className='min-w-0 truncate font-mono'>
                ThirdEye360{captureDate ? ` • ${captureDate}` : ""}
              </span>
            </div>
            <button
              type='button'
              onClick={onOpenTimeline}
              className='flex shrink-0 items-center gap-0.5 font-medium text-emerald-400 underline underline-offset-2 transition-colors hover:text-emerald-300'
            >
              <span>See timeline</span>
              <PiCaretRightBold className='text-[9px]' />
            </button>
          </div>
        </div>

      {/* Round close button (X rotates on hover) */}
      <div className='pointer-events-auto flex shrink-0 items-center gap-2'>
        <button
          type='button'
          onClick={onClose}
          title='Close street view / Back to Map (ESC)'
          aria-label='Close street view and return to map'
          className='glass-dock group flex cursor-pointer items-center justify-center rounded-full border border-white/20 p-2.5 text-slate-300 shadow-floating-dark transition-all hover:bg-white/15 hover:text-white active:scale-95'
        >
          <svg
            className='h-5 w-5 transition-transform duration-300 group-hover:rotate-90'
            fill='none'
            stroke='currentColor'
            strokeLinecap='round'
            strokeLinejoin='round'
            strokeWidth='2'
            viewBox='0 0 24 24'
          >
            <path d='M18 6L6 18M6 6l12 12' />
          </svg>
        </button>
      </div>
    </header>
  );
};

export default React.memo(ViewerHeader);
