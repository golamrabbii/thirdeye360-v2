# ThirdEye360 v2 — Deployment Package

Self-contained deployment copy of backend (FastAPI) + frontend (Next.js).
Created 2026-10-25 from `backend/` and `frontend_v2/`.

## Production topology (coexists with v1 on streetview.bmapsbd.com)

| What | Public URL | Internal |
|---|---|---|
| v1 frontend (untouched) | `streetview.bmapsbd.com/` | `localhost:8019` |
| v2 frontend | `streetview.bmapsbd.com/v2` | Next.js on **port 3005** (`basePath: "/v2"`) |
| v2 backend | `streetview.bmapsbd.com/api/api/...` (same public shape as v1) | FastAPI on the port nginx's `location /api/` points at (**8002** in current nginx) |

**Backend routing contract (2026-11-02):** `api.py` creates the app with
`FastAPI()` — NO `root_path`. nginx's `location /api/` uses a trailing-slash
`proxy_pass`, which strips one `/api/`; the app therefore serves its declared
paths (`/api/features`, `/api/r2-proxy/{key}`, ...) directly. Public URLs keep
the doubled shape `/api/api/...` (v1's existing contract) — both frontends
append `/api/...` to a base ending in `/api`.

The frontend `.env.production` is `https://streetview.bmapsbd.com/api` — so no
`/api/v2` nginx block exists or is needed.

When v2 replaces v1 entirely: remove `basePath` from `next.config.mjs`,
rebuild, repoint `location /` to Next. `location /api/` already points at v2.

## Backend — server setup

```bash
cd backend
python3 -m venv venv                 # do NOT copy a venv between machines (absolute paths break)
./venv/bin/pip install -r requirements.txt
./venv/bin/python run_api.py         # port from API_PORT env (default 8001)
```

System requirements: Python 3.12+, PostgreSQL (restore the `third_eye` database),
`ffmpeg` and `exiftool` if the upload/blur features are used.
`.env` holds DB / R2 credentials — transfer it manually, never commit it.
Runtime dirs (`tmp/`, `logs/`) are created automatically on first run.

## Frontend — build & run

`next.config.mjs` has `basePath: "/v2"`; `.env.production` holds the API base
`https://streetview.bmapsbd.com/api`. Both committed — nothing to fill in.
**Any env/config change requires a rebuild** (`NEXT_PUBLIC_*` and basePath are
baked in at build time).

```bash
cd frontend
nvm use            # Node 22 (see .nvmrc)
npm ci
npm run build
PORT=3005 npm start
```

## nginx — NO v2-specific block needed

The existing config already works as-is:
- `location /v2` → `192.168.10.105:3005` (frontend; keep the /v2 prefix — no trailing slash on proxy_pass)
- `location /api/` → `192.168.10.105:8002/` (backend; trailing slash strips one /api/ — required)
- `location /` → v1, untouched

Optional niceties: `location = /v2 { return 301 /v2/; }`, and
`proxy_set_header Host $host;` in the /v2 block.

## Data files & this repo

`.gitignore` keeps secrets and oversized files OUT of git. After cloning on a
server, copy these from the project machine (they are not in the repo):

- `backend/features.geojson`  (~318 MB — GitHub rejects files > 100 MB)
- `backend/.env`              (live credentials)
- `backend/uploads/` content  (user panoramas, if any must be preserved)

`tiledata/`, `temp_uploads/`, `r2_cache/` are gitignored but recreated/
populated automatically at runtime.

## Notes

- **Env precedence gotcha:** in a Next.js build `.env.local` WINS over
  `.env.production`. This repo deliberately contains NO `.env.local` — never
  add one to this folder, or a build will silently bake dev values.
- **`npm run dev` does NOT read `.env.production`** (production-only file).
  Dev mode falls back to `http://localhost:8001` (hardcoded in
  `app/config/api.js`) unless a `.env.local` exists. If you must run dev mode
  on the server, create `.env.local` with the SAME production values as
  `.env.production` (keep them in sync — see the precedence gotcha), then
  restart the dev server. For serving users, always use
  `npm run build && PORT=3005 npm start`.
- Over plain-HTTP access the app uses the execCommand clipboard fallback;
  behind HTTPS (this domain) the native clipboard API is used everywhere.
- `/health` is at the app ROOT (`/health`) — for uptime probes target
  `http://127.0.0.1:<backend-port>/health` directly (through nginx it would
  need `https://streetview.bmapsbd.com/api/health`, which does not exist —
  only `/api/api/...` app routes are public).
