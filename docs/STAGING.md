# Staging Plan - Merlin API

Goal: test API, public signup, and admin panel without deploying experimental changes onto production resources.

## Commands

Production:

- `npm run deploy`
- `npm run deploy:panel`

Staging:

- `npm run deploy-stage`
- `npm run deploy-stage:panel`
- `npm run d1:migrate:stage`

## Recommended staging resources

Use separate Cloudflare resources for staging where data isolation matters:

- Worker name, for example `merlin-api-stage`.
- Route/domain: `staging.api-merlin.com`.
- D1 database separate from production.
- Rate-limit namespaces separate from production.

R2 can stay shared with production for the current Merlin usage. The admin is the only place that uploads files, and uploaded fixes, manifests, and premium files are intentionally shared artifacts. Do not duplicate large R2 storage only for staging unless a future flow needs isolated files.

External-provider secrets can reuse production values if the owner accepts that behavior. D1 should stay separate so test licenses, admins, sessions, access keys, polls, and other database state do not affect production.

## R2 policy

Current decision:

- `MERLIN_FILES` may point to the same bucket in production and staging.
- `MERLIN_ACTIVATIONS` may point to the same bucket in production and staging.
- Staging may use the same R2 object structure as production for fixes, manifests, and premium archives.
- If the admin uploads a fix, manifest, or premium file while testing, that file can be shared with production because the staging database controls whether staging references it.
- Do not introduce staging prefixes by default.

Possible future exception:

- Launcher update files may later use a separated key path such as `_updates-staging/` if staging needs to test the “new version available” modal without touching production update metadata.
- For now, keep update storage behavior unchanged unless the user explicitly asks to split it.

## Shared R2 data

Overrides are stored in R2 (`MERLIN_FILES` / `overrides.json`), not D1. Because staging shares the same R2 buckets, override files/config are shared by design and should not be migrated.

Premium catalog data is stored in D1. If staging needs seed premium data again, do it as an explicit one-off operation after reviewing the current production and staging schemas. Do not keep a permanent prod-to-stage copy script unless there is an active workflow that needs it.

## Admin panel

The admin panel is served by this API through `ASSETS`, so staging panel deploy should:

1. build the sibling admin project for staging API URLs;
2. deploy the API Worker to the staging Cloudflare environment.

`deploy-stage:panel` intentionally does not run `types:stage`. Wrangler writes generated types to the shared `worker-configuration.d.ts` file, so staging type generation would overwrite the default production-oriented types on every staging deploy.

Use `npm run types:stage` only as a manual diagnostic when checking staging bindings. If it is run, revert or regenerate the default types before committing.

## Public signup

Public signup lives in this API. A staging API therefore also stages:

- access-key registration/recovery;
- email verification;
- public signup settings in D1;
- related rate limits.

## Launcher dev mode

For launcher development, prefer pointing the launcher to the staging HTTPS API instead of a local HTTP API when flows need real external integrations, license checks, downloads, or activation behavior.

Use this command in `Merlin-luncher`:

```powershell
npm run start:stage
```

Local `wrangler dev` is still useful for UI/API iteration, but staging is the safer environment for end-to-end launcher tests.

## Guardrails

- No real secret values in source, docs, commit messages, logs, screenshots, or examples.
- No personal machine paths in docs.
- Keep production behavior unchanged unless the user explicitly approves a behavior change.
- Any staging script must preserve the current production scripts.
- Do not add R2 prefixes or duplicate buckets as a default staging rule.
- Do not run staging type generation as part of the normal staging deploy flow.
