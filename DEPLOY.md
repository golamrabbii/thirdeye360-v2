# ThirdEye360 v2 — Deployment Package

Self-contained deployment copy of backend (FastAPI) + frontend (Next.js) sources.
Created 2026-10-25 from `backend/` and `frontend_v2/`.

## Layout

```
v2/
├── backend/      FastAPI source + requirements + .env + data (features.geojson, tiledata, uploads, ...)
└── frontend/     Next.js source (no node_modules / .next — install & build on the target)
```

## Backend — server setup

```bash
cd backend
python3 -m venv venv                 # do NOT copy a venv between machines (absolute paths break)
./venv/bin/pip install -r requirements.txt
./venv/bin/python run_api.py         # serves 0.0.0.0:8001
```

System requirements: Python 3.12+, PostgreSQL (restore the `third_eye` database),
`ffmpeg` and `exiftool` if the upload/blur features are used.
`.env` holds DB / R2 credentials — keep it out of any public repo.
Runtime dirs (`tmp/`, `logs/`) are created automatically on first run.

## Frontend — build & run

```bash
cd frontend
# 1. set the PRODUCTION api url first (it is baked in at build time):
cp .env.production.example .env.production
#    -> edit .env.production, replace <SERVER_IP_OR_DOMAIN>

# 2. build (Node 22, see .nvmrc):
nvm use            # or: source ~/.nvm/nvm.sh && nvm install 22
npm ci
npm run build

# 3. artifacts to put on the server (output: "standalone" is already configured):
#    .next/standalone/                     -> app root on server
#    copy .next/static  -> .next/standalone/.next/static
#    copy public/       -> .next/standalone/public
PORT=3000 HOSTNAME=0.0.0.0 node server.js   # run from .next/standalone
```

The server runs Node 22 only — no npm install needed if the standalone
bundle is built elsewhere.

## Data files & this repo

`.gitignore` keeps secrets and oversized files OUT of git. After cloning on a
server, copy these from the project machine (they are not in the repo):

- `backend/features.geojson`  (410 MB — GitHub rejects files > 100 MB)
- `backend/.env`              (live credentials)
- `backend/uploads/` content  (user panoramas, if any must be preserved)

`tiledata/`, `temp_uploads/`, `r2_cache/` are gitignored but recreated/
populated automatically at runtime (only `.gitkeep` placeholders are committed).

## Notes

- `NEXT_PUBLIC_*` variables are inlined into the JS bundle at BUILD time;
  changing `.env` on the server afterwards has no effect — rebuild required.
- Over plain-HTTP LAN/IP access the app uses the execCommand clipboard
  fallback (no crash); HTTPS enables the native clipboard API everywhere.
- Frontend `.env.local` in this copy points to the dev LAN IP
  (192.168.0.107) — it is for local runs only, superseded by
  `.env.production` during build.
