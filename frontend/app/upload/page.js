'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import LoginModal from '../components/ui/LoginModal';
import {
  createZipUpload,
  getStoredSessions,
  findStoredSession,
  matchesSession,
  abortStoredSession,
} from '../utils/chunkedUpload';
import { apiUrl } from '../config/api';

/** No cap — every selected .zip uploads at once, each running its own
 * 3-chunks-in-flight pipeline inside createZipUpload. */
const MAX_PARALLEL_UPLOADS = Infinity;

let nextItemId = 0;

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '--';
  return `${formatSize(bytesPerSecond)}/s`;
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s remaining`;
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s remaining`;
  }
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m remaining`;
}

function isZip(file) {
  return (
    /\.zip$/i.test(file?.name || '') ||
    file?.type === 'application/zip' ||
    file?.type === 'application/x-zip-compressed'
  );
}

function StatusBadge({ item }) {
  const base = 'px-1.5 py-0.5 rounded text-[10px] font-bold border flex-shrink-0';
  switch (item.status) {
    case 'uploading':
      return (
        <span
          className={`${base} bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-500/30`}
        >
          Uploading {Math.min(100, Math.floor(item.percent || 0))}%
        </span>
      );
    case 'done':
      return (
        <span
          className={`${base} bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/30`}
        >
          ✓ Uploaded
        </span>
      );
    case 'error':
      return (
        <span
          className={`${base} bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-500/10 dark:text-rose-400 dark:border-rose-500/30`}
        >
          Failed
        </span>
      );
    case 'paused':
      return (
        <span
          className={`${base} bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-500/10 dark:text-sky-400 dark:border-sky-500/30`}
        >
          {item.restored ? 'Paused — Resume' : 'Paused'}
        </span>
      );
    case 'queued':
    default:
      return (
        <span
          className={`${base} bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-white/10`}
        >
          Queued
        </span>
      );
  }
}

function ZipTile({ done }) {
  return (
    <div
      className={`relative w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 border ${
        done
          ? 'border-emerald-300 bg-emerald-50 text-emerald-600 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400'
          : 'border-slate-200 bg-slate-50 text-slate-400 dark:border-white/10 dark:bg-slate-800 dark:text-slate-500'
      }`}
    >
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
          d='M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4'
        />
      </svg>
      <span
        className={`absolute bottom-0.5 right-0.5 px-1 text-[9px] font-extrabold rounded ${
          done ? 'bg-emerald-700 text-white' : 'bg-black/70 text-emerald-400'
        }`}
      >
        ZIP
      </span>
    </div>
  );
}

function metaLine(item) {
  // Live scan line while the archive is still uploading/paused.
  const liveGps = (it) => {
    const s = it.gpsLive;
    if (!s || (!s.total_images && !s.scanning)) return null;
    return (
      <>
        {' '}· GPS: {s.with_gps} with ·{' '}
        <span className='text-rose-600 dark:text-rose-400'>
          {s.without_gps} without GPS
        </span>
        {s.scanning ? ` · ${s.scanning} scanning` : ''}
      </>
    );
  };

  if (item.status === 'uploading') {
    // No filler text — only the live scan numbers once they exist.
    if (item.retrying) return `Retrying chunk (attempt ${item.retrying}/3)…`;
    return liveGps(item);
  }
  if (item.status === 'queued') return 'Waiting for a free upload slot';
  if (item.status === 'paused') {
    if (item.restored) return 'Session restored — re-select this .zip to resume';
    return (
      <>
        Paused — resume anytime, confirmed chunks are kept
        {liveGps(item)}
      </>
    );
  }
  if (item.status === 'done') {
    const s = item.gpsStats;
    if (s && s.error) return 'Stored, but GPS stats unavailable';
    if (s && s.total_images > 0) {
      return (
        <>
          GPS: {s.with_gps} with GPS ·{' '}
          <span className='text-rose-600 dark:text-rose-400 font-bold'>
            {s.without_gps} without GPS
          </span>{' '}
          · {s.total_images} total
        </>
      );
    }
    if (s) return 'Stored — no image files found in this archive';
    return 'Verified • Stored on the server';
  }
  return 'Upload failed';
}

function FileCard({ item, onPause, onResume, onCancel, onRetry }) {
  const isUploading = item.status === 'uploading';
  const isPaused = item.status === 'paused';
  const isError = item.status === 'error';
  const isDone = item.status === 'done';
  const isActive = isUploading || isPaused || item.status === 'queued';
  const percent = Math.min(100, Math.floor(item.percent || 0));
  const uploadedBytes =
    item.uploadedBytes != null
      ? item.uploadedBytes
      : Math.round((item.size * (item.percent || 0)) / 100);
  const iconBtn =
    'p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors';

  const meta = metaLine(item);

  return (
    <div
      className={`p-3.5 rounded-2xl bg-white dark:bg-slate-800/70 border shadow-sm flex flex-col space-y-3 ${
        isDone
          ? 'border-emerald-200/80 dark:border-emerald-500/30'
          : isError
          ? 'border-rose-200/90 dark:border-rose-500/30'
          : 'border-slate-200/90 dark:border-white/10'
      }`}
    >
      <div className='flex items-center justify-between gap-3'>
        <div className='flex items-center space-x-3 min-w-0'>
          <ZipTile done={isDone} />
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
            <p className='text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 font-mono break-words'>
              {formatSize(item.size)}
              {meta ? (
                <>
                  {' '}• {meta}
                </>
              ) : null}
            </p>
            {isError && item.error && (
              <div className='flex items-center space-x-2 mt-1'>
                <span className='text-[11px] font-semibold text-rose-600 dark:text-rose-400'>
                  {item.error}
                </span>
                <button
                  type='button'
                  onClick={() => onRetry(item)}
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
          {isUploading && (
            <button
              type='button'
              onClick={() => onPause(item)}
              aria-label={`Pause upload of ${item.name}`}
              title='Pause upload'
              className={`${iconBtn} hover:text-slate-700 dark:hover:text-slate-200`}
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
                  strokeWidth='2.5'
                  d='M9 5.5v13M15 5.5v13'
                />
              </svg>
            </button>
          )}
          {isPaused && (
            <button
              type='button'
              onClick={() => onResume(item)}
              aria-label={`Resume upload of ${item.name}`}
              title='Resume upload'
              className={`${iconBtn} hover:text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-500/10`}
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
                  d='M6 4l12 8-12 8V4z'
                />
              </svg>
            </button>
          )}
          {isError && (
            <button
              type='button'
              onClick={() => onRetry(item)}
              aria-label={`Retry upload of ${item.name}`}
              title='Retry upload'
              className={`${iconBtn} hover:text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-500/10`}
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
          {isActive && (
            <button
              type='button'
              onClick={() => onCancel(item)}
              aria-label={`Cancel upload of ${item.name}`}
              title='Cancel upload'
              className={`${iconBtn} text-rose-500 hover:text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10`}
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
          )}
          {isDone && (
            <button
              type='button'
              onClick={() => onCancel(item)}
              aria-label={`Remove ${item.name} from the queue`}
              title='Remove from queue'
              className={`${iconBtn} text-rose-500 hover:text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10`}
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
          )}
        </div>
      </div>
      {/* Progress bar */}
      {isActive && (
        <div className='space-y-1.5'>
          <div className='w-full bg-slate-100 dark:bg-slate-700/60 h-2 rounded-full overflow-hidden'>
            <div
              className={`h-2 rounded-full transition-all duration-300 bg-gradient-to-r from-emerald-500 to-teal-500 ${
                isPaused ? 'opacity-60' : ''
              }`}
              style={{ width: `${percent}%` }}
            />
          </div>
          {isUploading && (
            <div className='flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400'>
              <span className='font-medium'>
                {formatSize(uploadedBytes)} of {formatSize(item.size)}
              </span>
              <span className='font-mono font-semibold text-emerald-700 dark:text-emerald-400'>
                {item.speed
                  ? `${formatSpeed(item.speed)} • ${formatEta(item.eta)}`
                  : `${percent}%`}
              </span>
            </div>
          )}
          {isPaused && (
            <div className='flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400'>
              <span className='font-medium'>{percent}% uploaded</span>
              <span className='font-mono font-semibold'>
                {item.restored ? 'Re-select the .zip to resume' : 'Resumable'}
              </span>
            </div>
          )}
        </div>
      )}
      {isError && (
        <div className='w-full bg-slate-100 dark:bg-slate-700/60 h-2 rounded-full overflow-hidden'>
          <div
            className='h-2 rounded-full bg-rose-400 transition-all duration-300'
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
      {isDone && (
        <div className='flex items-center justify-between'>
          <p className='text-[11px] text-slate-500 dark:text-slate-400 font-mono'>
            Verified • Stored on the 360° server
          </p>
          <span className='w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400 flex items-center justify-center font-bold text-xs'>
            ✓
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Dedicated ZIP upload page (opened in a new tab from the header).
 * Restored Upload360Panel design as a static page card, driven by the
 * chunked / resumable uploader: up to 3 archives upload in parallel (each
 * with 3 chunks in flight) and sessions persist so interrupted uploads
 * survive a reload. Requires sign-in — shows the login dialog until
 * authenticated.
 */
export default function UploadPage() {
  const { isAuthenticated, isAdmin, isLoading } = useAuth();
  const [showLogin, setShowLogin] = useState(false);
  const [items, setItems] = useState([]);
  const [dragging, setDragging] = useState(false);
  const itemsRef = useRef([]);
  const handlesRef = useRef({});
  const dragDepthRef = useRef(0);
  const pickRef = useRef(null);
  const resumePickRef = useRef(null);
  const resumeTargetRef = useRef(null);

  const commit = useCallback((next) => {
    itemsRef.current = next;
    setItems(next);
  }, []);

  const patchItem = useCallback(
    (id, patch) =>
      commit(itemsRef.current.map((it) => (it.id === id ? { ...it, ...patch } : it))),
    [commit]
  );

  const removeItem = useCallback(
    (id) => commit(itemsRef.current.filter((it) => it.id !== id)),
    [commit]
  );

  // Not signed in? Offer the login dialog right away.
  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      setShowLogin(true);
    }
  }, [isLoading, isAuthenticated]);

  // Interrupted uploads from a previous visit -> "Paused — resume" cards.
  useEffect(() => {
    if (!isAuthenticated) return;
    const sessions = getStoredSessions();
    if (!sessions.length) return;
    commit(
      sessions.map((s) => {
        const done = Math.min(
          s.size || 0,
          (s.uploadedChunks || []).length * (s.chunkSize || 0)
        );
        return {
          id: `restored-${s.uploadId}`,
          session: s,
          uploadId: s.uploadId,
          name: s.filename,
          size: s.size,
          status: 'paused',
          restored: true,
          percent: s.size ? (done / s.size) * 100 : 0,
          uploadedBytes: done,
          speed: 0,
          eta: null,
        };
      })
    );
  }, [isAuthenticated, commit]);

  // Live GPS stats: the backend scans each image the moment its bytes
  // are fully on disk, so by the time the progress bar hits 100% the
  // stats are (almost) already computed. Poll while a file is active.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const active = itemsRef.current.filter(
        (it) =>
          it.uploadId &&
          !it.gpsStats &&
          (it.status === 'uploading' || it.status === 'paused')
      );
      await Promise.all(
        active.map(async (it) => {
          try {
            const res = await fetch(apiUrl(`/api/uploads/${it.uploadId}/gps-stats`));
            if (!res.ok) return;
            const data = await res.json();
            if (!cancelled) patchItem(it.id, { gpsLive: data });
          } catch {
            // transient network error — the next tick retries
          }
        })
      );
    };
    const interval = setInterval(tick, 2500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [patchItem]);

  /** Starts (or resumes) one archive with the chunked uploader. */
  const startItem = useCallback(
    (item) => {
      const target = itemsRef.current.find((it) => it.id === item.id) || item;
      if (!target.file || handlesRef.current[target.id]) return;
      patchItem(target.id, { status: 'uploading', error: null, retrying: null });

      const handle = createZipUpload({
        file: target.file,
        session: target.session || null,
        onInit: (uploadId) => patchItem(target.id, { uploadId }),
        onProgress: (p) => {
          const current = itemsRef.current.find((it) => it.id === target.id);
          patchItem(target.id, {
            // A late chunk confirmation must not wake a paused card.
            status: current && current.status === 'paused' ? 'paused' : 'uploading',
            percent: p.percent,
            uploadedBytes: p.uploadedBytes,
            speed: p.speed,
            eta: p.eta,
            retrying: null,
          });
        },
        onChunkError: ({ attempt, willRetry }) => {
          patchItem(target.id, { retrying: willRetry ? attempt : null });
        },
      });
      handlesRef.current[target.id] = handle;

      handle.promise
        .then((result) => {
          delete handlesRef.current[target.id];
          patchItem(target.id, {
            status: 'done',
            percent: 100,
            uploadedBytes: target.size,
            speed: 0,
            eta: null,
            retrying: null,
            gpsStats: result?.gps_stats || null,
          });
          toast.success(`${target.name} uploaded`);
        })
        .catch((err) => {
          delete handlesRef.current[target.id];
          if (err?.cancelled) return; // cancel already removed the card
          patchItem(target.id, {
            status: 'error',
            error: err?.message || 'Upload failed',
            speed: 0,
            eta: null,
            retrying: null,
          });
          toast.error(`${target.name}: ${err?.message || 'upload failed'}`);
        });
    },
    [patchItem]
  );

  // Parallel scheduler: keep up to MAX_PARALLEL_UPLOADS archives uploading at
  // once (each createZipUpload instance runs its own 3-chunk pipeline), and
  // backfill from the queue whenever a slot frees up.
  useEffect(() => {
    let freeSlots =
      MAX_PARALLEL_UPLOADS - items.filter((it) => it.status === 'uploading').length;
    if (freeSlots <= 0) return;
    for (const it of items) {
      if (freeSlots <= 0) break;
      if (it.status !== 'queued' || !it.file) continue;
      if (handlesRef.current[it.id]) continue;
      startItem(it);
      freeSlots -= 1;
    }
  }, [items, startItem]);

  const addFiles = useCallback(
    (fileList) => {
      const files = Array.from(fileList || []);
      if (!files.length) return;
      const zips = files.filter(isZip);
      const skipped = files.length - zips.length;
      if (skipped) {
        toast.error(
          `${skipped} file${skipped > 1 ? 's' : ''} skipped — only .zip archives are accepted`
        );
      }
      if (!zips.length) return;
      commit([
        ...itemsRef.current,
        ...zips.map((file) => ({
          id: `f${Date.now()}-${(nextItemId += 1)}`,
          file,
          name: file.name,
          size: file.size,
          status: 'queued',
          percent: 0,
          uploadedBytes: 0,
          speed: 0,
          eta: null,
          retrying: null,
        })),
      ]);
    },
    [commit]
  );

  const handlePause = (item) => {
    handlesRef.current[item.id]?.pause();
    patchItem(item.id, { status: 'paused', speed: 0, eta: null, retrying: null });
  };

  const handleResume = (item) => {
    if (item.restored && !item.file) {
      // Session survived a reload — ask the user to re-select the same .zip.
      resumeTargetRef.current = item.id;
      resumePickRef.current?.click();
      return;
    }
    handlesRef.current[item.id]?.resume();
    patchItem(item.id, { status: 'uploading', speed: 0, retrying: null });
  };

  const handleResumePick = (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    const item = itemsRef.current.find((it) => it.id === resumeTargetRef.current);
    resumeTargetRef.current = null;
    if (!file || !item) return;
    if (!matchesSession(file, item.session)) {
      toast.error(
        'That file does not match the paused upload — pick the same .zip to resume'
      );
      return;
    }
    patchItem(item.id, { file, restored: false, status: 'queued', error: null });
  };

  const handleCancel = (item) => {
    const handle = handlesRef.current[item.id];
    if (handle) {
      handle.cancel();
      delete handlesRef.current[item.id];
    } else if (item.uploadId) {
      abortStoredSession(item.uploadId);
    }
    removeItem(item.id);
    toast.success(`${item.name} — upload cancelled`);
  };

  const handleRetry = (item) => {
    // Re-attach the persisted session so confirmed chunks are not re-sent.
    const stored =
      (item.uploadId && findStoredSession(item.uploadId)) ||
      getStoredSessions().find((s) => s.filename === item.name && s.size === item.size) ||
      null;
    patchItem(item.id, {
      status: 'queued',
      error: null,
      session: stored,
      uploadId: stored ? stored.uploadId : item.uploadId,
      percent:
        stored && item.size
          ? (Math.min(item.size, stored.uploadedChunks.length * stored.chunkSize) /
              item.size) *
            100
          : item.percent,
    });
  };

  const handleCancelAll = () => {
    const remaining = [];
    itemsRef.current.forEach((it) => {
      if (it.status === 'done') {
        remaining.push(it);
        return;
      }
      const handle = handlesRef.current[it.id];
      if (handle) {
        handle.cancel();
        delete handlesRef.current[it.id];
      } else if (it.uploadId) {
        abortStoredSession(it.uploadId);
      }
    });
    commit(remaining);
    toast.success('All active uploads cancelled');
  };

  const uploadingCount = items.filter((it) => it.status === 'uploading').length;
  const queuedCount = items.filter((it) => it.status === 'queued').length;
  const pausedCount = items.filter((it) => it.status === 'paused').length;
  const doneCount = items.filter((it) => it.status === 'done').length;
  const errorCount = items.filter((it) => it.status === 'error').length;
  const totalBytes = items.reduce((sum, it) => sum + it.size, 0);
  const hasCancellable = items.some((it) => it.status !== 'done');

  const badgeParts = [
    uploadingCount > 0 && `${uploadingCount} Uploading`,
    queuedCount > 0 && `${queuedCount} Queued`,
    pausedCount > 0 && `${pausedCount} Paused`,
    doneCount > 0 && `${doneCount} Uploaded`,
    errorCount > 0 && `${errorCount} Failed`,
  ].filter(Boolean);

  const dropClasses = dragging
    ? 'border-emerald-500 bg-emerald-50/70 scale-[1.01] shadow-inner dark:bg-emerald-500/10'
    : 'border-emerald-400/80 hover:border-emerald-500 bg-emerald-50/40 hover:bg-emerald-50/70 dark:border-emerald-500/40 dark:bg-emerald-500/5 dark:hover:bg-emerald-500/10';

  // Signed in without admin permission: the console stays hidden entirely.
  // Not logged in is handled by the sign-in panel below — same outcome
  // (no upload access), different prompt.
  if (!isLoading && isAuthenticated && !isAdmin) {
    return (
      <div className='relative min-h-screen w-full bg-slate-100 dark:bg-slate-950 text-slate-900 dark:text-slate-100 overflow-hidden select-none'>
        <div
          aria-hidden='true'
          className='pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(16,185,129,0.08),transparent_55%)]'
        />
        <header className='relative z-20 flex items-center justify-between px-4 py-4 sm:px-6'>
          <Link
            href='/'
            className='group flex items-center gap-2 text-xs font-bold text-slate-500 dark:text-slate-400 transition-colors hover:text-slate-900 dark:hover:text-white'
          >
            <svg
              className='w-4 h-4 transition-transform group-hover:-translate-x-0.5'
              fill='none'
              stroke='currentColor'
              viewBox='0 0 24 24'
              aria-hidden='true'
            >
              <path
                strokeLinecap='round'
                strokeLinejoin='round'
                strokeWidth='2'
                d='M10 19l-7-7m0 0l7-7m-7 7h18'
              />
            </svg>
            Back to map
          </Link>
        </header>
        <main className='relative z-10 flex min-h-screen flex-col items-center justify-center px-4 pb-16'>
          <div className='w-full max-w-md rounded-3xl border border-white/80 bg-white/90 p-6 text-center shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-slate-900/90 sm:p-8'>
            <div className='mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-rose-200/80 bg-rose-50 text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-400'>
              <svg
                className='h-6 w-6'
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
            </div>
            <h1 className='text-lg font-extrabold tracking-tight text-slate-900 dark:text-white'>
              Admin permission required
            </h1>
            <p className='mx-auto mt-2 max-w-xs text-xs leading-relaxed text-slate-500 dark:text-slate-400'>
              Your account does not have upload access. Ask a Barikoi
              administrator to grant admin permission for this account.
            </p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className='relative min-h-screen w-full bg-slate-100 dark:bg-slate-950 text-slate-900 dark:text-slate-100 overflow-hidden select-none'>
      {/* Ambient backdrop */}
      <div
        aria-hidden='true'
        className='pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(16,185,129,0.08),transparent_55%)]'
      />

      {/* Slim page bar */}
      <header className='relative z-20 flex items-center justify-between px-4 py-4 sm:px-6'>
        <Link
          href='/'
          className='group flex items-center gap-2 text-xs font-bold text-slate-500 dark:text-slate-400 transition-colors hover:text-slate-900 dark:hover:text-white'
        >
          <svg
            className='w-4 h-4 transition-transform group-hover:-translate-x-0.5'
            fill='none'
            stroke='currentColor'
            viewBox='0 0 24 24'
            aria-hidden='true'
          >
            <path
              strokeLinecap='round'
              strokeLinejoin='round'
              strokeWidth='2'
              d='M10 19l-7-7m0 0l7-7m-7 7h18'
            />
          </svg>
          Back to map
        </Link>
        <div className='flex items-center gap-2'>
          <span className='text-sm font-extrabold tracking-tight text-slate-900 dark:text-white'>
            ThirdEye<span className='text-emerald-600 dark:text-emerald-400'>360</span>
          </span>
          <span className='hidden sm:inline-flex items-center rounded-full border border-emerald-200/80 bg-emerald-50 px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-widest text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400'>
            Surveyor Console
          </span>
        </div>
      </header>

      {/* Content */}
      <main className='relative z-10 flex flex-col items-center px-4 pt-2 pb-16'>
        {isLoading ? (
          <div className='flex h-64 items-center justify-center'>
            <div className='h-12 w-12 animate-spin rounded-full border-t-2 border-b-2 border-emerald-500'></div>
          </div>
        ) : isAuthenticated ? (
          <div className='w-full max-w-2xl'>
            <div className='relative w-full bg-white/90 dark:bg-slate-900/90 backdrop-blur-2xl rounded-3xl shadow-2xl border border-white/80 dark:border-white/10 overflow-hidden flex flex-col scale-in outline-none'>
              {/* Header */}
              <div className='px-6 py-5 border-b border-slate-200/80 dark:border-white/10 flex items-center justify-between bg-white/50 dark:bg-white/5 backdrop-blur-sm'>
                <div className='flex items-center space-x-3.5'>
                  <div className='w-11 h-11 rounded-2xl bg-gradient-to-tr from-emerald-600 via-teal-600 to-emerald-400 flex items-center justify-center text-white shadow-lg shadow-emerald-500/25 border border-white/40 flex-shrink-0'>
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
                  <h3 className='text-base font-extrabold text-slate-900 dark:text-white tracking-tight'>
                    Upload 360° Panoramic Imagery
                  </h3>
                </div>
                <Link
                  href='/'
                  aria-label='Close the uploader and return to the map'
                  title='Back to map'
                  className='w-8 h-8 rounded-xl flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors flex-shrink-0'
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
                </Link>
              </div>

              {/* Body */}
              <div className='p-6 space-y-5'>
                {/* Drag & Drop Zone */}
                <div
                  role='button'
                  tabIndex={0}
                  aria-label='Drag and drop 360° capture ZIPs here, or browse files'
                  onClick={() => pickRef.current?.click()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      pickRef.current?.click();
                    }
                  }}
                  onDragEnter={(e) => {
                    e.preventDefault();
                    dragDepthRef.current += 1;
                    setDragging(true);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'copy';
                  }}
                  onDragLeave={(e) => {
                    e.preventDefault();
                    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
                    if (dragDepthRef.current === 0) setDragging(false);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    dragDepthRef.current = 0;
                    setDragging(false);
                    addFiles(e.dataTransfer?.files);
                  }}
                  className={`relative group border-2 border-dashed transition-all rounded-2xl p-6 text-center cursor-pointer flex flex-col items-center justify-center outline-none ${dropClasses}`}
                >
                  <input
                    ref={pickRef}
                    type='file'
                    multiple
                    accept='.zip'
                    className='hidden'
                    onChange={(e) => {
                      addFiles(e.target.files);
                      e.target.value = '';
                    }}
                  />
                  <div className='w-12 h-12 rounded-2xl bg-white dark:bg-slate-900 shadow-sm border border-emerald-200/80 dark:border-emerald-500/30 flex items-center justify-center text-emerald-600 dark:text-emerald-400 mb-3 group-hover:scale-105 transition-transform'>
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
                    Drag &amp; drop ZIPs here, or{' '}
                    <span className='text-emerald-600 group-hover:underline'>
                      Browse Files
                    </span>
                  </p>
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
                      No archives in the queue yet — add 360° capture ZIPs above to
                      begin.
                    </div>
                  )}

                  <div aria-live='polite' className='space-y-3'>
                    {items.map((item) => (
                      <FileCard
                        key={item.id}
                        item={item}
                        onPause={handlePause}
                        onResume={handleResume}
                        onCancel={handleCancel}
                        onRetry={handleRetry}
                      />
                    ))}
                  </div>
                </div>

                {/* Hidden single-file picker for resuming a restored session */}
                <input
                  ref={resumePickRef}
                  type='file'
                  accept='.zip'
                  className='hidden'
                  onChange={handleResumePick}
                />
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
                      {uploadingCount > 0 && (
                        <>
                          {' • '}
                          <span className='text-emerald-700 dark:text-emerald-400 font-semibold'>
                            {uploadingCount} uploading
                          </span>
                        </>
                      )}
                    </>
                  )}
                </div>
                <div className='flex items-center flex-shrink-0'>
                  <button
                    type='button'
                    onClick={handleCancelAll}
                    disabled={!hasCancellable}
                    className='px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200/70 dark:hover:bg-slate-700 transition-all disabled:opacity-40 disabled:cursor-not-allowed'
                  >
                    Cancel All
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className='w-full max-w-md rounded-3xl border border-white/80 bg-white/90 p-6 text-center shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-slate-900/90 sm:p-8'>
            <div className='mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-emerald-200/80 bg-emerald-50 text-emerald-600 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400'>
              <svg className='h-6 w-6' fill='none' stroke='currentColor' viewBox='0 0 24 24' aria-hidden='true'>
                <path
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  strokeWidth='2'
                  d='M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z'
                />
              </svg>
            </div>
            <h1 className='text-lg font-extrabold tracking-tight text-slate-900 dark:text-white'>
              Surveyor sign-in required
            </h1>
            <p className='mx-auto mt-2 max-w-xs text-xs leading-relaxed text-slate-500 dark:text-slate-400'>
              Sign in with your Barikoi surveyor credentials to upload ZIP imagery
              archives to the coverage network.
            </p>
            <button
              type='button'
              onClick={() => setShowLogin(true)}
              className='mt-5 inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-emerald-600 via-teal-600 to-emerald-600 px-5 py-2.5 text-xs font-bold text-white shadow-md shadow-emerald-600/25 transition-all hover:from-emerald-700 hover:to-teal-700 active:scale-95'
            >
              <svg className='h-4 w-4' fill='none' stroke='currentColor' viewBox='0 0 24 24' aria-hidden='true'>
                <path
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  strokeWidth='2'
                  d='M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1'
                />
              </svg>
              Sign In to Upload
            </button>
          </div>
        )}
      </main>

      {/* Login dialog for unauthenticated visitors */}
      <LoginModal isOpen={showLogin} onClose={() => setShowLogin(false)} />
    </div>
  );
}
