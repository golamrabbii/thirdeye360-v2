/**
 * Dependency-free chunked / resumable ZIP uploader.
 *
 * Backend contract (paths resolved through apiUrl()):
 *   POST   /api/uploads/init            { filename, size }      -> { uploadId, chunkSize }
 *   PUT    /api/uploads/{id}/chunks/{n} raw body = chunk bytes -> { received: [ints] }
 *   GET    /api/uploads/{id}/status     -> { received, chunkSize, size, filename }
 *   POST   /api/uploads/{id}/complete   -> { ok, filename, path, size }
 *   DELETE /api/uploads/{id}            abort + discard partial data
 *
 * Progress is reported by BYTES (a chunk counts once the server confirms it),
 * speed is a smoothed bytes/s estimate and eta is in seconds. Sessions are
 * persisted to localStorage after every confirmed chunk so a closed tab or
 * dropped connection never loses more than one chunk of work.
 */

import { apiUrl } from '../config/api';

const SESSIONS_KEY = 'thirdeye360_zip_uploads';
const CONCURRENCY = 3; // chunks in flight within a single file
const MAX_RETRIES = 3; // per chunk, before the file is failed
const RETRY_BACKOFF_MS = [500, 2000, 5000];
const FALLBACK_CHUNK_SIZE = 16 * 1024 * 1024;
const PROGRESS_THROTTLE_MS = 200;

/* ------------------------- localStorage session store ------------------------- */

