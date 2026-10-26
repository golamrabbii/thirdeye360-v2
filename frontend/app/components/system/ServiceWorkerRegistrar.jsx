'use client';

import { useEffect } from 'react';

/**
 * Registers the panorama cache service worker (/public/sw.js).
 *
 * STRICTLY OPT-IN, on every host and in every mode: the worker engages only
 * when NEXT_PUBLIC_SW=on. When it is not enabled, any previously-registered
 * worker on this origin is unregistered and its pano caches are purged.
 *
 * Why the cleanup matters: service worker registrations are per-origin and
 * outlive dev-server restarts and env changes. A worker left behind by an
 * earlier build keeps intercepting pano fetches on that origin forever —
 * seen as image requests queuing with zero backend traffic and then
 * replaying in one burst on http://0.0.0.0:3001 while localhost (no
 * registration) was smooth.
 */
export default function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    const enabled = process.env.NEXT_PUBLIC_SW === 'on';

    const disable = async () => {
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(
          regs
            .filter((r) => (r.active?.scriptURL || '').endsWith('/sw.js'))
            .map((r) => r.unregister())
        );
        const keys = await caches.keys();
        await Promise.all(
          keys
            .filter((k) => k.startsWith('pano-images-'))
            .map((k) => caches.delete(k))
        );
      } catch {
        // cleanup is best-effort — never block the app on it
      }
    };

    const register = () => {
      navigator.serviceWorker
        .register('/sw.js')
        .then(async () => {
          try {
            if (navigator.storage && navigator.storage.persist) {
              await navigator.storage.persist();
            }
            // Smaller budget on iOS/Safari — quota eviction is aggressive
            const isApple =
              /iP(hone|ad|od)/.test(navigator.userAgent) ||
              (/Macintosh/.test(navigator.userAgent) && 'ontouchend' in document);
            if (isApple) {
              const reg = await navigator.serviceWorker.getRegistration();
              reg?.active?.postMessage({ type: 'config', capMB: 150 });
            }
          } catch {
            // persistence/quota hints are best-effort
          }
        })
        .catch(() => {
          // SW is an enhancement — never block the app on it
        });
    };

    if (!enabled) {
      // Wait for load so cleanup never races the app's boot fetches.
      if (document.readyState === 'complete') {
        disable();
      } else {
        window.addEventListener('load', disable, { once: true });
        return () => window.removeEventListener('load', disable);
      }
      return;
    }

    if (document.readyState === 'complete') {
      register();
    } else {
      window.addEventListener('load', register);
      return () => window.removeEventListener('load', register);
    }
  }, []);

  return null;
}
