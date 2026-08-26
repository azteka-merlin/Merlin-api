# Environment - Merlin API

This project is open source. Keep this document focused on names, purpose, and setup flow only. Do not add real tokens, Cloudflare IDs, personal paths, emails, or production values.

## Local files

- `.dev.vars.example`: safe template with placeholder values.
- `.dev.vars`: local-only file used by `wrangler dev`. Never commit it.
- Cloudflare dashboard/Wrangler secrets: source of truth for deployed environments.

## Required secrets

These values are required for the production Worker declared in `wrangler.jsonc`.

| Name | Used by | Purpose |
| --- | --- | --- |
| `DEPOTBOX_API_KEY` | manifests, fixes, game search | Authenticates Depotbox requests. |
| `RYUU_AUTH_CODE` | manifests, fixes | Enables Ryuu manifest source when `RYU_API_URL` is configured and lets the API proxy Ryuu fix downloads without exposing the auth code to the launcher. |
| `HUBCAP_TOKEN` | manifests | Enables Hubcap manifest fallback. |
| `JWT_SECRET` | launcher auth | Signs launcher API bearer tokens. |
| `SESSION_HASH_SECRET` | admin panel | Hashes/admin session security material. |
| `RESEND_API_KEY` | public signup/email flows | Sends verification and recovery emails. |

## Optional variables

| Name | Used by | Purpose |
| --- | --- | --- |
| `EMAIL_FROM` | email flows | Sender identity for Resend emails. Falls back to a development sender if omitted. |
| `RYU_API_URL` | manifests | Base URL for Ryuu manifest requests. Without it, Ryuu is skipped. |
| `ADMIN_API_TOKEN` | internal license endpoints | Bearer token for legacy/internal admin API access. |
| `INTERNAL_ADMIN_AUTH_SECRET` | admin security | Shared secret for internal admin-auth validation. |
| `MERLIN_WORKER_URL` | premium activations | Base URL for the auxiliary Merlin Worker. |
| `MERLIN_WORKER_TOKEN` | premium activations | Bearer token sent to the auxiliary Merlin Worker. |
| `STEAM_ACCOUNT_ID` | premium/activation generation | Default Steam account id for activation generation when not provided by request. |

## Cloudflare bindings

Bindings are configured in `wrangler.jsonc`. Keep binding names stable because application code references them directly.

| Binding | Type | Purpose |
| --- | --- | --- |
| `ASSETS` | Static assets | Serves the compiled `Merlin-admin` panel from the sibling admin project. |
| `merlin_db` | D1 database | Stores licenses, admins, sessions, audit logs, polls, access keys, premium data, and votes. |
| `MERLIN_FILES` | R2 bucket | Stores launcher updates, manifest/fix overrides, and general downloadable files. |
| `MERLIN_ACTIVATIONS` | R2 bucket | Stores premium/activation archives. |
| `LOGIN_RATE_LIMITER` | Rate limit | Login, public signup, and email-verification protection. |
| `MANIFESTS_RATE_LIMITER` | Rate limit | Manifest download protection. |
| `ADMIN_RATE_LIMITER` | Rate limit | Admin panel API protection. |

Do not copy Cloudflare database ids, namespace ids, or account ids into docs unless the user explicitly asks and the file is private.

## Environment split

Recommended shape for staging:

- production Worker keeps the current public domain and production database/storage bindings.
- staging Worker uses its own Worker name, route/domain, D1 database, and rate-limit namespaces.
- R2 buckets may be shared with production because fixes, manifests, and premium files are shared artifacts in the current workflow.
- R2 override config is shared by design through `MERLIN_FILES` / `overrides.json`; do not migrate overrides between D1 databases.
- secrets may reuse the same external-provider credentials if desired.
- keep D1 separate to avoid test licenses, admins, sessions, access keys, polls, and audit data touching production data.
- after any binding change, run type generation before deploying.
