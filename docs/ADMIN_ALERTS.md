# Merlin Admin alerts

The first alert type is `steam_connection`. It is emitted only when a Premium activation's worker response contains a known Steam connectivity failure. It does not retry the customer's activation. The customer receives the existing failure response and must try again after the issue is fixed.

The API stores one active incident per alert key, plus one sanitized event per failed attempt. An admin may acknowledge or resolve an incident; resolving it releases the key so a later failure opens a new incident. Notifications are sent only when a new incident opens, not for every affected customer. An alert contains the license ID, game/AppID, time and allowlisted worker diagnostics. It never stores generator stdout, Steam tickets, tokens, credentials or raw request payloads.

The Admin UI uses authenticated `/panel-api/alerts/*` routes. Push opt-in is a deliberate click in the Admin. The service worker is limited to `/admin-alerts/` and contains no fetch handler, so it does not intercept public pages, the Public checkout or Launcher requests. Push notifications have only a generic incident summary and an Admin URL; customer details remain behind the Admin login. On iPhone, the Admin must be added to the Home Screen before enabling Web Push.

## Configuration

1. Apply D1 migration `0084_admin_alerts.sql` in the target environment.
2. Generate one VAPID key pair per environment with `npx web-push generate-vapid-keys`.
3. Set `ADMIN_PUSH_VAPID_PUBLIC_KEY`, `ADMIN_PUSH_VAPID_PRIVATE_KEY` and `ADMIN_PUSH_VAPID_SUBJECT` as Worker secrets. The subject must be a valid `mailto:` or HTTPS contact URI. Keep the private key outside Git and do not rotate it without asking subscribed devices to subscribe again.
4. Build and deploy the Admin assets with the API. The UI shows "Aguardando configuração" until all three values are present.
5. In an authenticated Admin session, open `/alerts` on each desired device and click "Ativar avisos". Test delivery with a controlled worker failure in staging before enabling production.

The admin push device endpoint is validated against supported browser push services and capped at ten devices per administrator. Expired subscriptions are removed after push services return 404 or 410. Push is best-effort; the D1 incident history remains the source of truth if the device is offline or suppresses notifications.
