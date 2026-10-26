/**
 * Panorama performance instrumentation.
 *
 * Marks the two SV-grade latency targets — map-click → first pano pixels
 * (reveal) and step → next pano (should be ~0 ms, pixels pre-decoded) — and
 * samples Resource Timing TTFB per pano fetch. Reports are batched and sent
 * via sendBeacon to /api/metrics/perf (fire-and-forget, 10% sampled).
 */

import { apiUrl } from '../config/api';

const SAMPLE_RATE = 0.1;
let pending = [];
let flushTimer = null;

const enabled =
  typeof window !== 'undefined' &&
  typeof performance !== 'undefined' &&
  typeof performance.mark === 'function';

function sampled() {
  return Math.random() < SAMPLE_RATE;
}

function mark(name) {
  if (enabled) {
    try {
      performance.mark(name);
    } catch {
      /* ignore */
    }
  }
}

function measure(name, startMark, endMark) {
  let duration = null;
  if (enabled) {
    try {
      performance.mark(endMark);
      const m = performance.measure(name, startMark, endMark);
      duration = m.duration;
    } catch {
      return null;
    }
  }
  return duration;
}

/* ---- public API ------------------------------------------------------ */

/** The user selected a pano (map click / shared link). */
export const markPanoSelect = () => mark('pano:select');

/** The user stepped to an adjacent frame (arrow / click). */
export const markPanoStep = (dir) =>
  mark(dir >= 0 ? 'pano:step-fwd' : 'pano:step-back');

/** First pixels of a pano are on screen (engine onLoaded). */
export const markPanoRevealed = (kind = 'select') => {
  const start =
    kind === 'step' ? 'pano:step-fwd' : 'pano:select';
  const d = measure('pano:reveal', start, 'pano:revealed');
  if (d != null) {
    report({ event: 'reveal', ms: Math.round(d), kind });
  }
};

/** The HD tier finished upgrading (quality target). */
export const markHdReady = () => {
  if (!enabled) return;
  try {
    const selects = performance.getEntriesByName('pano:select');
    if (!selects.length) return;
    const lastSelect = selects[selects.length - 1];
    report({
      event: 'hd-ready',
      ms: Math.round(performance.now() - lastSelect.startTime),
    });
  } catch {
    /* ignore */
  }
};

/** Sampled TTFB for one pano fetch (Resource Timing). */
export const reportPanoTtfb = (url) => {
  if (!enabled || !sampled()) return;
  try {
    const entries = performance.getEntriesByName(url);
    const e = entries[entries.length - 1];
    if (e && e.responseStart && e.startTime) {
      report({
        event: 'ttfb',
        ms: Math.round(e.responseStart - e.startTime),
        host: new URL(url, window.location.href).host,
      });
    }
  } catch {
    /* ignore */
  }
};

/* ---- reporting ------------------------------------------------------- */

function report(payload) {
  if (!sampled()) return;
  pending.push({ ...payload, t: Date.now() });
  if (!flushTimer) {
    flushTimer = setTimeout(flush, 10000);
  }
}

function flush() {
  flushTimer = null;
  if (!pending.length || typeof navigator === 'undefined') return;
  const batch = pending.splice(0, pending.length);
  try {
    const blob = new Blob([JSON.stringify(batch)], {
      type: 'application/json',
    });
    navigator.sendBeacon(apiUrl('/api/metrics/perf'), blob);
  } catch {
    /* metrics must never break the app */
  }
}
