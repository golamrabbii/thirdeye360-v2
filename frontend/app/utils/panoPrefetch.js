/**
 * Panorama prefetch + feature-metadata cache.
 *
 * Two warming paths feed the browser cache ahead of clicks:
 *  - map-idle prefetch warms the nearest visible points (comp, plus HD for
 *    the closest few) as the user pans,
 *  - neighbor prefetch runs after every image load so stepping along a track
 *    crossfades instantly.
 *
 * The metadata endpoint (/api/features/:id) is optional: when it is absent
 * the neighbour URLs are derived from the current image's own URL pattern
 * (same track route, id swapped), so warming works against every deploy.
 */

import { API_BASE_URL as API_BASE } from '../config/api';
import {
  pickCompUrl,
  pickHighUrl,
  neighborCompUrls,
  swapIdInUrl,
} from './panoUrl';
import { neighborsWithin } from './trackManifest';

/**
 * Sliding-window prefetch (ported from thirdeye360-next): warm the ±`radius`
 * compressed frames around the current one, nearest-first, alternating
 * directions (+1, -1, +2, -2, …). Bytes land in Cache Storage (persistent);
 * the two adjacent frames are additionally pinned as decoded in the engine.
 */
export const prefetchWindow = async (properties, radius = 4) => {
  if (!properties || typeof window === 'undefined' || connectionRestricted()) return;
  const curId = properties.id;
  const compUrl = pickCompUrl(properties);

  // Exact, gap-safe order from the track manifest; fall back to the chain
  // properties (±1) from the tile metadata when the manifest is unavailable.
  const around = await neighborsWithin(curId, { back: radius, fwd: radius });
  let ids;
  if (around) {
    ids = [];
    for (let d = 0; d < radius; d++) {
      if (around.fwd[d]) ids.push(around.fwd[d]);
      if (around.back[d]) ids.push(around.back[d]);
    }
  } else {
    ids = [properties.next_id, properties.previous_id].filter(Boolean);
  }

  await Promise.all(
    ids.map((id) => cachePano(swapIdInUrl(compUrl, curId, id)))
  );
};

/**
 * Sliding-window URL sets (ported from thirdeye360-next): `pinned` = the two
 * adjacent frames, `windowUrls` = every frame within ±`radius` (including
 * the current one). All window frames are decoded ahead of time so steps
 * are pure GPU work; frames outside the window are evicted.
 */
export const windowUrls = async (properties, radius = 4) => {
  if (!properties) return { pinned: [], windowUrls: [] };
  const curId = properties.id;
  const curUrl = pickCompUrl(properties);
  const toUrl = (id) =>
    id === curId ? curUrl : swapIdInUrl(curUrl, curId, id);

  const around = await neighborsWithin(curId, { back: radius, fwd: radius });
  if (!around) {
    const pinned = [properties.next_id, properties.previous_id]
      .map(toUrl)
      .filter(Boolean);
    const windowUrls = [...pinned, curUrl].filter(Boolean);
    return { pinned, windowUrls };
  }
  const pinned = [
    ...around.fwd.slice(0, 1),
    ...around.back.slice(0, 1),
  ]
    .map(toUrl)
    .filter(Boolean);
  const windowUrls = [
    ...around.fwd,
    ...around.back,
    curUrl,
  ]
    .map(toUrl)
    .filter(Boolean);
  return { pinned, windowUrls };
};

// URL resolution lives in panoUrl.js; re-exported here for existing callers.
export { pickCompUrl, pickHighUrl, neighborCompUrls };

const FEATURE_CACHE = new Map(); // id -> properties
const FEATURE_CACHE_MAX = 60;
const PREFETCHED_URLS = new Set(); // comp tier
const PREFETCHED_HD_URLS = new Set(); // HD tier

export const getCachedFeature = (id) => (id ? FEATURE_CACHE.get(String(id)) || null : null);

const cacheFeature = (id, properties) => {
  const key = String(id);
  if (FEATURE_CACHE.has(key)) FEATURE_CACHE.delete(key);
  FEATURE_CACHE.set(key, properties);
  if (FEATURE_CACHE.size > FEATURE_CACHE_MAX) {
    FEATURE_CACHE.delete(FEATURE_CACHE.keys().next().value);
  }
};

/**
 * Fetch feature properties by id, transparently served from cache when warm.
 * @returns {Promise<Object|null>} feature properties or null
 */
