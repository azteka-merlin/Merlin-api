import { HTTPException } from "hono/http-exception";
import { Buffer } from "node:buffer";
import type { AppContext } from "../types";

const PRICE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const STRIPE_API_BASE_URL = "https://api.stripe.com/v1";
const PROVIDER_STRIPE = "stripe";

export type BillingPlanType = "monthly" | "lifetime";

type BillingSettingsRow = {
  id: number;
  billing_enabled: number;
  public_signup_enabled: number;
  monthly_enabled: number;
  lifetime_enabled: number;
  monthly_price_id: string | null;
  lifetime_price_id: string | null;
  currency: string;
  free_access_type: string;
  free_duration_days: number | null;
  updated_at: string;
};

type PaymentPriceCacheRow = {
  provider: string;
  provider_price_id: string;
  product_name: string | null;
  amount_cents: number;
  currency: string;
  recurring_interval: string | null;
  active: number;
  raw_json: string;
  synced_at: string;
};

type StripePrice = {
  id: string;
  object: "price";
  active: boolean;
  currency: string;
  unit_amount: number | null;
  recurring: { interval?: string | null } | null;
  product: string | { id?: string; name?: string | null } | null;
};

export type BillingPriceSnapshot = {
  provider: "stripe";
  priceId: string;
  productName: string | null;
  amountCents: number;
  currency: string;
  recurringInterval: string | null;
  active: boolean;
  syncedAt: string;
  stale: boolean;
};

export type BillingSettingsPayload = {
  billingEnabled: boolean;
  publicSignupEnabled: boolean;
  monthlyEnabled: boolean;
  lifetimeEnabled: boolean;
  monthlyPriceId: string;
  lifetimePriceId: string;
  currency: string;
  freeAccessType: string;
  freeDurationDays: number | null;
  prices: {
    monthly: BillingPriceSnapshot | null;
    lifetime: BillingPriceSnapshot | null;
  };
  updatedAt: string;
};

export type BillingSettingsInput = {
  billingEnabled: boolean;
  monthlyEnabled: boolean;
  lifetimeEnabled: boolean;
  monthlyPriceId?: string;
  lifetimePriceId?: string;
};

function normalizePriceId(value: string | undefined | null) {
  return String(value || "").trim();
}

function isPriceCacheFresh(syncedAt: string) {
  const syncedTime = new Date(syncedAt).getTime();
  return Number.isFinite(syncedTime) && Date.now() - syncedTime <= PRICE_CACHE_TTL_MS;
}

function mapPriceCache(row: PaymentPriceCacheRow): BillingPriceSnapshot {
  return {
    provider: "stripe",
    priceId: row.provider_price_id,
    productName: row.product_name,
    amountCents: row.amount_cents,
    currency: row.currency,
    recurringInterval: row.recurring_interval,
    active: row.active === 1,
    syncedAt: row.synced_at,
    stale: !isPriceCacheFresh(row.synced_at),
  };
}

function mapStripePrice(price: StripePrice, syncedAt: string): BillingPriceSnapshot {
  const productName = typeof price.product === "object" && price.product ? price.product.name || null : null;
  return {
    provider: "stripe",
    priceId: price.id,
    productName,
    amountCents: price.unit_amount ?? 0,
    currency: price.currency,
    recurringInterval: price.recurring?.interval || null,
    active: Boolean(price.active),
    syncedAt,
    stale: false,
  };
}

function encodeBasicAuth(secretKey: string) {
  return `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`;
}

async function getCachedStripePrice(c: AppContext, priceId: string) {
  return c.env.merlin_db
    .prepare(
      `
        SELECT provider, provider_price_id, product_name, amount_cents, currency, recurring_interval, active, raw_json, synced_at
        FROM payment_price_cache
        WHERE provider = ?
          AND provider_price_id = ?
      `,
    )
    .bind(PROVIDER_STRIPE, priceId)
    .first<PaymentPriceCacheRow>();
}

