# ThirdEye360 v2 — Deployment Package

Self-contained deployment copy of backend (FastAPI) + frontend (Next.js).
Created 2026-10-25 from `backend/` and `frontend_v2/`.

## Production topology (coexists with v1 on streetview.bmapsbd.com)

| What | Public URL | Internal |
|---|---|---|
| v1 (existing, untouched) | `streetview.bmapsbd.com/` and `/api` | — |
| v2 frontend | `streetview.bmapsbd.com/v2` | Next.js on **port 3005** (`basePath: /v2`) |
| v2 backend | `streetview.bmapsbd.com/api/v2` | FastAPI on **port 8002** (`API_PORT=8002`) |

When v2 eventually replaces v1: remove `basePath` from `next.config.mjs`,
rebuild, move nginx `location /` to Next and `location /api` to the v2 backend.

## Backend — server setup

```bash
cd backend
python3 -m venv venv                 # do NOT copy a venv between machines (absolute paths break)
./venv/bin/pip install -r requirements.txt
API_PORT=8002 ./venv/bin/python run_api.py
```

System requirements: Python 3.12+, PostgreSQL (restore the `third_eye` database),
`ffmpeg` and `exiftool` if the upload/blur features are used.
`.env` holds DB / R2 credentials — transfer it manually, never commit it.
Runtime dirs (`tmp/`, `logs/`) are created automatically on first run.

## Frontend — build & run

`next.config.mjs` already has `basePath: "/v2"` and `.env.production` already
holds the production API URLs — both committed, nothing to fill in.

```bash
cd frontend
nvm use            # Node 22 (see .nvmrc)
npm ci
npm run build
PORT=3005 npm start
```

## nginx (inside the streetview.bmapsbd.com server block, alongside v1)

```nginx
# v2 backend — rewrite strips ONLY /v2 so FastAPI receives its native /api/... paths
location /api/v2/ {
    rewrite ^/api/v2(/.*)$ /api$1 break;
    proxy_pass http://127.0.0.1:8002;      # no trailing slash
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
    client_max_body_size 2G;               # nginx default 1M breaks zip uploads
}

# v2 frontend
location = /v2 { return 301 /v2/; }
location /v2/ {
    proxy_pass http://127.0.0.1:3005;      # no trailing slash — Next expects /v2 prefix
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;
}
```

## Data files & this repo

`.gitignore` keeps secrets and oversized files OUT of git. After cloning on a
server, copy these from the project machine (they are not in the repo):

- `backend/features.geojson`  (410 MB — GitHub rejects files > 100 MB)
- `backend/.env`              (live credentials)
- `backend/uploads/` content  (user panoramas, if any must be preserved)

`tiledata/`, `temp_uploads/`, `r2_cache/` are gitignored but recreated/
populated automatically at runtime.

## Notes

- **Env precedence gotcha:** in a Next.js build `.env.local` WINS over
  `.env.production`. This repo deliberately contains NO `.env.local` — never
  add one to this folder, or a build will silently bake dev values.
- `NEXT_PUBLIC_*` variables are inlined into the JS bundle at BUILD time;
  changing env on the server afterwards has no effect — rebuild required.
- `.env.production` holds only public URLs (no secrets) and is committed so
  server builds are reproducible.
- Over plain-HTTP access the app uses the execCommand clipboard fallback;
  behind HTTPS (this domain) the native clipboard API is used everywhere.
