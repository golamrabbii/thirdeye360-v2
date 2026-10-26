/**
 * Street View-style timeline: capture dates covering a point.
 *
 * Backed by GET /api/timeline?lat&lng&radius — one entry per capture DAY
 * with the frame closest to the point. Small LRU cache: stepping a few
 * frames re-uses the same timeline without refetching.
 */

import { apiUrl } from '../config/api';

const CACHE = new Map(); // "lat,lng,r" -> dates array (latest first)
const CACHE_MAX = 12;

export async function fetchTimeline(lat, lng, radius = 25) {
  const key = `${Number(lat).toFixed(6)},${Number(lng).toFixed(6)},${radius}`;
  if (CACHE.has(key)) {
    const v = CACHE.get(key);
    CACHE.delete(key);
    CACHE.set(key, v); // refresh LRU position
    return v;
  }

  const res = await fetch(
    apiUrl(
      `/api/timeline?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(
        lng
      )}&radius=${encodeURIComponent(radius)}`
    )
  );
  if (!res.ok) throw new Error(`Timeline request failed (${res.status})`);
  const data = await res.json();
  const dates = Array.isArray(data?.dates) ? data.dates : [];
  if (data?.status !== 'success') throw new Error('Timeline unavailable');

  if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
  CACHE.set(key, dates);
  return dates;
}
