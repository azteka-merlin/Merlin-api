import webpush from "web-push";
import { HTTPException } from "hono/http-exception";
import type { AppBindings, AppContext } from "../types";

type StoredSubscription = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type AdminPushSubscriptionInput = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

function pushHostAllowed(hostname: string): boolean {
  return hostname === "fcm.googleapis.com"
    || hostname === "updates.push.services.mozilla.com"
    || hostname === "web.push.apple.com"
    || hostname.endsWith(".push.apple.com")
    || hostname === "notify.windows.com"
    || hostname.endsWith(".notify.windows.com");
}

export function validateAdminPushSubscription(input: unknown): AdminPushSubscriptionInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HTTPException(400, { message: "Assinatura push inválida." });
  }
  const value = input as Record<string, unknown>;
  const keys = value.keys && typeof value.keys === "object" && !Array.isArray(value.keys)
    ? value.keys as Record<string, unknown> : null;
  const endpoint = typeof value.endpoint === "string" ? value.endpoint : "";
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new HTTPException(400, { message: "Endpoint push inválido." });
  }
  if (endpoint.length > 2048 || url.protocol !== "https:" || url.username || url.password || url.port || !pushHostAllowed(url.hostname)) {
    throw new HTTPException(400, { message: "Provedor push não permitido." });
  }
  const p256dh = typeof keys?.p256dh === "string" ? keys.p256dh : "";
  const auth = typeof keys?.auth === "string" ? keys.auth : "";
  if (!/^[A-Za-z0-9_-]{80,120}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,64}$/.test(auth)) {
    throw new HTTPException(400, { message: "Chaves push inválidas." });
  }
  return { endpoint, keys: { p256dh, auth } };
}

export function adminPushConfig(env: AppBindings) {
  const publicKey = String(env.ADMIN_PUSH_VAPID_PUBLIC_KEY || "").trim();
  const privateKey = String(env.ADMIN_PUSH_VAPID_PRIVATE_KEY || "").trim();
  const subject = String(env.ADMIN_PUSH_VAPID_SUBJECT || "").trim();
  return {
    available: /^[A-Za-z0-9_-]{87}$/.test(publicKey)
      && /^[A-Za-z0-9_-]{43}$/.test(privateKey)
      && /^(mailto:\S+@\S+|https:\/\/\S+)$/.test(subject),
    publicKey: publicKey || null,
  };
}

export async function saveAdminPushSubscription(c: AppContext, adminUserId: number, input: AdminPushSubscriptionInput) {
  if (!adminPushConfig(c.env).available) {
    throw new HTTPException(503, { message: "Notificações push ainda não configuradas." });
  }
  const count = await c.env.merlin_db.prepare(`
    SELECT COUNT(*) AS total FROM admin_push_subscriptions WHERE admin_user_id = ?
  `).bind(adminUserId).first<{ total: number }>();
  const existing = await c.env.merlin_db.prepare(`
    SELECT id FROM admin_push_subscriptions WHERE endpoint = ?
  `).bind(input.endpoint).first<{ id: string }>();
  if (!existing && (count?.total || 0) >= 10) {
    throw new HTTPException(409, { message: "Limite de dez dispositivos para este administrador." });
  }
  const now = new Date().toISOString();
  await c.env.merlin_db.prepare(`
    INSERT INTO admin_push_subscriptions (id, admin_user_id, endpoint, p256dh, auth, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      admin_user_id = excluded.admin_user_id,
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      updated_at = excluded.updated_at
  `).bind(crypto.randomUUID(), adminUserId, input.endpoint, input.keys.p256dh, input.keys.auth, now, now).run();
}

export async function removeAdminPushSubscription(c: AppContext, adminUserId: number, endpoint: string) {
  await c.env.merlin_db.prepare(`
    DELETE FROM admin_push_subscriptions WHERE admin_user_id = ? AND endpoint = ?
  `).bind(adminUserId, endpoint).run();
}

export async function sendAdminAlertPush(env: AppBindings, alert: { id: string; title: string; body: string }) {
  const config = adminPushConfig(env);
  if (!config.available || !config.publicKey) return;
  const rows = await env.merlin_db.prepare(`
    SELECT s.id, s.endpoint, s.p256dh, s.auth
    FROM admin_push_subscriptions s
    JOIN admin_users u ON u.id = s.admin_user_id
    WHERE u.status = 'active'
    LIMIT 100
  `).all<StoredSubscription>();
  const subscriptions = rows.results || [];
  if (!subscriptions.length) return;
  const payload = JSON.stringify({
    title: `Merlin Admin · ${alert.title.slice(0, 70)}`,
    body: alert.body.slice(0, 180),
    tag: `merlin-alert-${alert.id}`,
    url: `/alerts?id=${encodeURIComponent(alert.id)}`,
  });
  const vapidDetails = {
    subject: String(env.ADMIN_PUSH_VAPID_SUBJECT),
    publicKey: config.publicKey,
    privateKey: String(env.ADMIN_PUSH_VAPID_PRIVATE_KEY),
  };
  await Promise.all(subscriptions.map(async (subscription) => {
    try {
      const request = webpush.generateRequestDetails({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      }, payload, { vapidDetails, contentEncoding: "aes128gcm", TTL: 3600, urgency: "high" });
      const response = await fetch(request.endpoint, {
        method: "POST",
        headers: request.headers as HeadersInit,
        body: request.body ? new Uint8Array(request.body) : undefined,
        signal: AbortSignal.timeout(10000),
      });
      if (response.status === 404 || response.status === 410) {
        await env.merlin_db.prepare("DELETE FROM admin_push_subscriptions WHERE id = ?").bind(subscription.id).run();
      } else if (!response.ok) {
        console.error("[admin-alerts] push rejected", { status: response.status });
      }
    } catch (error) {
      console.error("[admin-alerts] push failed", error instanceof Error ? error.message : "Unknown error");
    }
  }));
}
