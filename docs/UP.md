# Startup And Deployment - Merlin API

Quick guide to run locally, migrate the database, and deploy the Merlin API to Cloudflare Workers.

This project is open source: never add real secrets, personal paths, Cloudflare IDs, private emails, or production-only values to docs.

## Requirements

- Node.js 18 or newer
- npm
- Cloudflare account authenticated with Wrangler
- D1 database configured in `wrangler.jsonc`
- R2 buckets configured in `wrangler.jsonc`
- `Merlin-admin` next to this repo to build the panel assets

## Run locally

```powershell
cd path\to\Merlin-api
npm install
Copy-Item .dev.vars.example .dev.vars
npm run types
npm run dev
```

The Worker usually starts at `http://localhost:8787`.

Useful routes:

- `http://localhost:8787/api/health`
- `http://localhost:8787/api/version`
- `http://localhost:8787/doc`
- `http://localhost:8787/login`

## Variables and secrets

For local development, create `.dev.vars` from `.dev.vars.example`.

Required deployed secrets:

- `DEPOTBOX_API_KEY`
- `RYUU_AUTH_CODE`
- `HUBCAP_TOKEN`
- `JWT_SECRET`
- `SESSION_HASH_SECRET`
- `RESEND_API_KEY`

Common optional values:

- `EMAIL_FROM`
- `RYU_API_URL`
- `ADMIN_API_TOKEN`
- `INTERNAL_ADMIN_AUTH_SECRET`
- `MERLIN_WORKER_URL`
- `MERLIN_WORKER_TOKEN`
- `STEAM_ACCOUNT_ID`

Configure Cloudflare secrets with:

```powershell
npx wrangler secret put DEPOTBOX_API_KEY
npx wrangler secret put RYUU_AUTH_CODE
npx wrangler secret put HUBCAP_TOKEN
npx wrangler secret put JWT_SECRET
npx wrangler secret put SESSION_HASH_SECRET
npx wrangler secret put RESEND_API_KEY
```

See `ENVIRONMENT.md` for the full inventory.

## D1 database

Apply remote migrations:

```powershell
cd path\to\Merlin-api
npm run d1:migrate:remote
```

After changing bindings in `wrangler.jsonc`, regenerate types:

```powershell
npm run types
```

## First admin bootstrap

```powershell
cd path\to\Merlin-api
npm run admin:bootstrap
```

The script asks for username and password, generates the password hash, and prints a `wrangler d1 execute` command to insert the admin. It does not write to the database by itself.

## Deploy API with panel

Recommended full flow:

```powershell
cd path\to\Merlin-admin
npm install
npm run build

cd path\to\Merlin-api
npm install
npm run types
npm run d1:migrate:remote
npm run deploy
```

Shortcut for panel build + types + deploy:

```powershell
cd path\to\Merlin-api
npm run deploy:panel
```

Run `npm run d1:migrate:remote` before the shortcut when new migrations exist.

## Staging

Staging uses a separate Worker, D1 database, route/domain, and rate-limit namespaces. R2 is intentionally shared for the current Merlin files/fixes/premium workflow.

Commands:

- `npm run deploy-stage`
- `npm run deploy-stage:panel`
- `npm run d1:migrate:stage`

`deploy-stage:panel` builds the sibling admin panel and deploys staging. It does not run `types:stage`, because staging types overwrite the shared `worker-configuration.d.ts` file.

Overrides do not need a migration step. They are stored in shared R2 (`MERLIN_FILES` / `overrides.json`) in the current staging policy.

See `STAGING.md` for the full staging policy.

## Post-deploy checks

- `/api/health` responds successfully.
- `/doc` opens Swagger/OpenAPI.
- `/login` opens the admin panel.
- Admin login creates a secure session cookie.
- `/panel-api/licenses` only responds when authenticated.
- `/api/updates/latest` returns metadata when an update is published.
- `/api/updates/download` returns the installer from R2.

## Current Cloudflare references

- Wrangler configuration: https://developers.cloudflare.com/workers/wrangler/configuration/
- Workers static assets: https://developers.cloudflare.com/workers/static-assets/binding/
- Workers secrets: https://developers.cloudflare.com/workers/configuration/secrets/
- D1 migrations: https://developers.cloudflare.com/d1/wrangler-commands/
