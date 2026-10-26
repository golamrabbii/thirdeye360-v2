'use client';

/**
 * The 360° uploader as a standalone card (dropzone + queue + footer).
 * Used by the dedicated /upload route; Upload360Modal wraps it in a modal
 * overlay for in-app usage.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import toast from 'react-hot-toast';
import { useAuth } from '../../context/AuthContext';
import {
  extractGpsFromFile,
  formatLat,
  formatLng,
} from '../../utils/clientGpsExtractor';
import { apiUrl } from '../../config/api';

const UPLOAD_ENDPOINT = apiUrl('/api/upload');
const ACCEPTED_TYPES = 'image/jpeg,image/png';
const UPLOAD_STAGGER_MS = 400;
const NO_GPS_DELAY_MS = 300;
const PROGRESS_THROTTLE_MS = 120;
const ACTIVE_STATUSES = ['pending', 'extracting', 'no-gps', 'uploading'];
const QUEUED_STATUSES = ['pending', 'extracting', 'no-gps'];

function formatSize(bytes) {
  if (!bytes) return '0 KB';
  const mb = bytes / (1024 * 1024);
  if (mb < 0.1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${mb.toFixed(1)} MB`;
}

function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '--';
  const mbps = bytesPerSecond / (1024 * 1024);
  if (mbps >= 1) return `${mbps.toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(bytesPerSecond / 1024))} KB/s`;
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s remaining`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s remaining`;
}

function isImageFile(file) {
  return (
    file?.type === 'image/jpeg' ||
    file?.type === 'image/png' ||
    /\.(jpe?g|png)$/i.test(file?.name || '')
  );
}

function StatusBadge({ item }) {
  const base = 'px-1.5 py-0.5 rounded text-[10px] font-bold border';
  switch (item.status) {
    case 'uploading':
      return (
        <span className={`${base} bg-amber-50 text-amber-700 border-amber-200`}>
          Uploading {item.progress}%
        </span>
      );
    case 'extracting':
      return (
        <span
          className={`${base} bg-sky-50 text-sky-700 border-sky-200 flex items-center space-x-1`}
        >
          <svg
            className='w-2.5 h-2.5 animate-spin'
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
            />
            <path
              className='opacity-75'
              fill='currentColor'
              d='M4 12a8 8 0 018-8v8H4z'
            />
          </svg>
          <span>Reading EXIF</span>
        </span>
      );
    case 'no-gps':
      return (
        <span
          className={`${base} bg-amber-50 text-amber-700 border-amber-200`}
        >
          No GPS — Uploading Anyway
        </span>
      );
    case 'ready':
      return (
        <span
          className={`${base} bg-emerald-100 text-emerald-800 border-emerald-200`}
        >
          ✓ Ready to Publish
        </span>
      );
    case 'error':
      return (
        <span
          className={`${base} bg-rose-50 text-rose-700 border-rose-200 flex items-center space-x-1`}
        >
          <svg
            className='w-2.5 h-2.5'
            fill='none'
            stroke='currentColor'
            viewBox='0 0 24 24'
            aria-hidden='true'
          >
            <path
              strokeLinecap='round'
              strokeLinejoin='round'
              strokeWidth='2'
              d='M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z'
            />
          </svg>
          <span>Failed</span>
        </span>
      );
    case 'pending':
    default:
      return (
        <span
          className={`${base} bg-slate-100 text-slate-600 border-slate-200`}
        >
          Queued
        </span>
      );
  }
}

function gpsMetaLine(item) {
  if (item.status === 'pending' || item.status === 'extracting') {
    return 'Reading GPS EXIF metadata…';
  }
  if (item.gps) {
    return `GPS Tagged (${formatLat(item.gps.lat)}, ${formatLng(item.gps.lng)})`;
  }
  if (ACTIVE_STATUSES.includes(item.status)) {
    return 'No GPS EXIF — uploading without location';
  }
  return 'No GPS EXIF — uploaded without location';
}

export default function Upload360Panel({ onClose }) {
  const { user } = useAuth();
  const [items, setItems] = useState([]);
  const [isDragging, setIsDragging] = useState(false);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose; // latest-callback mirror for stable listeners

  const xhrsRef = useRef(new Map());
  const timersRef = useRef(new Map());
  const transferStatsRef = useRef(new Map());
  const objectUrlsRef = useRef(new Set());
  const cancelledRef = useRef(new Set());
  const dragDepthRef = useRef(0);
  const idCounterRef = useRef(0);
  const fileInputRef = useRef(null);
  const dialogRef = useRef(null);
  const lastFocusedRef = useRef(null);

  const updateItem = useCallback((id, patch) => {
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...patch } : item))
    );
  }, []);

  const clearTimer = useCallback((id) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const abortXhr = useCallback((id) => {
    const xhr = xhrsRef.current.get(id);
    if (xhr) {
      xhr.onabort = null; // keep our explicit state transition in charge
      xhr.abort();
      xhrsRef.current.delete(id);
    }
    transferStatsRef.current.delete(id);
  }, []);

  const revokeThumb = useCallback((item) => {
    if (item?.thumbUrl && objectUrlsRef.current.has(item.thumbUrl)) {
      URL.revokeObjectURL(item.thumbUrl);
      objectUrlsRef.current.delete(item.thumbUrl);
    }
  }, []);

  // Real multipart upload with XHR so upload.onprogress drives the bar.
  // Takes the item snapshot (never reads mutable state) so retries work.
  const uploadItem = useCallback(
    (item) => {
      const itemId = item.id;
      if (cancelledRef.current.has(itemId)) {
        cancelledRef.current.delete(itemId);
        return;
      }

      const formData = new FormData();
      formData.append('file', item.file, item.name);
      if (item.gps) {
        formData.append('latitude', String(item.gps.lat));
        formData.append('longitude', String(item.gps.lng));
      }
      formData.append('user_id', user?.name || user?.email || 'guest');

      const xhr = new XMLHttpRequest();
      xhrsRef.current.set(itemId, xhr);
      transferStatsRef.current.set(itemId, {
        lastTime: Date.now(),
        lastLoaded: 0,
        speed: null,
        eta: null,
      });
      let lastPaint = 0;

      xhr.open('POST', UPLOAD_ENDPOINT, true);

      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        const now = Date.now();
        const stats = transferStatsRef.current.get(itemId);
        if (stats && now > stats.lastTime) {
          const instant =
            ((event.loaded - stats.lastLoaded) * 1000) / (now - stats.lastTime);
          // Exponential smoothing keeps the MB/s readout from jittering.
          stats.speed = stats.speed
            ? stats.speed * 0.7 + instant * 0.3
            : instant;
          stats.eta =
            stats.speed > 0 ? (event.total - event.loaded) / stats.speed : null;
          stats.lastTime = now;
          stats.lastLoaded = event.loaded;
        }
        const progress = Math.round((event.loaded / event.total) * 100);
        if (now - lastPaint < PROGRESS_THROTTLE_MS && progress < 100) return;
        lastPaint = now;
        updateItem(itemId, {
          status: 'uploading',
          progress,
          error: null,
          speed: stats ? stats.speed : null,
          eta: stats ? stats.eta : null,
        });
      };

      const finish = (patch) => {
        xhrsRef.current.delete(itemId);
        transferStatsRef.current.delete(itemId);
        updateItem(itemId, patch);
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          finish({ status: 'ready', progress: 100, error: null, speed: null, eta: null });
        } else {
          finish({
            status: 'error',
            error:
              xhr.status === 0
                ? 'Network error — could not reach the upload server'
                : `Upload failed (HTTP ${xhr.status})`,
          });
        }
      };
      xhr.onerror = () => {
        finish({
          status: 'error',
          error: 'Network error — could not reach the upload server',
        });
      };
      xhr.ontimeout = () => {
        finish({ status: 'error', error: 'Upload timed out — try again' });
      };
      xhr.onabort = () => {
        // Fallback for aborts we didn't initiate (browser navigation etc.)
        xhrsRef.current.delete(itemId);
        transferStatsRef.current.delete(itemId);
        updateItem(itemId, {
          status: 'error',
          error: 'Upload cancelled',
          speed: null,
          eta: null,
        });
      };

      updateItem(itemId, {
        status: 'uploading',
        progress: 0,
        error: null,
        speed: null,
        eta: null,
      });
      xhr.send(formData);
    },
    [updateItem, user]
  );

  // EXIF GPS extraction pass, then auto-upload.
  const processItem = useCallback(
    async (item) => {
      const itemId = item.id;
      clearTimer(itemId);
      if (cancelledRef.current.has(itemId)) {
        cancelledRef.current.delete(itemId);
        return;
      }

      updateItem(itemId, { status: 'extracting', progress: 0 });
      let gps = null;
      try {
        gps = await extractGpsFromFile(item.file);
      } catch (error) {
        gps = null;
      }
      if (cancelledRef.current.has(itemId)) {
        cancelledRef.current.delete(itemId);
        return;
      }

      if (gps) {
        const tagged = { ...item, gps };
        updateItem(itemId, { gps });
        uploadItem(tagged);
      } else {
        // No GPS found — surface the badge briefly, then upload anyway.
        updateItem(itemId, { gps: null, status: 'no-gps' });
        const timer = setTimeout(() => uploadItem(item), NO_GPS_DELAY_MS);
        timersRef.current.set(itemId, timer);
      }
    },
    [clearTimer, updateItem, uploadItem]
  );

  const addFiles = useCallback(
    (fileList) => {
      const incoming = Array.from(fileList || []);
      if (!incoming.length) return;
      const files = incoming.filter(isImageFile);
      const rejected = incoming.length - files.length;
      if (rejected > 0) {
        toast.error(
          `${rejected} non-image file${rejected === 1 ? '' : 's'} skipped — only JPG / PNG panoramas are supported.`
        );
      }
      if (!files.length) return;

      const newItems = files.map((file) => {
        idCounterRef.current += 1;
        const thumbUrl = URL.createObjectURL(file);
        objectUrlsRef.current.add(thumbUrl);
        return {
          id: idCounterRef.current,
          file,
          name: file.name,
          size: file.size,
          thumbUrl,
          status: 'pending',
          progress: 0,
          error: null,
          gps: null,
          speed: null,
          eta: null,
        };
      });

      setItems((prev) => [...prev, ...newItems]);
      newItems.forEach((item, index) => {
        const timer = setTimeout(
          () => processItem(item),
          index * UPLOAD_STAGGER_MS + 100
        );
        timersRef.current.set(item.id, timer);
      });
    },
    [processItem]
  );

  const removeItem = useCallback(
    (id) => {
      cancelledRef.current.add(id);
      clearTimer(id);
      abortXhr(id);
      setItems((prev) => {
        const target = prev.find((entry) => entry.id === id);
        revokeThumb(target);
        return prev.filter((entry) => entry.id !== id);
      });
    },
    [abortXhr, clearTimer, revokeThumb]
  );

  const cancelItem = useCallback(
    (id) => {
      cancelledRef.current.add(id);
      clearTimer(id);
      abortXhr(id);
      updateItem(id, {
        status: 'error',
        error: 'Upload cancelled',
        speed: null,
        eta: null,
      });
    },
    [abortXhr, clearTimer, updateItem]
  );

  const retryItem = useCallback(
    (item) => {
      cancelledRef.current.delete(item.id);
      clearTimer(item.id);
      transferStatsRef.current.delete(item.id);
      uploadItem(item);
    },
    [clearTimer, uploadItem]
  );

  const clearQueue = useCallback(() => {
    xhrsRef.current.forEach((xhr) => {
      xhr.onabort = null;
      xhr.abort();
    });
    xhrsRef.current.clear();
    timersRef.current.forEach((timer) => clearTimeout(timer));
    timersRef.current.clear();
    transferStatsRef.current.clear();
    objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    objectUrlsRef.current.clear();
    cancelledRef.current.clear();
    dragDepthRef.current = 0;
    setIsDragging(false);
    setItems([]);
  }, []);

  // Unmount safety net.
  useEffect(
    () => () => {
      xhrsRef.current.forEach((xhr) => {
        xhr.onabort = null;
        xhr.abort();
      });
      timersRef.current.forEach((timer) => clearTimeout(timer));
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      objectUrlsRef.current.clear();
    },
    []
  );

  // Escape closes and focus is trapped inside the dialog (only when the
  // host provides an onClose — the standalone page omits it).
  useEffect(() => {
    if (!onClose) return undefined;
    lastFocusedRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialogRef.current?.focus();

    const keepFocusInside = (event) => {
      const container = dialogRef.current;
      if (!container) return;
      const focusables = Array.from(
        container.querySelectorAll(
          'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !container.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        onCloseRef.current();
      } else if (event.key === 'Tab') {
        keepFocusInside(event);
      }
    };

    const preventStrayDrop = (event) => event.preventDefault();

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('dragover', preventStrayDrop);
    document.addEventListener('drop', preventStrayDrop);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('dragover', preventStrayDrop);
      document.removeEventListener('drop', preventStrayDrop);
      const el = lastFocusedRef.current;
      if (el && el.isConnected) el.focus();
    };
  }, [onClose]);

  const activeCount = items.filter((item) =>
    ACTIVE_STATUSES.includes(item.status)
  ).length;
  const uploadingCount = items.filter(
    (item) => item.status === 'uploading'
  ).length;
  const queuedCount = items.filter((item) =>
    QUEUED_STATUSES.includes(item.status)
  ).length;
  const errorCount = items.filter((item) => item.status === 'error').length;
  const readyCount = items.filter((item) => item.status === 'ready').length;
  const totalBytes = items.reduce((sum, item) => sum + item.size, 0);
  // Publishable once at least one file is ready, or every file reached a
  // terminal state (ready | error) so the user gets a definitive outcome.
  const canPublish =
    readyCount > 0 || (items.length > 0 && activeCount === 0);

  const badgeParts = [
    uploadingCount > 0 && `${uploadingCount} Uploading`,
    queuedCount > 0 && `${queuedCount} Processing`,
    readyCount > 0 && `${readyCount} Ready`,
  ].filter(Boolean);

  const handlePublish = () => {
    if (!canPublish) return;
    if (readyCount > 0) {
      toast.success(
        `Published ${readyCount} of ${items.length} panorama image${
          items.length === 1 ? '' : 's'
        } to the 360° map`
      );
      clearQueue();
      if (onClose) onClose();
    } else {
      toast.error(
        `Nothing published — ${errorCount} upload${
          errorCount === 1 ? '' : 's'
        } failed. Retry or cancel before leaving.`
      );
    }
  };

  return (
    <div
      ref={dialogRef}
      role='dialog'
      aria-labelledby='upload-360-title'
      tabIndex={-1}
      className='relative w-full bg-white/90 dark:bg-slate-900/90 backdrop-blur-2xl rounded-3xl shadow-2xl border border-white/80 dark:border-white/10 overflow-hidden flex flex-col scale-in outline-none'
    >
        {/* Header */}
        <div className='px-6 py-5 border-b border-slate-200/80 dark:border-white/10 flex items-start justify-between bg-white/50 dark:bg-white/5 backdrop-blur-sm'>
          <div className='flex items-start space-x-3.5'>
            <div className='w-11 h-11 rounded-2xl bg-gradient-to-tr from-emerald-600 via-teal-600 to-emerald-400 flex items-center justify-center text-white shadow-lg shadow-emerald-500/25 border border-white/40 flex-shrink-0 mt-0.5'>
              <svg
                className='w-6 h-6 drop-shadow-sm'
                fill='none'
                stroke='currentColor'
                viewBox='0 0 24 24'
                aria-hidden='true'
              >
                <path
                  d='M15 12a3 3 0 11-6 0 3 3 0 016 0z'
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  strokeWidth='2'
                />
                <path
                  d='M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z'
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  strokeWidth='2'
                />
              </svg>
            </div>
            <div>
              <div className='flex items-center space-x-2'>
                <h3
                  id='upload-360-title'
                  className='text-base font-extrabold text-slate-900 dark:text-white tracking-tight'
                >
                  Upload 360° Panoramic Imagery
                </h3>
                <span className='px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase tracking-wider bg-emerald-100 text-emerald-800 border border-emerald-200'>
                  Batch V2
                </span>
              </div>
              <p className='text-xs text-slate-500 dark:text-slate-400 mt-1 leading-relaxed'>
                Add spherical equirectangular images (JPG/PNG/EXIF metadata) to
                the Dhaka street coverage network
              </p>
            </div>
          </div>
          {onClose && (
          <button
            type='button'
            onClick={onClose}
            aria-label='Close upload dialog'
            className='w-8 h-8 rounded-xl flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors'
          >
            <svg
              className='w-5 h-5'
              fill='none'
              stroke='currentColor'
              viewBox='0 0 24 24'
              aria-hidden='true'
            >
              <path
                strokeLinecap='round'
                strokeLinejoin='round'
                strokeWidth='2'
                d='M6 18L18 6M6 6l12 12'
              />
            </svg>
          </button>
          )}
        </div>

        {/* Scrollable body */}
        <div className='p-6 overflow-y-auto space-y-5'>
          {/* Drag & Drop Zone */}
          <div
            role='button'
            tabIndex={0}
            aria-label='Drag and drop 360° panoramic frames here, or browse files'
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            onDragEnter={(e) => {
              e.preventDefault();
              dragDepthRef.current += 1;
              setIsDragging(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
              if (dragDepthRef.current === 0) setIsDragging(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              dragDepthRef.current = 0;
              setIsDragging(false);
              addFiles(e.dataTransfer?.files);
            }}
            className={`relative group border-2 border-dashed transition-all rounded-2xl p-6 text-center cursor-pointer flex flex-col items-center justify-center outline-none ${
              isDragging
                ? 'border-emerald-500 bg-emerald-50/70 scale-[1.01] shadow-inner'
                : 'border-emerald-400/80 hover:border-emerald-500 bg-emerald-50/40 hover:bg-emerald-50/70'
            }`}
          >
            <input
              ref={fileInputRef}
              type='file'
              multiple
              accept={ACCEPTED_TYPES}
              className='hidden'
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <div className='w-12 h-12 rounded-2xl bg-white shadow-sm border border-emerald-200/80 flex items-center justify-center text-emerald-600 mb-3 group-hover:scale-105 transition-transform'>
              <svg
                className='w-6 h-6'
                fill='none'
                stroke='currentColor'
                viewBox='0 0 24 24'
                aria-hidden='true'
              >
                <path
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  strokeWidth='2'
                  d='M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12'
                />
              </svg>
            </div>
            <p className='text-sm font-bold text-slate-800 dark:text-slate-100'>
              Drag &amp; drop 360° panoramic frames here, or{' '}
              <span className='text-emerald-600 group-hover:underline'>
                Browse Files
              </span>
            </p>
            <div className='flex flex-wrap items-center justify-center gap-1.5 mt-2.5'>
              <span className='text-[11px] font-medium text-slate-500 dark:text-slate-400'>
                Supports 8K/5.7K Equirectangular
              </span>
              <span className='text-slate-300'>•</span>
              <span className='text-[11px] font-medium text-slate-500 dark:text-slate-400'>
                GPS EXIF auto-sync
              </span>
              <span className='text-slate-300'>•</span>
              <span className='text-[11px] font-medium text-emerald-700 font-semibold bg-emerald-100/70 px-2 py-0.5 rounded-md'>
                Insta360 / Ricoh Theta / GoPro MAX
              </span>
            </div>
          </div>

          {/* Active Queue */}
          <div className='space-y-3'>
            <div className='flex items-center justify-between'>
              <span className='text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300'>
                Active Queue &amp; Calibration Status
              </span>
              {badgeParts.length > 0 && (
                <span className='text-xs font-semibold text-emerald-700 bg-emerald-50 px-2.5 py-0.5 rounded-full border border-emerald-200/70'>
                  {badgeParts.join(' • ')}
                </span>
              )}
            </div>

            {items.length === 0 && (
              <div className='p-6 rounded-2xl bg-white/70 dark:bg-slate-800/50 border border-slate-200/90 dark:border-white/10 text-center text-xs font-medium text-slate-400'>
                No files in the queue yet — add panoramic frames above to begin.
              </div>
            )}

            <div aria-live='polite' className='space-y-3'>
              {items.map((item) => {
                const isActive = ACTIVE_STATUSES.includes(item.status);
                const uploadedBytes = Math.round(
                  (item.size * item.progress) / 100
                );
                return (
                  <div
                    key={item.id}
                    className={`p-3.5 rounded-2xl bg-white dark:bg-slate-800/70 border shadow-sm flex flex-col space-y-3 ${
                      item.status === 'ready'
                        ? 'border-emerald-200/80 dark:border-emerald-500/30'
                        : item.status === 'error'
                        ? 'border-rose-200/90 dark:border-rose-500/30'
                        : 'border-slate-200/90 dark:border-white/10'
                    }`}
                  >
                    <div className='flex items-center justify-between gap-3'>
                      <div className='flex items-center space-x-3 min-w-0'>
                        {/* Thumbnail */}
                        <div
                          className={`relative w-12 h-12 rounded-xl overflow-hidden bg-slate-800 flex-shrink-0 border ${
                            item.status === 'ready'
                              ? 'border-emerald-300'
                              : 'border-slate-200 dark:border-white/10'
                          }`}
                        >
                          {item.thumbUrl && (
                            <img
                              alt={item.name}
                              className='w-full h-full object-cover brightness-95'
                              src={item.thumbUrl}
                            />
                          )}
                          <span
                            className={`absolute bottom-0.5 right-0.5 px-1 text-[9px] font-extrabold rounded ${
                              item.status === 'ready'
                                ? 'bg-emerald-700 text-white'
                                : 'bg-black/70 text-emerald-400'
                            }`}
                          >
                            {item.status === 'ready' ? 'READY' : '360°'}
                          </span>
                        </div>
                        {/* Name + status */}
                        <div className='text-left min-w-0'>
                          <div className='flex items-center space-x-2 flex-wrap gap-y-1'>
                            <h5
                              className='text-xs font-bold text-slate-900 dark:text-slate-100 truncate max-w-[14rem]'
                              title={item.name}
                            >
                              {item.name}
                            </h5>
                            <StatusBadge item={item} />
                          </div>
                          <p className='text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 font-mono truncate max-w-[20rem]'>
                            {formatSize(item.size)} • {gpsMetaLine(item)}
                          </p>
                          {item.status === 'error' && item.error && (
                            <div className='flex items-center space-x-2 mt-1'>
                              <span className='text-[11px] font-semibold text-rose-600 dark:text-rose-400'>
                                {item.error}
                              </span>
                              <button
                                type='button'
                                onClick={() => retryItem(item)}
                                className='text-[11px] font-bold text-emerald-700 hover:text-emerald-800 hover:underline'
                              >
                                Retry
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                      {/* Per-file actions */}
                      <div className='flex items-center space-x-2 flex-shrink-0'>
                        {isActive && (
                          <button
                            type='button'
                            onClick={() => cancelItem(item.id)}
                            aria-label={`Cancel upload of ${item.name}`}
                            title='Cancel upload'
                            className='p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700'
                          >
                            <svg
                              className='w-4 h-4'
                              fill='none'
                              stroke='currentColor'
                              viewBox='0 0 24 24'
                              aria-hidden='true'
                            >
                              <path
                                strokeLinecap='round'
                                strokeLinejoin='round'
                                strokeWidth='2'
                                d='M10 9v6m4-6v6M7 4h10a2 2 0 012 2v12a2 2 0 01-2 2H7a2 2 0 01-2-2V6a2 2 0 012-2z'
                              />
                            </svg>
                          </button>
                        )}
                        {item.status === 'error' && (
                          <button
                            type='button'
                            onClick={() => retryItem(item)}
                            aria-label={`Retry upload of ${item.name}`}
                            title='Retry upload'
                            className='p-1.5 rounded-lg text-slate-400 hover:text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-500/10'
                          >
                            <svg
                              className='w-4 h-4'
                              fill='none'
                              stroke='currentColor'
                              viewBox='0 0 24 24'
                              aria-hidden='true'
                            >
                              <path
                                strokeLinecap='round'
                                strokeLinejoin='round'
                                strokeWidth='2'
                                d='M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15'
                              />
                            </svg>
                          </button>
                        )}
                        <button
                          type='button'
                          onClick={() => removeItem(item.id)}
                          aria-label={`Remove ${item.name} from queue`}
                          title='Remove from queue'
                          className='p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10'
                        >
                          <svg
                            className='w-4 h-4'
                            fill='none'
                            stroke='currentColor'
                            viewBox='0 0 24 24'
                            aria-hidden='true'
                          >
                            <path
                              strokeLinecap='round'
                              strokeLinejoin='round'
                              strokeWidth='2'
                              d='M6 18L18 6M6 6l12 12'
                            />
                          </svg>
                        </button>
                      </div>
                    </div>
                    {/* Progress bar */}
                    {(item.status === 'uploading' ||
                      item.status === 'error') && (
                      <div className='space-y-1.5'>
                        <div className='w-full bg-slate-100 dark:bg-slate-700/60 h-2 rounded-full overflow-hidden'>
                          <div
                            className={`h-2 rounded-full transition-all duration-300 ${
                              item.status === 'error'
                                ? 'bg-rose-400'
                                : 'bg-gradient-to-r from-emerald-500 to-teal-500'
                            }`}
                            style={{ width: `${item.progress}%` }}
                          />
                        </div>
                        {item.status === 'uploading' && (
                          <div className='flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400'>
                            <span className='font-medium'>
                              {formatSize(uploadedBytes)} of{' '}
                              {formatSize(item.size)}
                            </span>
                            <span className='font-mono font-semibold text-emerald-700 dark:text-emerald-400'>
                              {item.speed
                                ? `${formatSpeed(item.speed)} • ${formatEta(
                                    item.eta
                                  )}`
                                : `${item.progress}%`}
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                    {item.status === 'ready' && (
                      <div className='flex items-center justify-between'>
                        <p className='text-[11px] text-slate-500 dark:text-slate-400 font-mono'>
                          Verified • Linked to Street Path
                        </p>
                        <span className='w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold text-xs'>
                          ✓
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className='px-6 py-4 bg-slate-50/90 dark:bg-slate-900/80 border-t border-slate-200/80 dark:border-white/10 flex items-center justify-between gap-3'>
          <div className='text-xs text-slate-600 dark:text-slate-300 font-medium min-w-0 truncate'>
            {items.length === 0 ? (
              <span className='text-slate-400 dark:text-slate-500'>
                Queue empty — nothing selected yet
              </span>
            ) : (
              <>
                <span className='font-bold text-slate-900 dark:text-white'>
                  {items.length} file{items.length === 1 ? '' : 's'} selected
                </span>{' '}
                • {formatSize(totalBytes)} total
                {activeCount > 0 && (
                  <>
                    {' • '}
                    <span className='text-emerald-700 dark:text-emerald-400 font-semibold'>
                      {activeCount} in progress
                    </span>
                  </>
                )}
              </>
            )}
          </div>
          <div className='flex items-center space-x-2.5 flex-shrink-0'>
            <button
              type='button'
              onClick={clearQueue}
              disabled={items.length === 0}
              className='px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200/70 dark:hover:bg-slate-700 transition-all disabled:opacity-40 disabled:cursor-not-allowed'
            >
              Cancel All
            </button>
            <button
              type='button'
              onClick={handlePublish}
              disabled={!canPublish}
              className='px-4 py-2 rounded-xl bg-gradient-to-r from-emerald-600 via-teal-600 to-emerald-600 hover:from-emerald-700 hover:to-teal-700 text-white text-xs font-bold shadow-md shadow-emerald-600/25 transition-all flex items-center space-x-1.5 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100'
            >
              <svg
                className='w-4 h-4'
                fill='none'
                stroke='currentColor'
                viewBox='0 0 24 24'
                aria-hidden='true'
              >
                <path
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  strokeWidth='2'
                  d='M5 13l4 4L19 7'
                />
              </svg>
              <span>Publish to 360° Map</span>
            </button>
          </div>
        </div>
      </div>
  );
}
