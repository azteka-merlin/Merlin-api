# Merlin API Docs

Use this file as the docs router. Do not open every `.md` by default; pick the smallest document that answers the current task.

## Reading hierarchy

1. `UP.md` — run locally, deploy, migrate D1, bootstrap admin, and post-deploy checks.
2. `ENVIRONMENT.md` — variables, secrets, Cloudflare bindings, and what belongs in each environment.
3. `INTEGRATIONS.md` — external systems used by the API and which flows depend on each one.
4. `STAGING.md` — planned staging setup for API, public signup, admin panel, and launcher tests.
5. `STAGING_OPERATIONS.md` — current staging-only behavior for public e-mail verification.
6. `PLANO_TIERS_OPERACAO.md` — current plan, Pix, catalog-cutoff, activation, and individual early-access rules.
7. `SPECIAL_CORRECTION.md` — contract for the AppID `4407750` license-token correction across API, Admin, and Launcher.
8. `CONTEXT.md` — architecture, routes, modules, and behavior notes for code changes.
9. `RELEASE_NOTES.md` — launcher changelog, its D1 records, R2 assets, and the Admin/Launcher contract.

## Quick rule

- For setup/deploy work, start with `UP.md`; only open `ENVIRONMENT.md` if variables or bindings are involved.
- For provider/API questions, open `INTEGRATIONS.md`; only open code if the doc is not enough.
- For behavior/code changes, open `CONTEXT.md` before editing.
- For staging scripts or staging deploy, open `STAGING.md` first.
- For the `license_token` correction, open `SPECIAL_CORRECTION.md`; do not infer Premium behavior from it.
- For launcher changelog behavior, open `RELEASE_NOTES.md`.

Open-source rule: never document real credentials, provider account details, personal paths, Cloudflare ids, private emails, or production-only values.