function readSessions() {
  if (typeof window === 'undefined') return [];
  try {
    const list = JSON.parse(window.localStorage.getItem(SESSIONS_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeSessions(list) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SESSIONS_KEY, JSON.stringify(list));
  } catch {
    // storage full / private mode — resume simply will not survive a reload
  }
}

/** All persisted (paused / interrupted) upload sessions. */
export function getStoredSessions() {
  return readSessions();
}

export function findStoredSession(uploadId) {
  return readSessions().find((s) => s.uploadId === uploadId) || null;
}

function saveSessionRecord(record) {
  writeSessions([...readSessions().filter((s) => s.uploadId !== record.uploadId), record]);
}

export function removeStoredSession(uploadId) {
  writeSessions(readSessions().filter((s) => s.uploadId !== uploadId));
}

/** Abort + discard a session the page only knows from localStorage. */
export async function abortStoredSession(uploadId) {
  removeStoredSession(uploadId);
  try {
    await fetch(apiUrl(`/api/uploads/${uploadId}`), { method: 'DELETE' });
  } catch {
    // already gone or offline — the server-side janitor can reap it
  }
}

/** A File may resume a stored session when name + size agree. */
export function matchesSession(file, session) {
  return !!file && !!session && file.name === session.filename && file.size === session.size;
}

/* ------------------------------- the uploader ------------------------------- */

/**
 * createZipUpload({ file, session, onProgress, onChunkError, onInit }) starts
 * (or resumes) an upload immediately and returns control handles:
 *   { pause(), resume(), cancel(), promise, getUploadId() }
 * `session` (from getStoredSessions()) continues an interrupted upload; it is
 * reconciled with the server via GET /status first. `promise` resolves with the
 * /complete response or rejects with an Error carrying `.cancelled` /
 * `.sessionGone` flags. `onInit(uploadId)` fires once the server session is
 * known (new or resumed), so the caller can poll live GPS stats.
 */
export function createZipUpload({ file, session = null, onProgress, onChunkError, onInit }) {
  const totalBytes = file.size;
  let uploadId = session ? session.uploadId : null;
  let chunkSize = session ? session.chunkSize || 0 : 0;
  let uploaded = new Set(session ? session.uploadedChunks || [] : []);
  let uploadedBytes = 0;
  let totalChunks = 0;
  let nextIndex = 0;
  let paused = false;
  let cancelled = false;
  let settled = false;
  let completing = false;
  let speed = 0;
  let lastEmit = 0;
  let lastSample = { t: Date.now(), bytes: 0 };
  const active = new Set();
  const controllers = new Set();

  let resolveDone;
  let rejectDone;
  const promise = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const chunkLength = (index) => Math.min(chunkSize, totalBytes - index * chunkSize);
  const recomputeBytes = () => {
    uploadedBytes = 0;
    uploaded.forEach((i) => {
      uploadedBytes += chunkLength(i);
    });
  };
  const cancelledError = () => {
    const err = new Error('Upload cancelled');
    err.cancelled = true;
    return err;
  };
  const sessionRecord = () => ({
    uploadId,
    filename: file.name,
    size: totalBytes,
    chunkSize,
    uploadedChunks: [...uploaded].sort((a, b) => a - b),
    fileLastModified: file.lastModified,
  });

  const emit = () => {
    if (!onProgress) return;
    const effSpeed = paused || cancelled ? 0 : speed;
    onProgress({
      percent: totalBytes ? Math.min(100, (uploadedBytes / totalBytes) * 100) : 100,
      uploadedBytes,
      totalBytes,
      speed: effSpeed,
      eta: effSpeed > 0 ? (totalBytes - uploadedBytes) / effSpeed : Infinity,
    });
  };

  const notify = (force = false) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastEmit < PROGRESS_THROTTLE_MS) return;
    lastEmit = now;
    const dt = (now - lastSample.t) / 1000;
    const db = uploadedBytes - lastSample.bytes;
    if (dt >= 0.25) {
      const instant = db / dt;
      speed = speed > 0 ? speed * 0.7 + instant * 0.3 : instant;
      lastSample = { t: now, bytes: uploadedBytes };
    }
    emit();
  };

  const fail = (err) => {
    if (settled || cancelled) return;
    settled = true;
    rejectDone(err);
  };

  const completeUpload = async () => {
    try {
      const res = await fetch(apiUrl(`/api/uploads/${uploadId}/complete`), { method: 'POST' });
      if (!res.ok) throw new Error(`Server could not finalize the upload (HTTP ${res.status})`);
      const data = await res.json();
      removeStoredSession(uploadId);
      settled = true;
      resolveDone(data);
    } catch (err) {
      fail(err);
    }
  };

  const maybeDone = () => {
    if (completing || settled || cancelled) return;
    if (active.size === 0 && uploaded.size >= totalChunks) {
      completing = true;
      completeUpload();
    }
  };

  const initSession = async () => {
    if (session) {
      // Resume: reconcile the stored session with what the server still has.
      const res = await fetch(apiUrl(`/api/uploads/${uploadId}/status`));
      if (res.status === 404) {
        removeStoredSession(uploadId);
        const err = new Error('Upload session expired on the server — retry to start over');
        err.sessionGone = true;
        throw err;
      }
      if (res.ok) {
        const data = await res.json();
        chunkSize = data.chunkSize || chunkSize;
        uploaded = new Set([...uploaded, ...(data.received || [])]);
      }
      // A failed status probe (offline etc.) keeps local state — chunk PUTs are idempotent.
    } else {
      const res = await fetch(apiUrl('/api/uploads/init'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, size: totalBytes }),
      });
      if (!res.ok) throw new Error(`Could not start the upload (HTTP ${res.status})`);
      const data = await res.json();
      uploadId = data.uploadId;
      chunkSize = data.chunkSize;
    }
    if (!chunkSize) chunkSize = FALLBACK_CHUNK_SIZE;
    totalChunks = Math.max(1, Math.ceil(totalBytes / chunkSize));
    uploaded.forEach((i) => {
      if (i >= totalChunks) uploaded.delete(i);
    });
    recomputeBytes();
    saveSessionRecord(sessionRecord());
    lastSample = { t: Date.now(), bytes: uploadedBytes };
    emit();
  };

  const putChunk = async (index) => {
    const controller = new AbortController();
    controllers.add(controller);
    const body = file.slice(index * chunkSize, (index + 1) * chunkSize);
    try {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        try {
          const res = await fetch(apiUrl(`/api/uploads/${uploadId}/chunks/${index}`), {
            method: 'PUT',
            body,
            signal: controller.signal,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return;
        } catch (err) {
          if (cancelled || controller.signal.aborted) throw cancelledError();
          const last = attempt >= MAX_RETRIES;
          if (onChunkError) onChunkError({ index, attempt: attempt + 1, willRetry: !last, error: err });
          if (last) throw err;
          await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[attempt]));
          if (cancelled) throw cancelledError();
        }
      }
    } finally {
      controllers.delete(controller);
    }
  };

  const startChunk = async (index) => {
    active.add(index);
    try {
      await putChunk(index);
    } catch (err) {
      active.delete(index);
      if (!cancelled && !err.cancelled) fail(err); // cancel() owns the rejection
      return;
    }
    active.delete(index);
    uploaded.add(index);
    uploadedBytes += chunkLength(index);
    saveSessionRecord(sessionRecord());
    notify();
    if (!cancelled && !paused && !settled) pump();
    maybeDone();
  };

  function pump() {
    if (cancelled || paused || settled) return;
    while (active.size < CONCURRENCY && nextIndex < totalChunks) {
      const index = nextIndex;
      nextIndex += 1;
      if (!uploaded.has(index)) startChunk(index);
    }
    maybeDone();
  }

  const pause = () => {
    if (cancelled || settled) return;
    paused = true;
    if (uploadId) saveSessionRecord(sessionRecord());
    emit();
  };

  const resume = () => {
    if (cancelled || settled || !paused) return;
    paused = false;
    lastSample = { t: Date.now(), bytes: uploadedBytes };
    pump();
  };

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    controllers.forEach((c) => c.abort());
    controllers.clear();
    if (uploadId) {
      removeStoredSession(uploadId);
      fetch(apiUrl(`/api/uploads/${uploadId}`), { method: 'DELETE' }).catch(() => {});
    }
    if (!settled) {
      settled = true;
      rejectDone(cancelledError());
    }
  };

  const run = async () => {
    try {
      if (totalBytes <= 0) throw new Error('Empty file');
      await initSession();
      if (onInit && uploadId) onInit(uploadId);
      if (!cancelled && !settled) pump();
    } catch (err) {
      fail(err);
    }
  };

  run();

  return { pause, resume, cancel, promise, getUploadId: () => uploadId };
}

/** Continue a stored session with a re-selected File (caller verifies matchesSession first). */
export function restoreSession({ session, file, onProgress, onChunkError }) {
  return createZipUpload({ file, session, onProgress, onChunkError });
}
