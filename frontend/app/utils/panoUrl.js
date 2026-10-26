/**
 * Panorama URL resolution.
 *
 * The single place that turns feature properties into image URLs and ordered
 * fallback chains. The first candidate is always the property's own
 * (normalized) URL — the authoritative source. Optional extra hosts
 * (NEXT_PUBLIC_IMAGE_CANDIDATE_HOSTS, comma-separated) are appended so a
 * slow/failing host can be skipped via configuration alone.
 */

import { normalizeApiUrl } from '../config/api';

const CANDIDATE_HOSTS = (process.env.NEXT_PUBLIC_IMAGE_CANDIDATE_HOSTS || '')
  .split(',')
  .map((h) => h.trim().replace(/\/+$/, ''))
  .filter(Boolean);

/**
 * Swap the image id inside a URL: `.../671_6_comp.jpg` for id 671_6 becomes
 * `.../671_8_comp.jpg` for id 671_8. Lets us address neighbours (and build
 * optimistic navigation) when only the current feature is known — the
 * neighbour keeps the current image's track route, so the derived URL is
 * always a valid one.
 */
export const swapIdInUrl = (url, fromId, toId) => {
  if (!url || !fromId || !toId || fromId === toId) return null;
  if (!String(url).includes(String(fromId))) return null;
  return String(url).split(String(fromId)).join(String(toId));
};

/** `track671/671_6_comp.jpg` out of any host/route spelling. */
export const extractPanoPath = (url) => {
  const m = String(url || '').match(/(track\d+\/[^/?#]+\.jpg)/i);
  return m ? m[1] : null;
};

/** Original tier URL exactly as it appears in the data (NOT normalized). */
export const rawTierUrl = (properties, tier = 'comp') => {
  if (!properties) return null;
  if (tier === 'high') {
    return properties.r2Url_High || properties.imageUrl_High || null;
  }
  return (
    properties.r2Url_Comp || properties.imageUrl_Comp || properties.imageUrl || null
  );
};

/** Best URL for a tier straight from feature properties (normalized). */
export const pickTierUrl = (properties, tier = 'comp') => {
  const raw = rawTierUrl(properties, tier);
  return raw ? normalizeApiUrl(raw) : null;
};

export const pickCompUrl = (properties) => pickTierUrl(properties, 'comp');

export const pickHighUrl = (properties) => pickTierUrl(properties, 'high');

/**
 * Ordered fallback chain for a tier, deduped:
 *  1. the property's own (normalized) URL — the API origin
 *  2. the URL exactly as the data carries it (usually the prod origin,
 *     https://streetview.bmapsbd.com/api/api/r2-proxy/...) — its path
 *     already points at real bytes, so it is preserved verbatim as the
 *     first fallback when the API origin stalls or dies
 *  3. each NEXT_PUBLIC_IMAGE_CANDIDATE_HOSTS entry, origin-swapped onto the
 *     known-good path. r2-proxy paths only resolve under the doubled
 *     /api/api/ prefix on every host (verified 2026-10-17), so the path is
 *     never re-derived as bare `host/trackN/x.jpg` (that shape 404s).
 */
export const panoUrlCandidates = (properties, tier = 'comp') => {
  const primary = pickTierUrl(properties, tier);
  if (!primary) return [];
  const out = [primary];
  const raw = String(rawTierUrl(properties, tier) || '');
  if (raw && !out.includes(raw)) out.push(raw);
  const baseForSwap = raw || primary;
  const panoPath = extractPanoPath(baseForSwap);
  for (const host of CANDIDATE_HOSTS) {
    if (!panoPath) break;
    let candidate;
    try {
      const u = new URL(baseForSwap);
      candidate = `${host}${u.pathname}`;
    } catch {
      candidate = `${host}/api/api/r2-proxy/${panoPath}`;
    }
    if (!out.includes(candidate)) out.push(candidate);
  }
  return out;
};

/**
 * Comp-tier URLs for the immediate neighbours (depth 1, exact ids from the
 * tile/API properties) — used to keep the GL engine's decoded-texture cache
 * warm so the next step crossfades without a decode stall.
 */
export const neighborCompUrls = (properties) => {
  if (!properties) return [];
  return [properties.next_id, properties.previous_id]
    .map((id) => swapIdInUrl(pickCompUrl(properties), properties.id, id))
    .filter(Boolean);
};
