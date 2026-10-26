/**
 * Track manifest cache — ordered per-track frame lists for exact neighbor
 * walking and background warming.
 *
 * Backed by `GET /api/tracks/{track}/manifest` (compact form: sequence of
 * [seq, id, lat, lon, yaw]). Falls back gracefully: callers treat a null
 * manifest as "no better information than the numeric id guess".
 */

import { apiUrl } from '../config/api';

const MANIFEST_MAX = 8;
const MANIFESTS = new Map(); // track -> manifest
const INFLIGHT = new Map(); // track -> Promise<manifest|null>

/** Track number for a feature id ("671_6" -> "671"). */
export const trackOf = (featureId) => String(featureId ?? '').split('_')[0] || null;

/**
 * Ordered manifest for a track: { track, ids[], pos: Map(id->index),
 * coords: Map(id->[lat,lon]), yaw: Map(id->yaw) } — or null on failure.
 */
export const manifestFor = async (featureId) => {
  const track = trackOf(featureId);
  if (!track || typeof window === 'undefined') return null;

  const cached = MANIFESTS.get(track);
  if (cached) {
    // Refresh LRU position
    MANIFESTS.delete(track);
    MANIFESTS.set(track, cached);
    return cached;
  }

  if (INFLIGHT.has(track)) return INFLIGHT.get(track);

  const promise = (async () => {
    try {
      const res = await fetch(apiUrl(`/api/tracks/${track}/manifest`), {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (data?.status !== 'success' || !Array.isArray(data.sequence)) return null;

      const manifest = {
        track,
        ids: [],
        pos: new Map(),
        coords: new Map(),
        yaw: new Map(),
      };
      for (const entry of data.sequence) {
        const [seq, id, lat, lon, yaw] = entry;
        manifest.ids.push(id);
        manifest.pos.set(id, manifest.ids.length - 1);
        manifest.coords.set(id, [lat, lon]);
        manifest.yaw.set(id, yaw);
        void seq;
      }
      if (MANIFESTS.size >= MANIFEST_MAX) {
        MANIFESTS.delete(MANIFESTS.keys().next().value);
      }
      MANIFESTS.set(track, manifest);
      return manifest;
    } catch {
      return null;
    } finally {
      INFLIGHT.delete(track);
    }
  })();

  INFLIGHT.set(track, promise);
  return promise;
};

/**
 * Exact neighbor id `step` frames away (+1 = next, -1 = previous) from the
 * manifest, or null when unknown (gap-safe: a missing frame is skipped
 * because the manifest only contains existing frames).
 */
export const neighborId = async (featureId, step) => {
  const manifest = await manifestFor(featureId);
  if (!manifest) return null;
  const pos = manifest.pos.get(String(featureId));
  if (pos === undefined) return null;
  const target = manifest.ids[pos + step];
  return target ?? null;
};

/**
 * Ids within `back` frames behind and `fwd` frames ahead of featureId
 * (nearest first within each side). Null sides when no manifest.
 */
export const neighborsWithin = async (featureId, { back = 0, fwd = 0 } = {}) => {
  const manifest = await manifestFor(featureId);
  if (!manifest) return null;
  const pos = manifest.pos.get(String(featureId));
  if (pos === undefined) return null;
  const ids = manifest.ids;
  return {
    fwd: ids.slice(pos + 1, pos + 1 + fwd),
    back: ids.slice(Math.max(0, pos - back), pos).reverse(),
  };
};

/** Coordinates and stored heading for a frame (from the manifest), if any. */
export const manifestEntry = async (featureId) => {
  const manifest = await manifestFor(featureId);
  if (!manifest) return null;
  const id = String(featureId);
  if (!manifest.pos.has(id)) return null;
  return {
    coords: manifest.coords.get(id),
    yaw: manifest.yaw.get(id),
  };
};
