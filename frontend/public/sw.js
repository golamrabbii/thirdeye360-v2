/* ThirdEye360 panorama cache service worker.
 *
 * Intercepts GET requests for panorama JPEGs and serves them cache-first
 * (the images are immutable — the URL identifies the content). Panorama
 * bytes therefore survive across sessions and reconnects: revisiting a
 * street costs zero network.
 *
 * Eviction: Cache Storage has no size management, so an LRU index is kept
 * in the cache itself (key `__lru__`) and the oldest-touched entries are
 * deleted once the total exceeds the cap.
 *
 * Kill switch: append `?sw=off` to any URL to bypass the worker for it.
 */

const VERSION = 'v1';
const CACHE_NAME = `pano-images-${VERSION}`;
const LRU_KEY = '__lru__';

// Default cap: 350 MB (the registrar lowers it on iOS/Safari via message).
let capBytes = 350 * 1024 * 1024;

/* A pano URL: /track{N}/{id}[_variant].jpg on any image host (r2-proxy,
 * StaticFiles mounts, r2.dev). Nothing else (tiles, JSON, HTML) matches. */
const PANO_RE = /\/(?:api\/)?(?:api\/)?track\d+\/[^/?#]+\.jpg$/i;

function isCacheable(request, url) {
  if (request.method !== 'GET') return false;
  if (url.search.includes('sw=off')) return false;
  if (request.headers.has('range')) return false; // let partials pass through
  return PANO_RE.test(url.pathname);
}

/* ---- LRU index ------------------------------------------------------- */
/* All read-modify-write cycles are serialized through one promise chain so
 * concurrent tabs/SW events can't corrupt the index. */
let chain = Promise.resolve();
const serialized = (fn) => {
  chain = chain.then(fn).catch(() => {});
  return chain;
};

let flushTimer = null;
let indexDirty = false;
let index = { order: [], size: {} }; // order: oldest touch first

async function readIndex(cache) {
  const stored = await cache.match(LRU_KEY);
  if (!stored) return { order: [], size: {} };
  try {
    return await stored.json();
  } catch {
    return { order: [], size: {} };
  }
}

async function writeIndex(cache) {
  await cache.put(LRU_KEY, new Response(JSON.stringify(index)));
}

function scheduleFlush() {
  indexDirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (!indexDirty) return;
    indexDirty = false;
    serialized(async () => {
      const cache = await caches.open(CACHE_NAME);
      await writeIndex(cache);
      await evict(cache);
    });
  }, 1500);
}

async function evict(cache) {
  let total = 0;
  for (const url of index.order) total += index.size[url] || 0;
  while (total > capBytes && index.order.length > 0) {
    const oldest = index.order.shift();
    total -= index.size[oldest] || 0;
    delete index.size[oldest];
    await cache.delete(oldest);
  }
}

function touch(url, bytes) {
  serialized(async () => {
    const i = index.order.indexOf(url);
    if (i >= 0) index.order.splice(i, 1);
    index.order.push(url);
    if (bytes != null) index.size[url] = bytes;
    scheduleFlush();
  });
}

/* ---- fetch ----------------------------------------------------------- */

self.addEventListener('fetch', (event) => {
  let url;
  try {
    url = new URL(event.request.url);
  } catch {
    return;
  }
  if (!isCacheable(event.request, url)) return;
  event.respondWith(cacheFirst(event.request, url.href));
});

async function cacheFirst(request, url) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const hit = await cache.match(url);
    if (hit) {
      touch(url); // refresh recency
      return hit;
    }
    const res = await fetch(request);
    if (res && res.ok && (res.type === 'cors' || res.type === 'basic')) {
      const size = Number(res.headers.get('content-length')) || 0;
      await cache.put(url, res.clone());
      touch(url, size);
      return res;
    }
    return res;
  } catch (err) {
    // Network failure and nothing cached — surface a minimal 504
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

/* ---- lifecycle ------------------------------------------------------- */

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith('pano-images-') && n !== CACHE_NAME)
          .map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

/* ---- control messages ------------------------------------------------ */

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  const reply = event.ports && event.ports[0];
  if (msg.type === 'config' && msg.capMB > 0) {
    capBytes = msg.capMB * 1024 * 1024;
    serialized(async () => {
      const cache = await caches.open(CACHE_NAME);
      index = await readIndex(cache);
      await evict(cache);
      await writeIndex(cache);
    });
  } else if (msg.type === 'purge') {
    serialized(async () => {
      await caches.delete(CACHE_NAME);
      index = { order: [], size: {} };
      reply && reply.postMessage({ ok: true });
    });
  } else if (msg.type === 'stats') {
    serialized(async () => {
      const cache = await caches.open(CACHE_NAME);
      index = await readIndex(cache);
      let total = 0;
      for (const v of Object.values(index.size)) total += v;
      reply &&
        reply.postMessage({
          entries: index.order.length,
          bytes: total,
          capBytes,
        });
    });
  }
});
