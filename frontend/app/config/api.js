/**
 * Single source of truth for the backend API base URL.
 *
 * To point the frontend at a different backend, change NEXT_PUBLIC_API_URL
 * in `.env.local` — every API call in the app resolves through this module.
 * The fallback below (localhost:8001) is used only when the env var is absent.
 *
 * Usage:
 *   import { API_BASE_URL, apiUrl } from '@/app/config/api';
 *   fetch(apiUrl(`/api/features/${id}`));
 */
export const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8001'
).replace(/\/+$/, ''); // tolerate a trailing slash in the env value

/** Join the base URL with an endpoint path. */
export const apiUrl = (path = '') =>
  `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;

/**
 * Rewrite absolute API URLs that arrive inside DATA (vector-tile properties,
 * API responses carry absolute image URLs like
 * `https://<host>/api/r2-proxy/track0/0_1.jpg`) so they resolve against the
 * configured base instead. Anything that isn't one of our API paths is
 * returned untouched (e.g. external CDNs).
 */
export const normalizeApiUrl = (url) => {
  if (!url) return url;
  const str = String(url);
  // Match our API paths anywhere in the URL — data URLs sometimes carry a
  // doubled /api/api/ prefix (production reverse-proxy pattern)
  const re = /\/api\/(?:api\/)?(r2-proxy|drive-proxy|features|point-of-interest|generate-poi|images|coverage)(?=\/|\?|$)/;
  const m = str.match(re);
  if (!m) return str;
  const path = str.slice(m.index).replace(/^\/api\/api\//, '/api/');
  return apiUrl(path);
};
