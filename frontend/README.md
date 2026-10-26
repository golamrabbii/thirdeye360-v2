# ThirdEye360 — Frontend v2

Redesigned frontend for the ThirdEye360 geospatial 360° street-view platform, built
from the static design mockups (`home.html`, `page2.html`, `page3.html`) in this
folder. Functionality is ported 1:1 from `../frontend_modified`; the visual chrome
is the new emerald/teal glassmorphism design.

## Stack

- Next.js 14 (app router) · React 18 · JavaScript
- MapLibre GL via `react-map-gl` (Barikoi styles + ThirdEye360 vector tiles)
- Pannellum 2.5.6 (CDN) for the 360° panorama viewer
- Redux Toolkit (panorama view positions, UI control visibility)
- Tailwind CSS (brand palette + `glass-panel` utilities in `app/globals.css`)

## Run

```bash
nvm use            # reads .nvmrc (Node 22) — REQUIRED, system Node is v16
npm install
npm run dev        # http://localhost:3000 (auto-increments if 3000 is busy —
                   # a Martin tileserver occupies :3000 on this machine)
```

`npm run dev/build/start` run a Node guard first (`scripts/check-node.js`): on
Node < 18.17 they stop with exact fix instructions instead of Next's cryptic
version error.

## What's implemented

| Design | Feature |
|---|---|
| `home.html` | Guest map view: header w/ Sign In, Quick Guide bar, floating search + Quick-Jump badges, live-coords guidance card, zoom/compass/location/fullscreen toolbox, Layer Controls card (Coverage / Delete / Polygon Crop / POI toggles) |
| `page2.html` | Logged-in state: Upload 360° button + profile pill with sign-out dropdown |
| `page3.html` → `/upload` | ZIP uploader: zip-only chunked resumable upload to `/api/uploads/*` (`init` → `PUT` 16 MB chunks → `complete`, 2–3 chunks in flight, per-chunk auto-retry, one file at a time). Pause/resume survives reloads via localStorage sessions (`app/utils/chunkedUpload.js`); archives are stored as-is in the backend uploads folder — no processing |
| Viewer | Pannellum equirectangular viewer, PREV/NEXT hotspots, HD toggle, generate-POI, POI drawer, minimap, share links with exact view state (`?id&yaw&pitch&hfov`), auto-tour, keyboard nav |
| Map modes | Point delete (PIN-gated batch delete), polygon crop delete (verify → PIN 2017 → delete), POI mode with sidebar |

Backend/API base is `NEXT_PUBLIC_API_URL` in `.env.local` (default `http://192.168.10.105:8001`).
