# Merlin API

Cloudflare Workers backend for Merlin. The service exposes the public API used by the launcher and serves the administrative panel from the same Worker.

Do not document credentials, tokens, personal paths, private emails, infrastructure IDs, or secret values in this repository.

## Architecture

- The Worker handles both API requests and admin-panel asset routing.
- Public launcher traffic is served under `/api/*`.
- Admin-panel traffic is served under `/panel-api/*`.
- The compiled admin frontend is served as static assets by the same Worker.
- Administrative authentication is session-based and stays server-side.
- Persistent data is stored in D1.
- File-backed metadata and overrides are stored through Cloudflare bindings.

## Main Routes

- `GET /doc`: Swagger / OpenAPI documentation.
- `GET /api/health`: health check.
- `GET /api/version`: deployed API version.
- `GET /api/manifests?appid=...`: launcher manifest lookup.
- `POST /api/auth/login`: launcher authentication.
- `POST /panel-api/auth/login`: admin login.
- `GET /panel-api/auth/session`: admin session lookup.
- `POST /panel-api/auth/logout`: admin logout.
- `GET /panel-api/licenses`: list licenses.
- `POST /panel-api/licenses`: create license.
- `GET /panel-api/licenses/:id`: read license details.
- `PUT /panel-api/licenses/:id`: update license.
- `POST /panel-api/licenses/:id/renew`: renew license.
- `POST /panel-api/licenses/:id/revoke`: revoke license.
- `POST /panel-api/licenses/:id/reset-hwid`: reset license hardware binding.

## Project Structure

- `src/index.ts`: Worker entry point, routing, public API, and admin panel integration.
- `src/lib/admin-security.ts`: password hashing, sessions, CSRF handling, lockouts, and audit helpers.
- `src/lib/admin-license-service.ts`: administrative license operations.
- `migrations/`: D1 schema migrations.
- `scripts/bootstrap-admin.mjs`: generates the SQL needed to create the first admin user.

## Local Development

```powershell
npm install
Copy-Item wrangler.example.jsonc wrangler.jsonc
Copy-Item .dev.vars.example .dev.vars
npx wrangler types
npx wrangler dev
```

The local Worker runs on Wrangler's development server. Use `/login` for the admin panel and `/doc` for Swagger.

`wrangler.jsonc` and `worker-configuration.d.ts` are intentionally not committed:

- `wrangler.jsonc` contains account-specific Cloudflare resource IDs, bucket names, custom domains, and optional rate-limit namespace IDs.
- `worker-configuration.d.ts` is generated from the local Wrangler configuration with `npx wrangler types`.
- `.dev.vars` contains local development secrets and should be created from `.dev.vars.example`.

For a lightweight local setup, copy the example files and fill only the required values for the feature you are testing. If rate-limit bindings are omitted, the API runs without Cloudflare edge rate limiting and logs a warning.

## Cloudflare Resource Setup

Use placeholders in committed files and keep real values in your local `wrangler.jsonc` or Cloudflare account.

Create a D1 database and paste its `database_name` and `database_id` into `wrangler.jsonc`:

```powershell
npx wrangler d1 create your-d1-database-name
```

Create the R2 buckets used by the API and paste their bucket names into `wrangler.jsonc`:

```powershell
npx wrangler r2 bucket create your-files-bucket
npx wrangler r2 bucket create your-activations-bucket
```

Configure required production or staging secrets with Wrangler:

```powershell
npx wrangler secret put DEPOTBOX_API_KEY
npx wrangler secret put RYUU_AUTH_CODE
npx wrangler secret put HUBCAP_TOKEN
npx wrangler secret put JWT_SECRET
npx wrangler secret put SESSION_HASH_SECRET
npx wrangler secret put RESEND_API_KEY
```

Rate-limit bindings are optional for local development and public clones. To enable Cloudflare edge rate limiting, create namespaces in your Cloudflare account and add the `ratelimits` block shown in `wrangler.example.jsonc`.

## Admin Bootstrap

Generate the first admin user with:

```powershell
npm run admin:bootstrap
```

The script prompts for a username and password, then prints SQL for a remote D1 insert. It does not write directly to the database. Passwords are never stored in plain text.

## Deployment

Common project commands:

```powershell
npm run deploy
npm run deploy:panel
npm run deploy-stage
npm run deploy-stage:panel
npm run d1:migrate:remote
npm run d1:migrate:stage
```

Before deploying a fresh environment:

1. Build the admin frontend.
2. Generate Worker types.
3. Apply D1 migrations.
4. Configure required secrets through Wrangler.
5. Bootstrap the first admin user.
6. Deploy the Worker.

## Security Notes

- Admin access uses an HttpOnly, Secure, SameSite session cookie.
- Mutating admin routes require a valid session and CSRF token.
- Login failures are audited and participate in user/IP lockout logic.
- Real administrative tokens and secret values must remain server-side.
- Public documentation should use placeholders for environment-specific infrastructure names.
