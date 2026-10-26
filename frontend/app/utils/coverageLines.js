/**
 * Coverage trajectory lines.
 *
 * The vector tiles only expose capture POINTS, so street trajectories are
 * built client-side: fetch the full FeatureCollection once per session,
 * group the points per track, order them by frame number and emit LineStrings.
 *
 * The visual design (colors/widths) lives in MapComponent's maplibre layers —
 * this module only produces the geometry + a point index for picking.
 */
import { API_BASE_URL } from '../config/api';

let sessionCache = null; // { lines, pointsByTrack }
let sessionCachePromise = null; // in-flight fetch (dedupes parallel callers)

const ROUGH_M_PER_DEG_LAT = 111_320;

/** Rough ground distance (m) between two lng/lat points. */
const roughDistanceM = (lng1, lat1, lng2, lat2) => {
  const dLat = (lat2 - lat1) * ROUGH_M_PER_DEG_LAT;
  const dLng =
    (lng2 - lng1) *
    ROUGH_M_PER_DEG_LAT *
    Math.max(0.1, Math.cos((lat1 * Math.PI) / 180));
  return Math.hypot(dLat, dLng);
};

/** Break long raw tracks into separate lines at implausible jumps (>500m). */
const MAX_SEGMENT_GAP_M = 500;

/**
 * Fetch (once per session) and build:
 *   lines        — FeatureCollection of LineStrings, one per continuous run
 *   pointsByTrack— Map<trackId, [{ lng, lat, properties }]> ordered by frame
 * Returns null when the backend has no data yet (local dev setups).
 */
export async function fetchCoverageLines() {
  if (sessionCache) return sessionCache;
  // A caller during an in-flight fetch shares it instead of re-requesting.
  if (!sessionCachePromise) {
    sessionCachePromise = fetchAndBuild().finally(() => {
      sessionCachePromise = null; // a failed fetch may be retried
    });
  }
  return sessionCachePromise;
}

async function fetchAndBuild() {
  const res = await fetch(`${API_BASE_URL}/api/features/all-images`);
  if (!res.ok) return null;
  const fc = await res.json();
  if (!fc || !Array.isArray(fc.features) || fc.features.length === 0) {
    return null;
  }

  // Group by track
  const byTrack = new Map();
  for (const feature of fc.features) {
    const id = String(feature?.properties?.id ?? '');
    const match = id.match(/^(\d+)_(\d+)$/);
    if (!match) continue;
    const coords = feature.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const track = match[1];
    if (!byTrack.has(track)) byTrack.set(track, []);
    byTrack.get(track).push({
      num: parseInt(match[2], 10),
      lng: coords[0],
      lat: coords[1],
      properties: feature.properties,
    });
  }

  // Order per track and emit line runs (breaking at big gaps)
  const lineFeatures = [];
  const pointsByTrack = new Map();

  for (const [track, points] of byTrack) {
    points.sort((a, b) => a.num - b.num);
    pointsByTrack.set(track, points);

    let run = [];
    const flush = () => {
      if (run.length >= 2) {
        lineFeatures.push({
          type: 'Feature',
          properties: { track },
          geometry: { type: 'LineString', coordinates: run.map((p) => [p.lng, p.lat]) },
        });
      }
      run = [];
    };

    let prev = null;
    for (const point of points) {
      if (
        prev &&
        roughDistanceM(prev.lng, prev.lat, point.lng, point.lat) >
          MAX_SEGMENT_GAP_M
      ) {
        flush();
      }
      run.push(point);
      prev = point;
    }
    flush();
  }

  sessionCache = {
    lines: { type: 'FeatureCollection', features: lineFeatures },
    pointsByTrack,
  };
  return sessionCache;
}

/**
 * Nearest capture point on a track to the given click location.
 * Returns { lng, lat, properties } or null.
 */
export function nearestPointOnTrack(pointsByTrack, track, lng, lat) {
  const points = pointsByTrack?.get(String(track));
  if (!points || points.length === 0) return null;

  let best = null;
  let bestDist = Infinity;
  for (const point of points) {
    const d = roughDistanceM(lng, lat, point.lng, point.lat);
    if (d < bestDist) {
      bestDist = d;
      best = point;
    }
  }
  return best;
}