async function saveStripePriceSnapshot(c: AppContext, price: StripePrice, syncedAt: string) {
  const snapshot = mapStripePrice(price, syncedAt);
  await c.env.merlin_db
    .prepare(
      `
        INSERT INTO payment_price_cache (
          provider, provider_price_id, product_name, amount_cents, currency, recurring_interval, active, raw_json, synced_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, provider_price_id) DO UPDATE SET
          product_name = excluded.product_name,
          amount_cents = excluded.amount_cents,
          currency = excluded.currency,
          recurring_interval = excluded.recurring_interval,
          active = excluded.active,
          raw_json = excluded.raw_json,
          synced_at = excluded.synced_at,
          updated_at = excluded.updated_at
      `,
    )
    .bind(
      PROVIDER_STRIPE,
      snapshot.priceId,
      snapshot.productName,
      snapshot.amountCents,
      snapshot.currency,
      snapshot.recurringInterval,
      snapshot.active ? 1 : 0,
      JSON.stringify(price),
      syncedAt,
      syncedAt,
      syncedAt,
    )
    .run();

  return snapshot;
}

async function fetchStripePrice(c: AppContext, priceId: string) {
  const secretKey = c.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new HTTPException(503, { message: "Stripe nao esta configurado neste ambiente." });
  }

  const response = await fetch(`${STRIPE_API_BASE_URL}/prices/${encodeURIComponent(priceId)}?expand%5B%5D=product`, {
    headers: {
      Authorization: encodeBasicAuth(secretKey),
    },
  });
  const payload = await response.json().catch(() => null) as (StripePrice & { error?: { message?: string } }) | null;

  if (!response.ok || !payload || payload.object !== "price") {
    const message = payload?.error?.message || "Price ID invalido na Stripe.";
    throw new HTTPException(400, { message });
  }

  if (typeof payload.unit_amount !== "number" || payload.unit_amount <= 0) {
    throw new HTTPException(400, { message: "O Price ID da Stripe precisa ter valor fixo." });
  }

  return payload;
}

export async function getStripePriceSnapshot(c: AppContext, priceId: string, options: { forceRefresh?: boolean; allowStaleOnError?: boolean } = {}) {
  const normalizedPriceId = normalizePriceId(priceId);
  if (!normalizedPriceId) {
    return null;
  }

  const cached = await getCachedStripePrice(c, normalizedPriceId);
  if (cached && !options.forceRefresh && isPriceCacheFresh(cached.synced_at)) {
    return mapPriceCache(cached);
  }

  try {
    const price = await fetchStripePrice(c, normalizedPriceId);
    return saveStripePriceSnapshot(c, price, new Date().toISOString());
  } catch (error) {
    if (cached && options.allowStaleOnError) {
      return mapPriceCache(cached);
    }
    throw error;
  }
}

async function getReadableStripePriceSnapshot(c: AppContext, priceId: string) {
  try {
    return await getStripePriceSnapshot(c, priceId, { allowStaleOnError: true });
  } catch {
    return null;
  }
}

export function assertBillingPlanPrice(planType: BillingPlanType, price: BillingPriceSnapshot | null) {
  if (!price) {
    throw new HTTPException(400, { message: "Informe o Price ID do plano." });
  }
  if (!price.active) {
    throw new HTTPException(400, { message: "O Price ID informado esta inativo na Stripe." });
  }
  if (price.currency !== "brl") {
    throw new HTTPException(400, { message: "O Price ID precisa estar em BRL." });
  }
  if (planType === "monthly" && price.recurringInterval !== "month") {
    throw new HTTPException(400, { message: "O Price ID mensal precisa ser recorrente mensal." });
  }
  if (planType === "lifetime" && price.recurringInterval !== null) {
    throw new HTTPException(400, { message: "O Price ID vitalicio precisa ser pagamento unico." });
  }
}

function envPriceId(c: AppContext, planType: BillingPlanType) {
  return planType === "monthly" ? c.env.STRIPE_MONTHLY_PRICE_ID || "" : c.env.STRIPE_LIFETIME_PRICE_ID || "";
}

function mapBillingSettings(c: AppContext, row: BillingSettingsRow, prices: BillingSettingsPayload["prices"]): BillingSettingsPayload {
  const monthlyPriceId = normalizePriceId(row.monthly_price_id) || envPriceId(c, "monthly");
  const lifetimePriceId = normalizePriceId(row.lifetime_price_id) || envPriceId(c, "lifetime");
  return {
    billingEnabled: row.billing_enabled === 1,
    publicSignupEnabled: row.public_signup_enabled === 1,
    monthlyEnabled: row.monthly_enabled === 1,
    lifetimeEnabled: row.lifetime_enabled === 1,
    monthlyPriceId,
    lifetimePriceId,
    currency: row.currency || "brl",
    freeAccessType: row.free_access_type || "free",
    freeDurationDays: row.free_duration_days,
    prices,
    updatedAt: row.updated_at,
  };
}

