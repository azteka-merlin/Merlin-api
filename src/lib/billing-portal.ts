import { HTTPException } from "hono/http-exception";
import { Buffer } from "node:buffer";
import type { AppContext } from "../types";
import { normalizeContact } from "./admin-license-service";
import { assertRecentPublicEmailVerification } from "./email-verification";

const STRIPE_API_BASE_URL = "https://api.stripe.com/v1";

type CustomerRow = {
  id: number;
  email: string;
  email_normalized: string;
  stripe_customer_id: string | null;
};

type StripePortalSession = {
  id: string;
  object: "billing_portal.session";
  url: string | null;
};

type LicenseBillingRow = {
  id: number;
  access_type: string;
  billing_status: string;
  stripe_subscription_id: string | null;
};

type LauncherLicenseBillingRow = LicenseBillingRow & {
  stripe_customer_id: string | null;
  status: string;
};

function encodeBasicAuth(secretKey: string) {
  return `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`;
}

function stripeSecretKey(c: AppContext) {
  if (!c.env.STRIPE_SECRET_KEY) {
    throw new HTTPException(503, { message: "Stripe nao esta configurado neste ambiente." });
  }
  return c.env.STRIPE_SECRET_KEY;
}

function stripeApiMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error?: { message?: string } }).error;
    if (error?.message) {
      return error.message;
    }
  }
  return fallback;
}

async function stripePost<T>(c: AppContext, path: string, params: URLSearchParams) {
  const response = await fetch(`${STRIPE_API_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: encodeBasicAuth(stripeSecretKey(c)),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const payload = await response.json().catch(() => null) as T & { error?: { message?: string } } | null;
  if (!response.ok || !payload) {
    const message = stripeApiMessage(payload, "Nao foi possivel abrir o portal da Stripe.");
    const lowerMessage = message.toLowerCase();
    if (lowerMessage.includes("portal") && lowerMessage.includes("configuration")) {
      throw new HTTPException(409, { message: "O portal da Stripe ainda nao esta configurado neste ambiente." });
    }
    throw new HTTPException(502, { message });
  }
  return payload;
}

async function getCustomerByEmail(c: AppContext, emailNormalized: string) {
  return c.env.merlin_db
    .prepare(
      `
        SELECT id, email, email_normalized, stripe_customer_id
        FROM customers
        WHERE email_normalized = ?
        LIMIT 1
      `,
    )
    .bind(emailNormalized)
    .first<CustomerRow>();
}

async function getCurrentLicenseBilling(c: AppContext, customerId: number, emailNormalized: string) {
  return c.env.merlin_db
    .prepare(
      `
        SELECT id, access_type, billing_status, stripe_subscription_id
        FROM licenses
        WHERE customer_id = ?
          AND contact_type = 'email'
          AND lower(contact) = ?
          AND status = 'active'
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      `,
    )
    .bind(customerId, emailNormalized)
    .first<LicenseBillingRow>();
}

function requestOrigin(c: AppContext) {
  const url = new URL(c.req.raw.url);
  return `${url.protocol}//${url.host}`;
}

function stripeBillingPortalConfigurationId(c: AppContext) {
  return String(c.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID || "").trim();
}

export async function createStripeBillingPortalSession(c: AppContext, input: { stripeCustomerId: string; returnPath: string }) {
  const params = new URLSearchParams();
  params.set("customer", input.stripeCustomerId);
  params.set("return_url", `${requestOrigin(c)}${input.returnPath}`);
  const configurationId = stripeBillingPortalConfigurationId(c);
  if (configurationId) {
    params.set("configuration", configurationId);
  }

  const session = await stripePost<StripePortalSession>(c, "/billing_portal/sessions", params);
  if (session.object !== "billing_portal.session" || !session.url) {
    throw new HTTPException(502, { message: "Sessao do portal Stripe invalida." });
  }

  return {
    portalUrl: session.url,
  };
}

export async function createPublicBillingPortalSession(c: AppContext, email: string) {
  const emailNormalized = normalizeContact(email, "email");
  await assertRecentPublicEmailVerification(c, emailNormalized);

  const customer = await getCustomerByEmail(c, emailNormalized);
  if (!customer?.stripe_customer_id) {
    throw new HTTPException(404, { message: "Nao encontramos uma assinatura Stripe para este e-mail." });
  }

  const license = await getCurrentLicenseBilling(c, customer.id, emailNormalized);
  if (!license?.stripe_subscription_id || license.access_type !== "monthly_subscription") {
    throw new HTTPException(409, { message: "Este e-mail nao possui assinatura mensal ativa para gerenciar." });
  }

  return createStripeBillingPortalSession(c, {
    stripeCustomerId: customer.stripe_customer_id,
    returnPath: "/download?portal=return",
  });
}

export async function createLauncherBillingPortalSession(c: AppContext, licenseId: number) {
  const license = await c.env.merlin_db
    .prepare(
      `
        SELECT id, access_type, billing_status, stripe_customer_id, stripe_subscription_id, status
        FROM licenses
        WHERE id = ?
        LIMIT 1
      `,
    )
    .bind(licenseId)
    .first<LauncherLicenseBillingRow>();

  if (!license || license.status !== "active") {
    throw new HTTPException(404, { message: "Licenca ativa nao encontrada." });
  }
  if (!license.stripe_customer_id || !license.stripe_subscription_id || license.access_type !== "monthly_subscription") {
    throw new HTTPException(409, { message: "Esta licenca nao possui assinatura mensal Stripe para gerenciar." });
  }

  return createStripeBillingPortalSession(c, {
    stripeCustomerId: license.stripe_customer_id,
    returnPath: "/download?portal=launcher-return",
  });
}