export const fetchFeatureCached = async (featureId) => {
  const key = String(featureId || '');
  if (!key) return null;

  const cached = FEATURE_CACHE.get(key);
  if (cached) {
    // Refresh LRU position
    FEATURE_CACHE.delete(key);
    FEATURE_CACHE.set(key, cached);
    return cached;
  }

  try {
    const res = await fetch(`${API_BASE}/api/features/${encodeURIComponent(key)}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.properties) return null;
    cacheFeature(key, data.properties);
    return data.properties;
  } catch {
    return null;
  }
};

/* ---- HD downloads run one-at-a-time in a background lane so they never
 * ---- compete with the comp image the user is waiting on. */
const HD_QUEUE = [];
let hdPumping = false;

const pumpHdQueue = () => {
  if (hdPumping || HD_QUEUE.length === 0) return;
  hdPumping = true;
  const url = HD_QUEUE.shift();
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';
  img.onload = img.onerror = () => {
    hdPumping = false;
    // Breathe between HD downloads; comp prefetches always go first.
    setTimeout(pumpHdQueue, 2000);
  };
  img.src = url;
};

/**
 * Warm the browser image cache for a single URL (deduped, fire-and-forget).
 * `quality: 'hd'` routes through the throttled background lane.
 * CORS mode matches the GL engine (crossOrigin='anonymous') so the engine's
 * texture loads hit the same cached response instead of re-downloading.
 */
export const prefetchImage = (url, { quality = 'comp' } = {}) => {
  if (!url || typeof window === 'undefined') return;
  const seen = quality === 'hd' ? PREFETCHED_HD_URLS : PREFETCHED_URLS;
  if (seen.has(url)) return;
  seen.add(url);
  if (quality === 'hd') {
    HD_QUEUE.push(url);
    pumpHdQueue();
    return;
  }
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';
  img.onerror = () => seen.delete(url); // allow retry later
  img.src = url;
};

export const prefetchFeatureImage = (properties, opts) => {
  if (!properties) return;
  if (opts?.quality === 'hd') prefetchImage(pickHighUrl(properties), opts);
  else prefetchImage(pickCompUrl(properties), opts);
};

/* Persistent pano cache (shared with /public/sw.js) */
const SW_CACHE_NAME = 'pano-images-v1';
const CACHEPANO_DONE = new Set();
const CACHEPANO_INFLIGHT = new Map();

/**
 * Warm a pano into the persistent Cache Storage when available (survives
 * sessions — the service worker serves future requests from it), falling
 * back to the plain HTTP-cache warm. Deduplicated: a URL is only ever
 * fetched once (concurrent callers share one promise). `signal` aborts the
 * network fetch (aborted URLs become eligible for a later retry).
 * Never throws; resolves `true` when warmed, `false` on failure/abort.
 */
export const cachePano = (url, { signal } = {}) => {
  if (!url || typeof window === 'undefined') return Promise.resolve(false);
  if (CACHEPANO_DONE.has(url)) return Promise.resolve(true);
  if (CACHEPANO_INFLIGHT.has(url)) return CACHEPANO_INFLIGHT.get(url);

  const p = (async () => {
    try {
      if (typeof caches !== 'undefined' && window.isSecureContext) {
        const cache = await caches.open(SW_CACHE_NAME);
        if (await cache.match(url)) return true;
        const res = await fetch(url, { signal });
        if (res.ok && (res.type === 'cors' || res.type === 'basic')) {
          await cache.put(url, res);
        }
      } else {
        prefetchImage(url);
      }
      CACHEPANO_DONE.add(url);
      return true;
    } catch {
      // warming must never break the app — aborted/failed URLs may retry later
      CACHEPANO_DONE.delete(url);
      return false;
    } finally {
      CACHEPANO_INFLIGHT.delete(url);
    }
  })();
  CACHEPANO_INFLIGHT.set(url, p);
  return p;
};

/**
 * Compass bearing (degrees, 0-360) from point a to point b.
 */
const bearingBetween = (aLat, aLng, bLat, bLng) => {
  const p1 = (aLat * Math.PI) / 180;
  const p2 = (bLat * Math.PI) / 180;
  const dl = ((bLng - aLng) * Math.PI) / 180;
  const x = Math.sin(dl) * Math.cos(p2);
  const y =
    Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(x, y) * 180) / Math.PI;
};

const pointOf = (p) => ({
  lat: p?.latitude_snapped ?? p?.latitude_original,
  lng: p?.longitude_snapped ?? p?.longitude_original,
});

/**
 * Yaw that faces ALONG the street (direction of travel) for a feature:
 * bearing from its previous capture point toward it, or from it toward the
 * next point when no previous exists. Returns null when neither neighbour
 * has usable coordinates (caller falls back to the stored initialYaw).
 */
export const getTravelYaw = async (properties) => {
  if (!properties) return null;
  const cur = pointOf(properties);
  if (cur.lat == null || cur.lng == null) return null;

  const prev = properties.previous_id
    ? await fetchFeatureCached(properties.previous_id)
    : null;
  if (prev) {
    const p = pointOf(prev);
    if (p.lat != null && p.lng != null) {
      return (bearingBetween(p.lat, p.lng, cur.lat, cur.lng) + 360) % 360;
    }
  }

  const next = properties.next_id
    ? await fetchFeatureCached(properties.next_id)
    : null;
  if (next) {
    const n = pointOf(next);
    if (n.lat != null && n.lng != null) {
      return (bearingBetween(cur.lat, cur.lng, n.lat, n.lng) + 360) % 360;
    }
  }

  return null;
};

/**
 * Prefetch images along the track: `depth` frames forward and backward from
 * the given feature (comp tier — the instant tier). Manifest-backed when the
 * track manifest is available (exact, gap-safe ids); otherwise exact depth-1
 * ids from the properties plus numeric guesses. The last-travelled direction
 * gets a wider window (Street View-style directional bias). Never throws.
 */
let travelDirection = 0; // -1 = backwards, +1 = forwards, 0 = unknown

export const noteTravelDirection = (dir) => {
  travelDirection = dir > 0 ? 1 : dir < 0 ? -1 : 0;
};

const connectionRestricted = () => {
  if (typeof navigator === 'undefined' || !navigator.connection) return false;
  const c = navigator.connection;
  return !!c.saveData || c.effectiveType === '2g' || c.effectiveType === 'slow-2g';
};

export const prefetchNeighbors = async (properties, depth = 2, opts = {}) => {
  if (!properties || typeof window === 'undefined' || connectionRestricted()) return;
  const curId = properties.id;
  const compUrl = pickCompUrl(properties);

  const warm = (id) => cachePano(swapIdInUrl(compUrl, curId, id));

  // Manifest path: exact ids, one extra frame on the travel side
  const around = await neighborsWithin(curId, {
    fwd: depth + (travelDirection > 0 ? 1 : 0),
    back: depth + (travelDirection < 0 ? 1 : 0),
  });
  if (around) {
    around.fwd.forEach((id) => warm(id));
    around.back.forEach((id) => warm(id));
    return;
  }

  const walk = async (startId, step) => {
    let id = startId;
    for (let hop = 0; hop < depth && id; hop++) {
      const props = await fetchFeatureCached(id);
      if (props) {
        prefetchFeatureImage(props);
        id = step > 0 ? props.next_id : props.previous_id;
        continue;
      }
      // No manifest or metadata — warm only the id the chain actually knows;
      // guessing numeric neighbours calls frames that may be gaps.
      warm(id);
      break;
    }
  };

  if (properties.next_id) walk(properties.next_id, +1);
  if (properties.previous_id) walk(properties.previous_id, -1);
};

// Bulk track-warming is OFF by default. On an origin that streams every
// image from R2 (~1.3 s each), downloading even a few dozen frames floods
// the backend threadpool and delays the images the user is actively
// requesting. Only enable it once images are served from a fast local or
// edge cache, and keep the window small.
const WARM_TRACK_WINDOW = 12; // frames per side
const WARM_TRACK_MAX = 24; // total frames per warm pass

/**
 * Warm the comp tier for the frames around the current one along the track
 * (bounded, deduped). Opt-in via NEXT_PUBLIC_WARM_TRACK=on; skipped
 * entirely on metered/slow connections.
 */
export const warmTrack = async (properties, { halfWindow = WARM_TRACK_WINDOW } = {}) => {
  if (process.env.NEXT_PUBLIC_WARM_TRACK !== 'on') return;
  if (!properties?.id || typeof window === 'undefined' || connectionRestricted()) return;
  const around = await neighborsWithin(properties.id, {
    back: halfWindow,
    fwd: halfWindow,
  });
  if (!around) return;
  const curId = properties.id;
  const compUrl = pickCompUrl(properties);
  const ordered =
    travelDirection >= 0
      ? [...around.fwd, ...around.back]
      : [...around.back, ...around.fwd];
  ordered.slice(0, WARM_TRACK_MAX).forEach((id) => {
    cachePano(swapIdInUrl(compUrl, curId, id));
  });
};
