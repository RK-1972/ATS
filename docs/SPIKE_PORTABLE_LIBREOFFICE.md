# Spike: portable LibreOffice on Render (native Node)

**Branch:** `spike/portable-libreoffice`  
**Production:** `enterprise-stable-v1` / `optalynx-api` — keep Build Command `npm install` until spike passes.

## Render spike service (create manually after push)

| Setting | Value |
|---------|--------|
| Name | e.g. `optalynx-api-lo-spike` |
| Runtime | Node (native) |
| Plan | Free |
| Repo / branch | `ATS` → `spike/portable-libreoffice` |
| Root directory | Repository root (`ats-backend` if monorepo subdir — match prod API) |
| Build Command | `bash scripts/render-spike-build.sh` |
| Start Command | `npm start` |

## Safe UAT configuration (required — not production)

Do **not** copy production `DB_*`, `R2_*`, `JWT_SECRET`, or Graph secrets onto the spike unless you accept prod data risk.

| Variable | Spike guidance |
|----------|----------------|
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | **UAT / Neon dev** database only — no production Postgres |
| `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | **Separate UAT bucket** or dedicated spike prefix; not production bucket |
| `JWT_SECRET` | Spike-only secret (can match UAT frontend if testing login) |
| `FRONTEND_URL` | UAT frontend URL or spike frontend; required for CORS if browser-tested |
| `CLIENT_ID`, `TENANT_ID`, `CLIENT_SECRET`, `EMAIL_USER` | UAT Entra app / mailbox if email paths are hit; optional for PDF-only API test |
| `LIBREOFFICE_PATH` | **Unset** — portable tree under `.libreoffice/` is auto-discovered |
| `NODE_ENV` / `RENDER` | As Render sets for deployed services |

## Verification on spike

1. Build logs: `render-fetch-portable-libreoffice: Done` and verify script `PASS: DOCX→PDF conversion`.
2. Optional runtime: `GET` health + authenticated `POST /api/v1/documents/generate` against **UAT** offer data only.

## Disk / memory

- ~203 MB download + ~500–600 MB extracted under `.libreoffice/` (rebuilt each deploy unless tarball cached in `.libreoffice/cache` on build FS).
- Free tier **512 MB RAM**: monitor for OOM during PDF conversion.
