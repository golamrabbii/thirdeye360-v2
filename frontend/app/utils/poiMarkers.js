/**
 * Google-style roadside POI markers for the panorama viewer.
 *
 * Pipeline per selected image:
 *   1. nearby places via the backend proxy (the Barikoi key stays
 *      server-side), LRU-cached per feature id;
 *   2. roadside filter — the track polyline (the vehicle drove the road)
 *      acts as the road corridor, so a park 300 m inside a block never
 *      becomes a floating icon;
 *   3. hotspot configs: yaw = bearing from the capture point relative to
 *      the travel direction (0 = straight ahead — the same frame the
 *      ground arrows use), pitch = the elevation of a 2.4 m camera
 *      looking at the spot.
 */
import { apiUrl } from '../config/api';
import { fetchCoverageLines } from './coverageLines';
import { getTravelYaw } from './panoPrefetch';

const ROUGH_M_PER_DEG_LAT = 111_320;

const EYE_HEIGHT_M = 2.4;
const PITCH_MIN_DEG = -15;
const PITCH_MAX_DEG = -1.5;
const DIST_MIN_M = 3; // closer than this the icon sits at the camera's feet
const DIST_MAX_M = 60; // beyond this it is too far to read in the pano
const ROADSIDE_MAX_M = 40; // corridor width from the track line
const MAX_MARKERS = 10;
// Utility poles line every street — real, but pure clutter as icons.
const HIDDEN_SUBTYPES = ['pole'];

const POI_CACHE = new Map(); // feature id -> markers
const POI_CACHE_MAX = 40;

const distanceM = (lng1, lat1, lng2, lat2) => {
  const dLat = (lat2 - lat1) * ROUGH_M_PER_DEG_LAT;
  const dLng =
    (lng2 - lng1) *
    ROUGH_M_PER_DEG_LAT *
    Math.max(0.1, Math.cos((lat1 * Math.PI) / 180));
  return Math.hypot(dLat, dLng);
};

const bearingDeg = (lat1, lng1, lat2, lng2) => {
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const x =
    Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  const y = Math.sin(dl) * Math.cos(p2);
  return (Math.atan2(y, x) * 180) / Math.PI;
};

const capturePointOf = (properties) => ({
  lat: properties?.latitude_snapped ?? properties?.latitude_original,
  lng: properties?.longitude_snapped ?? properties?.longitude_original,
});

/** Point-to-segment distance in meters on a locally flat projection. */
const distToSegmentM = (pLng, pLat, aLng, aLat, bLng, bLat) => {
  const mLon = ROUGH_M_PER_DEG_LAT * Math.max(0.1, Math.cos((aLat * Math.PI) / 180));
  const px = (pLng - aLng) * mLon;
  const py = (pLat - aLat) * ROUGH_M_PER_DEG_LAT;
  const bx = (bLng - aLng) * mLon;
  const by = (bLat - aLat) * ROUGH_M_PER_DEG_LAT;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return Math.hypot(px, py);
  let t = (px * bx + py * by) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - t * bx, py - t * by);
};

/** Closest distance from the POI to any segment of the track polyline. */
const minDistanceToTrack = (lng, lat, trackPoints) => {
  if (!Array.isArray(trackPoints) || trackPoints.length === 0) return Infinity;
  let best = Infinity;
  for (let i = 0; i < trackPoints.length - 1; i += 1) {
    const a = trackPoints[i];
    const b = trackPoints[i + 1];
    const d = distToSegmentM(lng, lat, a.lng, a.lat, b.lng, b.lat);
    if (d < best) best = d;
  }
  const last = trackPoints[trackPoints.length - 1];
  return Math.min(
    best,
    distanceM(lng, lat, last.lng, last.lat)
  );
};

/** Track polyline for this feature's track (session-cached). */
async function getTrackPoints(featureId) {
  try {
    const track = String(featureId).split('_')[0];
    const session = await fetchCoverageLines();
    return session?.pointsByTrack?.get(track) || null;
  } catch {
    return null;
  }
}

/**
 * Markers for one capture frame: [{ id, yaw, pitch, poi }].
 * Never throws — any failure yields no markers for that frame.
 */
export async function getPoiMarkers(properties, travelYaw = null) {
  const key = String(properties?.id ?? '');
  if (!key) return [];
  const hit = POI_CACHE.get(key);
  if (hit) {
    // Refresh LRU position
    POI_CACHE.delete(key);
    POI_CACHE.set(key, hit);
    return hit;
  }

  const cur = capturePointOf(properties);
  if (cur.lat == null || cur.lng == null) return [];

  try {
    const [data, track, captureBearing] = await Promise.all([
      fetch(
        apiUrl(`/api/pois/nearby?lat=${cur.lat}&lon=${cur.lng}&radius_km=0.5&limit=10`)
      )
        .then((r) => (r.ok ? r.json() : { places: [] }))
        .catch(() => ({ places: [] })),
      getTrackPoints(key),
      travelYaw != null
        ? Promise.resolve(travelYaw)
        : getTravelYaw(properties).catch(() => null),
    ]);

    const withDist = [];
    for (const place of data?.places || []) {
      // Accept both the normalized proxy shape (lat/lon) and the raw
      // Barikoi shape (latitude/longitude).
      const lat = place.lat ?? place.latitude;
      const lon = place.lon ?? place.longitude;
      if (lat == null || lon == null) continue;
      const sub = String(place.sub_category || '').toLowerCase();
      if (HIDDEN_SUBTYPES.some((s) => sub.includes(s))) continue;

      const dist = distanceM(cur.lng, cur.lat, lon, lat);
      if (dist < DIST_MIN_M || dist > DIST_MAX_M) continue;

      // Roadside check: without track data (dev with no coverage data)
      // anything in range passes; with track data the corridor decides.
      if (track && minDistanceToTrack(lon, lat, track) > ROADSIDE_MAX_M) {
        continue;
      }
      withDist.push({ poi: { ...place, lat, lon }, dist });
    }

    withDist.sort((a, b) => a.dist - b.dist);

    const result = withDist.slice(0, MAX_MARKERS).map(({ poi, dist }) => {
      const poiBearing = bearingDeg(cur.lat, cur.lng, poi.lat, poi.lon);
      const yaw = ((poiBearing - captureBearing) % 360 + 360) % 360;
      const pitch = Math.max(
        PITCH_MIN_DEG,
        Math.min(
          PITCH_MAX_DEG,
          -Math.atan2(EYE_HEIGHT_M, Math.max(dist, 1)) * (180 / Math.PI)
        )
      );
      return {
        id: `poi-marker-${poi.id || poi.place_code || `${poi.lat}_${poi.lon}`}`,
        yaw,
        pitch,
        poi: {
          ...poi,
          dist_m: Math.round(dist),
          lat: Number(poi.lat),
          lon: Number(poi.lon),
        },
      };
    });

    POI_CACHE.set(key, result);
    if (POI_CACHE.size > POI_CACHE_MAX) {
      POI_CACHE.delete(POI_CACHE.keys().next().value);
    }
    return result;
  } catch (err) {
    console.error('POI markers failed:', err);
    return [];
  }
}
