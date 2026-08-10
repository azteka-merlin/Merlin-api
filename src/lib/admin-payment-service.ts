import type { AppContext } from "../types";

type PaymentLogRow = {
  checkout_id: number;
  customer_id: number;
  email: string | null;
  stripe_customer_id: string | null;
  provider: string;
  provider_session_id: string;
  provider_session_url: string | null;
  provider_price_id: string;
  provider_subscription_id: string | null;
  provider_external_reference: string | null;
  provider_raw_status: string | null;
  provider_status_detail: string | null;
  plan_type: string;
  mode: string;
  checkout_status: string;
  payment_status: string | null;
  provider_session_expires_at: string | null;
  completed_at: string | null;
  checkout_created_at: string;
  checkout_ip: string | null;
  checkout_user_agent: string | null;
  checkout_country: string | null;
  checkout_evidence_json: string | null;
  idempotency_key: string | null;
  payment_id: number | null;
  provider_payment_id: string | null;
  amount_cents: number | null;
  currency: string | null;
  payment_record_status: string | null;
  payment_type: string | null;
  payment_created_at: string | null;
  license_id: number | null;
  license_key: string | null;
  license_name: string | null;
  license_status: string | null;
  billing_status: string | null;
  access_type: string | null;
};

type PaymentEventRow = {
  id: number;
  provider_event_id: string;
  provider: string;
  event_type: string;
  processing_status: string;
  error_message: string | null;
  raw_created_at: string | null;
  processed_at: string | null;
  created_at: string;
};

function parseEvidence(value: string | null) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function mapPaymentLog(row: PaymentLogRow) {
  return {
    checkoutId: row.checkout_id,
    customerId: row.customer_id,
    email: row.email,
    stripeCustomerId: row.stripe_customer_id,
    provider: row.provider,
    providerSessionId: row.provider_session_id,
    providerSessionUrl: row.provider_session_url,
    providerPriceId: row.provider_price_id,
    providerSubscriptionId: row.provider_subscription_id,
    providerExternalReference: row.provider_external_reference,
    providerRawStatus: row.provider_raw_status,
    providerStatusDetail: row.provider_status_detail,
    planType: row.plan_type,
    mode: row.mode,
    checkoutStatus: row.checkout_status,
    paymentStatus: row.payment_status,
    providerSessionExpiresAt: row.provider_session_expires_at,
    completedAt: row.completed_at,
    checkoutCreatedAt: row.checkout_created_at,
    checkoutIp: row.checkout_ip,
    checkoutUserAgent: row.checkout_user_agent,
    checkoutCountry: row.checkout_country,
    checkoutEvidence: parseEvidence(row.checkout_evidence_json),
    idempotencyKey: row.idempotency_key,
    paymentId: row.payment_id,
    providerPaymentId: row.provider_payment_id,
    amountCents: row.amount_cents,
    currency: row.currency,
    paymentRecordStatus: row.payment_record_status,
    paymentType: row.payment_type,
    paymentCreatedAt: row.payment_created_at,
    licenseId: row.license_id,
    licenseKey: row.license_key,
    licenseName: row.license_name,
    licenseStatus: row.license_status,
    billingStatus: row.billing_status,
    accessType: row.access_type,
  };
}

function mapPaymentEvent(row: PaymentEventRow) {
  return {
    id: row.id,
    providerEventId: row.provider_event_id,
    provider: row.provider,
    eventType: row.event_type,
    processingStatus: row.processing_status,
    errorMessage: row.error_message,
    rawCreatedAt: row.raw_created_at,
    processedAt: row.processed_at,
    createdAt: row.created_at,
  };
}

export async function listAdminPaymentLogs(c: AppContext, limit = 100) {
  const safeLimit = Math.min(Math.max(limit, 1), 250);
  const payments = await c.env.merlin_db
    .prepare(
      `
        SELECT
          cs.id AS checkout_id,
          cs.customer_id,
          cst.email,
          cst.stripe_customer_id,
          cs.provider,
          cs.provider_session_id,
          cs.provider_session_url,
          cs.provider_price_id,
          cs.provider_subscription_id,
          cs.provider_external_reference,
          cs.provider_raw_status,
          cs.provider_status_detail,
          cs.plan_type,
          cs.mode,
          cs.status AS checkout_status,
          cs.payment_status,
          cs.provider_session_expires_at,
          cs.completed_at,
          cs.created_at AS checkout_created_at,
          cs.checkout_ip,
          cs.checkout_user_agent,
          cs.checkout_country,
          cs.checkout_evidence_json,
          cs.idempotency_key,
          p.id AS payment_id,
          p.provider_payment_id,
          p.amount_cents,
          p.currency,
          p.status AS payment_record_status,
          p.payment_type,
          p.created_at AS payment_created_at,
          l.id AS license_id,
          l.license_key,
          l.name AS license_name,
          l.status AS license_status,
          l.billing_status,
          l.access_type
        FROM checkout_sessions cs
        LEFT JOIN customers cst ON cst.id = cs.customer_id
        LEFT JOIN payments p ON p.provider = cs.provider
          AND p.provider_checkout_session_id = cs.provider_session_id
        LEFT JOIN licenses l ON l.id = COALESCE(cs.license_id, p.license_id, cs.reactivation_license_id)
        ORDER BY cs.id DESC, p.id DESC
        LIMIT ?
      `,
    )
    .bind(safeLimit)
    .all<PaymentLogRow>();

  const events = await c.env.merlin_db
    .prepare(
      `
        SELECT id, provider_event_id, provider, event_type, processing_status, error_message, raw_created_at, processed_at, created_at
        FROM payment_events
        ORDER BY id DESC
        LIMIT 120
      `,
    )
    .all<PaymentEventRow>();

  return {
    payments: (payments.results || []).map(mapPaymentLog),
    events: (events.results || []).map(mapPaymentEvent),
  };
}
