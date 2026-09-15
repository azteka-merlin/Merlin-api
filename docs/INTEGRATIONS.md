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
- The launcher button for managing access uses `POST /api/public/access/launcher-handoff`; the public site exchanges the opaque token through `POST /api/public/access/handoff/consume`. Tokens are short-lived, single-use, HMAC-hashed in D1, and passed in the URL fragment so they are not sent in HTTP requests or normal server logs.
- Keep the existing public login/session flow unchanged. If handoff creation or exchange fails, the launcher may fall back to the regular `/meu-acesso` route.
- Manifest and premium download behavior must preserve existing response headers and validation rules because the launcher depends on them.
- Quando nenhuma fonte de manifest entrega um ZIP, a rota ainda retorna HTTP `200` com `success: false`, para separar resultado de negocio de falha do Worker:
  - `manifest_unavailable`: todas as fontes responderam ausencia (`404`).
  - `manifest_sources_unavailable`: houve timeout, `5xx`, erro de rede ou payload que nao era ZIP em pelo menos uma fonte.
- Nos dois casos, registre atividade com a mesma `reason`. Para visibilidade operacional, emita `console.info` no primeiro caso e `console.warn` estruturado com `appId`, nome da fonte, tipo e status no segundo. Nao inclua URLs assinadas, tokens ou outros secrets nesses logs.

## Depotbox

- Used for game search and direct download of manifests/fixes.
- Requires `DEPOTBOX_API_KEY`.
- The authenticated launcher search keeps the availability filter disabled so titles
  without a DepotBox manifest are discoverable. Public catalog discovery keeps that
  filter enabled. Manifest availability is checked only when the launcher starts the
  installation and can fall back to the other configured sources.
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
