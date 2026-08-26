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

type StripePortalConfiguration = {
  id: string;
  object: "billing_portal.configuration";
};

type StripePrice = {
  id: string;
  product?: string | { id?: string | null } | null;
};

type StripePortalConfigurationRow = {
  stripe_configuration_id: string;
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

async function stripeGet<T>(c: AppContext, path: string) {
  const response = await fetch(`${STRIPE_API_BASE_URL}${path}`, {
    headers: {
      Authorization: encodeBasicAuth(stripeSecretKey(c)),
    },
  });
  const payload = await response.json().catch(() => null) as T & { error?: { message?: string } } | null;
  if (!response.ok || !payload) {
    throw new HTTPException(502, { message: stripeApiMessage(payload, "Nao foi possivel consultar o plano na Stripe.") });
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

function priceProductId(price: StripePrice) {
  if (typeof price.product === "string") return price.product;
  if (price.product && typeof price.product.id === "string") return price.product.id;
  return "";
}

function setImmediateSubscriptionUpdateBehavior(params: URLSearchParams) {
  params.set("features[subscription_update][proration_behavior]", "always_invoice");
  params.set("features[subscription_update][billing_cycle_anchor]", "now");
}

async function getOrCreateSubscriptionUpdateConfiguration(c: AppContext, targetPriceId: string) {
  const cached = await c.env.merlin_db.prepare(`
    SELECT stripe_configuration_id
    FROM stripe_portal_price_configurations
    WHERE target_price_id = ?
    LIMIT 1
  `).bind(targetPriceId).first<StripePortalConfigurationRow>();
  if (cached?.stripe_configuration_id) {
    const params = new URLSearchParams();
    setImmediateSubscriptionUpdateBehavior(params);
    await stripePost<StripePortalConfiguration>(
      c,
      `/billing_portal/configurations/${encodeURIComponent(cached.stripe_configuration_id)}`,
      params,
    );
    return cached.stripe_configuration_id;
  }

  const price = await stripeGet<StripePrice>(c, `/prices/${encodeURIComponent(targetPriceId)}`);
  const productId = priceProductId(price);
  if (!productId) {
    throw new HTTPException(409, { message: "O plano de destino nao possui Product Stripe valido." });
  }

  const params = new URLSearchParams();
  params.set("features[payment_method_update][enabled]", "true");
  params.set("features[subscription_update][enabled]", "true");
  params.set("features[subscription_update][default_allowed_updates][0]", "price");
  params.set("features[subscription_update][products][0][product]", productId);
  params.set("features[subscription_update][products][0][prices][0]", targetPriceId);
  setImmediateSubscriptionUpdateBehavior(params);
  const configuration = await stripePost<StripePortalConfiguration>(c, "/billing_portal/configurations", params);
  if (configuration.object !== "billing_portal.configuration" || !configuration.id) {
    throw new HTTPException(502, { message: "Configuracao de confirmacao da Stripe invalida." });
  }

  const now = new Date().toISOString();
  await c.env.merlin_db.prepare(`
    INSERT OR IGNORE INTO stripe_portal_price_configurations (
      target_price_id, target_product_id, stripe_configuration_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)
  `).bind(targetPriceId, productId, configuration.id, now, now).run();

  const stored = await c.env.merlin_db.prepare(`
    SELECT stripe_configuration_id
    FROM stripe_portal_price_configurations
    WHERE target_price_id = ?
    LIMIT 1
  `).bind(targetPriceId).first<StripePortalConfigurationRow>();
  return stored?.stripe_configuration_id || configuration.id;
}

function isStripeSubscriptionAccess(accessType: string | null | undefined) {
  return accessType === "monthly_subscription" || accessType === "annual_subscription";
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

export async function createStripeSubscriptionUpdateConfirmPortalSession(c: AppContext, input: {
  stripeCustomerId: string;
  subscriptionId: string;
  subscriptionItemId: string;
  targetPriceId: string;
  returnPath: string;
  completedPath: string;
}) {
  const params = new URLSearchParams();
  params.set("customer", input.stripeCustomerId);
  params.set("return_url", `${requestOrigin(c)}${input.returnPath}`);
  params.set("configuration", await getOrCreateSubscriptionUpdateConfiguration(c, input.targetPriceId));
  params.set("flow_data[type]", "subscription_update_confirm");
  params.set("flow_data[subscription_update_confirm][subscription]", input.subscriptionId);
  params.set("flow_data[subscription_update_confirm][items][0][id]", input.subscriptionItemId);
  params.set("flow_data[subscription_update_confirm][items][0][price]", input.targetPriceId);
  params.set("flow_data[subscription_update_confirm][items][0][quantity]", "1");
  params.set("flow_data[after_completion][type]", "redirect");
  params.set("flow_data[after_completion][redirect][return_url]", `${requestOrigin(c)}${input.completedPath}`);

  const session = await stripePost<StripePortalSession>(c, "/billing_portal/sessions", params);
  if (session.object !== "billing_portal.session" || !session.url) {
    throw new HTTPException(502, { message: "Sessao de confirmacao da Stripe invalida." });
  }
  return { portalUrl: session.url };
}

export async function createPublicBillingPortalSession(c: AppContext, email: string) {
  const emailNormalized = normalizeContact(email, "email");
  await assertRecentPublicEmailVerification(c, emailNormalized);

  const customer = await getCustomerByEmail(c, emailNormalized);
  if (!customer?.stripe_customer_id) {
    throw new HTTPException(404, { message: "Nao encontramos uma assinatura Stripe para este e-mail." });
  }

  const license = await getCurrentLicenseBilling(c, customer.id, emailNormalized);
  if (!license?.stripe_subscription_id || !isStripeSubscriptionAccess(license.access_type)) {
    throw new HTTPException(409, { message: "Este e-mail nao possui assinatura Stripe ativa para gerenciar." });
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
  if (!license.stripe_customer_id || !license.stripe_subscription_id || !isStripeSubscriptionAccess(license.access_type)) {
    throw new HTTPException(409, { message: "Esta licenca nao possui assinatura Stripe para gerenciar." });
  }

  return createStripeBillingPortalSession(c, {
    stripeCustomerId: license.stripe_customer_id,
    returnPath: "/download?portal=launcher-return",
  });
}
