import { Buffer } from "node:buffer";
import { HTTPException } from "hono/http-exception";
import type { AppContext } from "../types";
import { isEligibleForExpiredCardToPix } from "./expired-card-renewal";

type CardLicense = Parameters<typeof isEligibleForExpiredCardToPix>[0] & { id: number };

async function stripeGet<T>(c: AppContext, path: string): Promise<T> {
  const secret = String(c.env.STRIPE_SECRET_KEY || "").trim();
  if (!secret) throw new HTTPException(503, { message: "Stripe indisponivel para confirmar o cancelamento." });
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${secret}:`).toString("base64")}` },
  });
  const payload = await response.json().catch(() => null) as T | null;
  if (!response.ok || !payload) {
    throw new HTTPException(502, { message: "Nao foi possivel confirmar o cancelamento na Stripe. Tente novamente." });
  }
  return payload;
}

async function stripePost<T>(c: AppContext, path: string, idempotencyKey: string): Promise<T> {
  const secret = String(c.env.STRIPE_SECRET_KEY || "").trim();
  if (!secret) throw new HTTPException(503, { message: "Stripe indisponivel para confirmar o checkout." });
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${secret}:`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": idempotencyKey,
    },
    body: "",
  });
  const payload = await response.json().catch(() => null) as T | null;
  if (!response.ok || !payload) {
    throw new HTTPException(502, { message: "Nao foi possivel encerrar o checkout anterior na Stripe." });
  }
  return payload;
}

async function settlePendingCardReactivationCheckouts(c: AppContext, licenseId: number) {
  const pending = await c.env.merlin_db.prepare(`
    SELECT id, provider_session_id, status, payment_status
    FROM checkout_sessions
    WHERE provider = 'stripe' AND reactivation_license_id = ? AND license_id IS NULL
      AND (payment_status = 'paid' OR status IN ('complete', 'completed', 'processing', 'open'))
    ORDER BY id ASC
  `).bind(licenseId).all<{
    id: number;
    provider_session_id: string | null;
    status: string;
    payment_status: string | null;
  }>();

  for (const checkout of pending.results || []) {
    const sessionId = String(checkout.provider_session_id || "");
    if (!sessionId.startsWith("cs_")) {
      throw new HTTPException(409, {
        message: "A renovacao por cartao ainda esta sendo criada ou precisa de conciliacao. Tente novamente em instantes.",
      });
    }

    let session = await stripeGet<{ id?: string; status?: string; payment_status?: string }>(
      c,
      `/checkout/sessions/${encodeURIComponent(sessionId)}`,
    );
    if (session.id !== sessionId) {
      throw new HTTPException(502, { message: "A Stripe retornou um checkout inesperado." });
    }

    const locallySettled = checkout.payment_status === "paid"
      || ["complete", "completed", "processing"].includes(checkout.status);
    if (session.status === "open" && locallySettled) {
      throw new HTTPException(409, {
        message: "O estado da renovacao por cartao precisa ser conciliado antes de pagar por Pix. Atualize seu acesso ou tente novamente.",
      });
    }

    if (session.status === "open") {
      try {
        session = await stripePost<{ id?: string; status?: string; payment_status?: string }>(
          c,
          `/checkout/sessions/${encodeURIComponent(sessionId)}/expire`,
          `merlin_card_to_pix_expire:${sessionId}`,
        );
      } catch {
        // Payment may complete after the initial read but before Stripe expires it.
        // Re-read the provider state; never clear the local reservation on ambiguity.
        session = await stripeGet<{ id?: string; status?: string; payment_status?: string }>(
          c,
          `/checkout/sessions/${encodeURIComponent(sessionId)}`,
        );
      }
      if (session.id !== sessionId) {
        throw new HTTPException(502, { message: "A Stripe retornou um checkout inesperado." });
      }
    }

    if (session.status === "complete") {
      const { reconcileStripeCheckoutSession } = await import("./stripe-webhook");
      await reconcileStripeCheckoutSession(c, sessionId);
      throw new HTTPException(409, {
        message: "A renovacao por cartao foi concluida ou esta sendo confirmada. Atualize seu acesso antes de pagar por Pix.",
      });
    }

    if (session.status !== "expired") {
      throw new HTTPException(409, {
        message: "Nao foi possivel confirmar o encerramento da renovacao por cartao. Tente novamente em instantes.",
      });
    }

    if (locallySettled) {
      throw new HTTPException(409, {
        message: "O estado da renovacao por cartao precisa ser conciliado antes de pagar por Pix. Atualize seu acesso ou tente novamente.",
      });
    }

    const updated = await c.env.merlin_db.prepare(`
      UPDATE checkout_sessions
      SET status = 'expired', payment_status = 'expired', updated_at = ?
      WHERE id = ? AND provider = 'stripe' AND license_id IS NULL
        AND reactivation_license_id = ? AND status = 'open'
        AND (payment_status IS NULL OR payment_status <> 'paid')
    `).bind(new Date().toISOString(), checkout.id, licenseId).run();
    if (!updated.meta.changes) {
      throw new HTTPException(409, {
        message: "A renovacao por cartao mudou de estado durante a operacao. Atualize seu acesso antes de pagar por Pix.",
      });
    }
  }
}

export async function assertExpiredCardToPixReady(c: AppContext, license: CardLicense) {
  if (!isEligibleForExpiredCardToPix(license)) {
    throw new HTTPException(409, { message: "A assinatura do cartao ainda nao terminou." });
  }

  await settlePendingCardReactivationCheckouts(c, license.id);

  const subscriptionId = String(license.stripe_subscription_id);
  const subscription = await stripeGet<{
    id?: string; customer?: string | { id?: string }; status?: string; ended_at?: number | null;
  }>(c, `/subscriptions/${encodeURIComponent(subscriptionId)}`);
  const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
  const endedAt = Number(subscription.ended_at);
  if (subscription.id !== subscriptionId || customerId !== license.stripe_customer_id
    || subscription.status !== "canceled" || !Number.isFinite(endedAt)
    || endedAt <= 0 || endedAt > Date.now() / 1000 + 60) {
    throw new HTTPException(409, { message: "A renovacao automatica do cartao ainda nao foi encerrada na Stripe." });
  }

  for (const status of ["open", "draft"] as const) {
    const query = new URLSearchParams({ subscription: subscriptionId, status, limit: "1" });
    const invoices = await stripeGet<{ data?: unknown[] }>(c, `/invoices?${query}`);
    if (!Array.isArray(invoices.data)) {
      throw new HTTPException(502, { message: "Nao foi possivel conferir as faturas da assinatura." });
    }
    if (invoices.data.length) {
      throw new HTTPException(409, { message: "Ainda existe uma fatura do cartao pendente. Regularize-a antes de pagar por Pix." });
    }
  }
}

export async function assertNoPendingPixReactivation(c: AppContext, licenseId: number) {
  const row = await c.env.merlin_db.prepare(`
    SELECT id FROM checkout_sessions
    WHERE provider = 'mercadopago' AND reactivation_license_id = ? AND license_id IS NULL
      AND (payment_status = 'paid' OR status IN ('completed', 'processing')
        OR (status = 'open' AND (provider_session_expires_at IS NULL OR provider_session_expires_at > ?)))
    LIMIT 1
  `).bind(licenseId, new Date().toISOString()).first<{ id: number }>();
  if (row) throw new HTTPException(409, {
    message: "Ja existe um Pix em andamento para esta licenca. Pague-o ou aguarde expirar antes de usar o cartao.",
  });
}
