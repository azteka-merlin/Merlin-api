# Integrations - Merlin API

Short map of external systems touched by the API. Do not add real credentials, private URLs, or provider account details here.

## Cloudflare

- Workers runs the API and serves the admin panel assets.
- D1 stores business data: licenses, admin users/sessions, audit logs, activity, polls, public access keys, premium catalog, reservations, activations, and votes.
- R2 stores downloadable files, updates, overrides, and premium archives.
- Rate Limiting protects login, manifest downloads, public signup/email verification, and admin APIs.
- Wrangler is used for local dev, type generation, migrations, and deployment.

## Merlin Admin

- The admin panel is a sibling project built into `../merlin-admin/dist`.
- The API serves those static assets through the `ASSETS` binding.
- Admin browser calls use `/panel-api/*`.
- Mutating admin calls must keep session, CSRF, audit, and rate-limit behavior intact.

## Merlin Launcher

- Launcher calls `/api/*` for health/version, login, manifests, fixes, premium catalog, premium activations, polls, updates, and downloads.
- Launcher authentication uses license login plus bearer JWT.
- Manifest and premium download behavior must preserve existing response headers and validation rules because the launcher depends on them.

## Depotbox

- Used for game search and direct download of manifests/fixes.
- Requires `DEPOTBOX_API_KEY`.
- Calls must keep upstream failures isolated so other manifest sources/fallbacks can still be tried.

## Ryuu

- Used as a manifest source when both `RYU_API_URL` and `RYUU_AUTH_CODE` are configured.
- Also used for public catalog/image data from public file endpoints.
- Fix downloads from Ryuu must be proxied through `/api/fixes/download?source=ryuu`; the API appends `RYUU_AUTH_CODE` server-side so the launcher never receives the auth code.
- If not configured, the API should skip Ryuu and continue with other sources.

## Hubcap

- Used as a manifest fallback.
- Requires `HUBCAP_TOKEN`.

## Steam Store

- Used to enrich game metadata and cover information.
- This is public metadata; do not treat it as a license or activation source.

## GitHub/Skyflare fallbacks

- Used as additional manifest archive fallbacks.
- Keep this as best-effort fallback behavior; do not make it the only source without asking first.

## Resend

- Sends email verification and access-key recovery emails.
- Requires `RESEND_API_KEY`.
- `EMAIL_FROM` controls sender identity.
- Never log or document real recipient emails, API responses containing private addresses, or real provider keys.

## Auxiliary Merlin Worker

- Premium activation flows can call another Worker through `MERLIN_WORKER_URL`.
- Requests authenticate with `MERLIN_WORKER_TOKEN`.
- Current jobs include Premium activation and third-party token flows.
- If either variable is missing, the API returns a configuration error for the affected flow.
