# Context - Merlin API

Merlin API is the backend core of the Merlin ecosystem. It runs on Cloudflare Workers, uses D1 as the database, R2 for files, and also serves the compiled `Merlin-admin` panel.

## Stack

- Cloudflare Workers
- Hono
- Chanfana/OpenAPI
- Zod
- TypeScript
- D1
- R2
- Wrangler

## Cloudflare Configuration

Main file: `wrangler.jsonc`.

Important points:

- Worker: `merlin-api`
- Entry: `src/index.ts`
- Domain: `api-merlin.com`
- Panel assets: `../merlin-admin/dist`
- Asset binding: `ASSETS`
- D1 binding: `merlin_db`, database `merlin-db`
- R2 bindings: `MERLIN_FILES` and `MERLIN_ACTIVATIONS`
- Rate limits: login, manifests, and admin
- Node compatibility: `nodejs_compat`

## Public Surface

Main public routes:

- `GET /api/health`
- `GET /api/version`
- `GET /api/manifests`
- `GET /api/manifests/status`
- `POST /api/auth/login`
- `POST /api/games/search`
- `GET /api/fixes/catalog`
- `GET /api/fixes/download`
- `POST /api/fixes/vote`
- `GET /api/premium/catalog`
- `POST /api/premium/activate`
- `POST /api/premium/activate-third-party`
- `POST /api/premium/activation-events`
- `GET /api/premium/download`
- `GET /api/polls/active`
- `POST /api/polls/:id/vote`
- `GET /api/updates/latest`
- `GET /api/updates/download`
- `POST /api/public/access-keys/register`
- `POST /api/public/access-keys/recover`
- `POST /api/public/email-verification/start`
- `POST /api/public/email-verification/verify`

## Admin Surface

Admin routes use `/panel-api/*` and require an admin session:

- Admin auth: login, session, and logout.
- Licenses: list, detail, create, edit, renew, revoke, reactivate, and reset HWID.
- Audit and user activity.
- Blocked IPs.
- Manifest/fix overrides.
- Premium games and uploads.
- Polls.
- Public signup configuration.
- Launcher update upload/publishing.

## Important Modules

- `src/index.ts`: main router, public HTML, panel, and admin routes.
- `src/endpoints/`: public and admin endpoints split into smaller files.
- `src/lib/auth.ts`: JWT and license authentication.
- `src/lib/admin-security.ts`: admin session, CSRF, hashing, audit, and blocking.
- `src/lib/admin-license-service.ts`: admin license rules.
- `src/lib/overrides.ts`: override rules and R2 paths.
- `src/lib/premium-games.ts`: premium catalog, activations, and downloads.
- `src/lib/polls.ts`: polls.
- `src/lib/email-verification.ts` and `src/lib/access-key-emails.ts`: public email flows through Resend.
- `migrations/`: D1 schema history.

## External Integrations

- Depotbox: manifest/fix search and download.
- Ryuu: images, manifests when configured, and fix downloads proxied by the API with `RYUU_AUTH_CODE`.
- Hubcap: manifest fallback.
- Resend: verification and recovery emails.
- Steam Store API: game metadata.
- Merlin Admin: static assets served by the Worker.
- Merlin Launcher: consumes `/api/*`, updates, and downloads.

## Notes

- Real secrets belong in Cloudflare, not in source code.
- `.dev.vars` and `.env` are local-only and must not be committed.
- Run `npm run types` after changing `wrangler.jsonc`.
- Apply remote D1 migrations before the final deploy when schema changes exist.
- Staging deploy uses `npm run deploy-stage`; staging panel deploy uses `npm run deploy-stage:panel`.
- Overrides are shared through R2 and are not migrated between D1 databases.
- Mutating admin routes must validate admin session and CSRF.
- Large uploads use R2 multipart flows; validate abort/complete behavior when changing that path.