export async function getBillingSettings(c: AppContext) {
  const now = new Date().toISOString();
  let row = await c.env.merlin_db
    .prepare(
      `
        SELECT id, billing_enabled, public_signup_enabled, monthly_enabled, lifetime_enabled, monthly_price_id, lifetime_price_id, currency, free_access_type, free_duration_days, updated_at
        FROM billing_settings
        WHERE id = 1
      `,
    )
    .first<BillingSettingsRow>();

  if (!row) {
    await c.env.merlin_db
      .prepare(
        `
          INSERT INTO billing_settings (id, billing_enabled, public_signup_enabled, monthly_enabled, lifetime_enabled, currency, free_access_type, updated_at)
          VALUES (1, 0, 1, 1, 1, 'brl', 'free', ?)
        `,
      )
      .bind(now)
      .run();
    row = {
      id: 1,
      billing_enabled: 0,
      public_signup_enabled: 1,
      monthly_enabled: 1,
      lifetime_enabled: 1,
      monthly_price_id: null,
      lifetime_price_id: null,
      currency: "brl",
      free_access_type: "free",
      free_duration_days: null,
      updated_at: now,
    };
  }

  const monthlyPriceId = normalizePriceId(row.monthly_price_id) || envPriceId(c, "monthly");
  const lifetimePriceId = normalizePriceId(row.lifetime_price_id) || envPriceId(c, "lifetime");
  const prices = {
    monthly: await getReadableStripePriceSnapshot(c, monthlyPriceId),
    lifetime: await getReadableStripePriceSnapshot(c, lifetimePriceId),
  };

  return mapBillingSettings(c, row, prices);
}

export async function updateBillingSettings(c: AppContext, input: BillingSettingsInput & { publicSignupEnabled: boolean }) {
  const monthlyPriceId = normalizePriceId(input.monthlyPriceId);
  const lifetimePriceId = normalizePriceId(input.lifetimePriceId);

  if (input.billingEnabled && !input.monthlyEnabled && !input.lifetimeEnabled) {
    throw new HTTPException(400, { message: "Ative pelo menos um plano para exigir pagamento." });
  }

  const monthlyPrice = input.monthlyEnabled || monthlyPriceId
    ? await getStripePriceSnapshot(c, monthlyPriceId, { forceRefresh: true, allowStaleOnError: false })
    : null;
  const lifetimePrice = input.lifetimeEnabled || lifetimePriceId
    ? await getStripePriceSnapshot(c, lifetimePriceId, { forceRefresh: true, allowStaleOnError: false })
    : null;

  if (input.monthlyEnabled) {
    assertBillingPlanPrice("monthly", monthlyPrice);
  }
  if (input.lifetimeEnabled) {
    assertBillingPlanPrice("lifetime", lifetimePrice);
  }

  const now = new Date().toISOString();
  await c.env.merlin_db
    .prepare(
      `
        INSERT INTO billing_settings (
          id, billing_enabled, public_signup_enabled, monthly_enabled, lifetime_enabled, monthly_price_id, lifetime_price_id, currency, free_access_type, free_duration_days, updated_at
        )
        VALUES (1, ?, ?, ?, ?, ?, ?, 'brl', 'free', NULL, ?)
        ON CONFLICT(id) DO UPDATE SET
          billing_enabled = excluded.billing_enabled,
          public_signup_enabled = excluded.public_signup_enabled,
          monthly_enabled = excluded.monthly_enabled,
          lifetime_enabled = excluded.lifetime_enabled,
          monthly_price_id = excluded.monthly_price_id,
          lifetime_price_id = excluded.lifetime_price_id,
          currency = excluded.currency,
          free_access_type = excluded.free_access_type,
          free_duration_days = excluded.free_duration_days,
          updated_at = excluded.updated_at
      `,
    )
    .bind(
      input.billingEnabled ? 1 : 0,
      input.publicSignupEnabled ? 1 : 0,
      input.monthlyEnabled ? 1 : 0,
      input.lifetimeEnabled ? 1 : 0,
      monthlyPriceId || null,
      lifetimePriceId || null,
      now,
    )
    .run();

  return getBillingSettings(c);
}
