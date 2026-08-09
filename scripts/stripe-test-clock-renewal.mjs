#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { argv, env, exit, platform } from "node:process";
import { resolve } from "node:path";
import { getD1DatabaseName } from "./wrangler-config.mjs";

const STRIPE_API_BASE_URL = "https://api.stripe.com/v1";
const TEST_ENV = String(env.MERLIN_TEST_ENV || "staging").trim();
const TEST_BASE_URL = String(env.MERLIN_TEST_BASE_URL || "https://staging.api-merlin.com").trim().replace(/\/+$/, "");

if (!TEST_ENV || TEST_ENV === "production") {
  console.error("MERLIN_TEST_ENV must point to a non-production environment.");
  exit(1);
}

if (!/^https:\/\/staging\./.test(TEST_BASE_URL) && !/^https:\/\/localhost[:/]/.test(TEST_BASE_URL)) {
  console.error("MERLIN_TEST_BASE_URL must point to staging or localhost.");
  exit(1);
}

function usage() {
  console.error([
    "Usage:",
    "  STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-test-clock-renewal.mjs prepare",
    "  STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-test-clock-renewal.mjs status <email>",
    "  STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-test-clock-renewal.mjs advance <email>",
    "  STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-test-clock-renewal.mjs tick <email> <hours>",
    "  STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-test-clock-renewal.mjs cancel <email>",
    "  STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-test-clock-renewal.mjs stripe <email>",
  ].join("\n"));
  exit(1);
}

function requireStripeSecret() {
  const secret = String(env.STRIPE_SECRET_KEY || "").trim();
  if (!secret || !secret.startsWith("sk_test_")) {
    console.error("STRIPE_SECRET_KEY must be a Stripe test secret key.");
    exit(1);
  }
  return secret;
}

function encodeBasicAuth(secret) {
  return `Basic ${Buffer.from(`${secret}:`).toString("base64")}`;
}

async function stripeRequest(method, path, params = null) {
  const secret = requireStripeSecret();
  const response = await fetch(`${STRIPE_API_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: encodeBasicAuth(secret),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params ? params.toString() : undefined,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) {
    const message = payload?.error?.message || `Stripe request failed: ${method} ${path}`;
    throw new Error(message);
  }
  return payload;
}

function runWranglerD1(sql) {
  const databaseName = getD1DatabaseName(TEST_ENV);
  if (!databaseName) {
    throw new Error(`Could not find staging D1 database_name in wrangler.jsonc.`);
  }

  const compactSql = sql.replace(/\s+/g, " ").trim();
  const args = [
    "d1",
    "execute",
    databaseName,
    "--env",
    TEST_ENV,
    "--remote",
    "--json",
    `--command=${compactSql}`,
  ];
  const wranglerBin = platform === "win32"
    ? resolve("node_modules/.bin/wrangler.cmd")
    : resolve("node_modules/.bin/wrangler");
  const result = platform === "win32"
    ? spawnSync(env.ComSpec || "cmd.exe", ["/d", "/c", wranglerBin, ...args], { encoding: "utf8" })
    : spawnSync(wranglerBin, args, { encoding: "utf8" });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error([
      "wrangler d1 execute failed",
      result.stderr?.trim(),
      result.stdout?.trim(),
    ].filter(Boolean).join("\n"));
  }

  const parsed = JSON.parse(result.stdout);
  if (!parsed?.[0]?.success) {
    throw new Error(result.stdout);
  }
  return parsed[0].results || [];
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function addHours(date, hours) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

async function createClock() {
  const params = new URLSearchParams();
  params.set("frozen_time", String(Math.floor(Date.now() / 1000)));
  params.set("name", `Merlin renewal stage ${new Date().toISOString()}`);
  return stripeRequest("POST", "/test_helpers/test_clocks", params);
}

async function createClockCustomer(clock, email) {
  const params = new URLSearchParams();
  params.set("email", email);
  params.set("name", "Merlin Renewal Test");
  params.set("test_clock", clock.id);
  params.set("payment_method", "pm_card_visa");
  params.set("invoice_settings[default_payment_method]", "pm_card_visa");
  params.set("metadata[merlin_test]", "renewal");
  params.set("metadata[merlin_environment]", TEST_ENV);
  return stripeRequest("POST", "/customers", params);
}

function upsertStageCustomer(email, stripeCustomerId) {
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresIso = addMinutes(now, 30).toISOString();
  const normalized = email.trim().toLowerCase();

  runWranglerD1(`
    INSERT INTO customers (email, email_normalized, email_verified_at, stripe_customer_id, created_at, updated_at)
    VALUES (${sqlString(email)}, ${sqlString(normalized)}, ${sqlString(nowIso)}, ${sqlString(stripeCustomerId)}, ${sqlString(nowIso)}, ${sqlString(nowIso)})
    ON CONFLICT(email_normalized) DO UPDATE SET
      email = excluded.email,
      email_verified_at = excluded.email_verified_at,
      stripe_customer_id = excluded.stripe_customer_id,
      updated_at = excluded.updated_at
  `);

  const customerRows = runWranglerD1(`
    SELECT id, email, email_normalized, stripe_customer_id
    FROM customers
    WHERE email_normalized = ${sqlString(normalized)}
    LIMIT 1
  `);
  const customer = customerRows[0];
  if (!customer?.id) {
    throw new Error("Could not prepare staging customer.");
  }

  runWranglerD1(`
    INSERT INTO email_verifications (
      email, email_normalized, code_hash, status, provider, verify_attempts, expires_at, cooldown_until, last_sent_at, verified_at, used_at, created_at, updated_at
    )
    VALUES (
      ${sqlString(email)},
      ${sqlString(normalized)},
      'stage-test-clock',
      'verified',
      'stage-test-clock',
      0,
      ${sqlString(expiresIso)},
      ${sqlString(nowIso)},
      ${sqlString(nowIso)},
      ${sqlString(nowIso)},
      NULL,
      ${sqlString(nowIso)},
      ${sqlString(nowIso)}
    )
  `);

  return customer;
}

async function createCheckout(email) {
  const response = await fetch(`${TEST_BASE_URL}/api/public/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Merlin Renewal Test",
      contact: email,
      recoveryPin: "1234",
      acceptedRecoveryNotice: true,
      planType: "monthly",
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.checkoutUrl) {
    throw new Error(payload?.message || "Could not create staging checkout.");
  }
  return payload;
}

function getStageLicense(email) {
  const normalized = email.trim().toLowerCase();
  const rows = runWranglerD1(`
    SELECT
      l.id AS license_id,
      l.license_key,
      l.status AS license_status,
      l.expires_at,
      l.billing_status,
      l.billing_current_period_end,
      l.billing_cancel_at_period_end,
      l.stripe_customer_id,
      l.stripe_subscription_id,
      s.status AS subscription_status,
      s.current_period_end AS subscription_current_period_end,
      s.cancel_at_period_end AS subscription_cancel_at_period_end
    FROM licenses l
    LEFT JOIN subscriptions s ON s.license_id = l.id
    WHERE l.contact_type = 'email'
      AND lower(l.contact) = ${sqlString(normalized)}
    ORDER BY l.id DESC
    LIMIT 1
  `);
  return rows[0] || null;
}

async function getStripeSubscription(subscriptionId) {
  return stripeRequest("GET", `/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

async function getStripeCustomer(customerId) {
  return stripeRequest("GET", `/customers/${encodeURIComponent(customerId)}`);
}

async function advanceClock(clockId, frozenTime) {
  const params = new URLSearchParams();
  params.set("frozen_time", String(frozenTime));
  return stripeRequest("POST", `/test_helpers/test_clocks/${encodeURIComponent(clockId)}/advance`, params);
}

async function waitForClockReady(clockId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const clock = await stripeRequest("GET", `/test_helpers/test_clocks/${encodeURIComponent(clockId)}`);
    if (clock.status === "ready") {
      return clock;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Test clock ${clockId} did not become ready in time.`);
}

async function prepare() {
  const email = `renewal-test-${Date.now()}@merlin.test`;
  const clock = await createClock();
  const stripeCustomer = await createClockCustomer(clock, email);
  const customer = upsertStageCustomer(email, stripeCustomer.id);
  const checkout = await createCheckout(email);
  console.log(JSON.stringify({
    email,
    testClockId: clock.id,
    stripeCustomerId: stripeCustomer.id,
    internalCustomerId: customer.id,
    checkoutSessionId: checkout.checkoutSessionId,
    checkoutUrl: checkout.checkoutUrl,
    next: "Pague o checkout em stage com 4242 4242 4242 4242, validade futura e CVC qualquer. Depois rode status e advance.",
  }, null, 2));
}

async function status(email) {
  const license = getStageLicense(email);
  console.log(JSON.stringify({ email, license }, null, 2));
}

async function advance(email) {
  const before = getStageLicense(email);
  if (!before?.stripe_subscription_id || !before?.stripe_customer_id) {
    throw new Error("No paid monthly staging license found for this email yet.");
  }

  const subscription = await getStripeSubscription(before.stripe_subscription_id);
  const customer = await getStripeCustomer(before.stripe_customer_id);
  const clockId = typeof customer.test_clock === "string" ? customer.test_clock : customer.test_clock?.id;
  if (!clockId) {
    throw new Error("Stripe customer is not attached to a test clock.");
  }

  const currentPeriodEnd = Number(subscription.current_period_end || Math.floor(new Date(before.billing_current_period_end || before.expires_at).getTime() / 1000));
  if (!Number.isFinite(currentPeriodEnd) || currentPeriodEnd <= 0) {
    throw new Error("Stripe subscription does not have a valid current_period_end.");
  }

  const target = Math.floor(addHours(new Date(currentPeriodEnd * 1000), 2).getTime() / 1000);
  const advanced = await advanceClock(clockId, target);
  const ready = await waitForClockReady(clockId);
  await new Promise((resolve) => setTimeout(resolve, 8000));
  const after = getStageLicense(email);
  console.log(JSON.stringify({
    email,
    testClockId: clockId,
    advancedTo: new Date(target * 1000).toISOString(),
    stripeClockStatus: ready.status || advanced.status,
    before,
    after,
  }, null, 2));
}

async function stripe(email) {
  const license = getStageLicense(email);
  if (!license?.stripe_subscription_id) {
    throw new Error("No Stripe subscription found for this email.");
  }
  const subscription = await stripeRequest("GET", `/subscriptions/${encodeURIComponent(license.stripe_subscription_id)}?expand[]=latest_invoice.payment_intent&expand[]=default_payment_method`);
  console.log(JSON.stringify({
    email,
    license,
    subscription: {
      id: subscription.id,
      status: subscription.status,
      current_period_start: subscription.current_period_start ? new Date(subscription.current_period_start * 1000).toISOString() : null,
      current_period_end: subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null,
      collection_method: subscription.collection_method,
      default_payment_method: summarizePaymentMethod(subscription.default_payment_method),
      latest_invoice: summarizeInvoice(subscription.latest_invoice),
      payment_settings: subscription.payment_settings,
    },
  }, null, 2));
}

function summarizePaymentMethod(paymentMethod) {
  if (!paymentMethod || typeof paymentMethod !== "object") {
    return paymentMethod || null;
  }
  return {
    id: paymentMethod.id || null,
    type: paymentMethod.type || null,
    card: paymentMethod.card ? {
      brand: paymentMethod.card.brand || null,
      last4: paymentMethod.card.last4 || null,
      exp_month: paymentMethod.card.exp_month || null,
      exp_year: paymentMethod.card.exp_year || null,
      country: paymentMethod.card.country || null,
      funding: paymentMethod.card.funding || null,
    } : null,
  };
}

function summarizeInvoice(invoice) {
  if (!invoice || typeof invoice !== "object") {
    return invoice || null;
  }
  return {
    id: invoice.id || null,
    status: invoice.status || null,
    billing_reason: invoice.billing_reason || null,
    amount_due: invoice.amount_due || 0,
    amount_paid: invoice.amount_paid || 0,
    amount_remaining: invoice.amount_remaining || 0,
    attempt_count: invoice.attempt_count || 0,
    payment_settings: invoice.payment_settings || null,
    period_start: invoice.period_start ? new Date(invoice.period_start * 1000).toISOString() : null,
    period_end: invoice.period_end ? new Date(invoice.period_end * 1000).toISOString() : null,
  };
}

async function tick(email, hours) {
  const license = getStageLicense(email);
  if (!license?.stripe_customer_id) {
    throw new Error("No Stripe customer found for this email.");
  }
  const customer = await getStripeCustomer(license.stripe_customer_id);
  const clockId = typeof customer.test_clock === "string" ? customer.test_clock : customer.test_clock?.id;
  if (!clockId) {
    throw new Error("Stripe customer is not attached to a test clock.");
  }
  const clock = await stripeRequest("GET", `/test_helpers/test_clocks/${encodeURIComponent(clockId)}`);
  const incrementHours = Number(hours || 1);
  if (!Number.isFinite(incrementHours) || incrementHours <= 0) {
    throw new Error("Hours must be a positive number.");
  }
  const currentFrozenTime = Number(clock.frozen_time || Math.floor(Date.now() / 1000));
  const target = currentFrozenTime + Math.floor(incrementHours * 60 * 60);
  await advanceClock(clockId, target);
  const ready = await waitForClockReady(clockId);
  await new Promise((resolve) => setTimeout(resolve, 8000));
  const after = getStageLicense(email);
  console.log(JSON.stringify({
    email,
    testClockId: clockId,
    advancedFrom: new Date(currentFrozenTime * 1000).toISOString(),
    advancedTo: new Date(target * 1000).toISOString(),
    stripeClockStatus: ready.status,
    after,
  }, null, 2));
}

async function cancel(email) {
  const license = getStageLicense(email);
  if (!license?.stripe_subscription_id) {
    throw new Error("No Stripe subscription found for this email.");
  }
  const params = new URLSearchParams();
  params.set("cancel_at_period_end", "true");
  const subscription = await stripeRequest("POST", `/subscriptions/${encodeURIComponent(license.stripe_subscription_id)}`, params);
  await new Promise((resolve) => setTimeout(resolve, 8000));
  const after = getStageLicense(email);
  console.log(JSON.stringify({
    email,
    subscription: {
      id: subscription.id,
      status: subscription.status,
      cancel_at_period_end: subscription.cancel_at_period_end,
      cancel_at: subscription.cancel_at ? new Date(subscription.cancel_at * 1000).toISOString() : null,
    },
    after,
  }, null, 2));
}

const command = argv[2];
try {
  if (command === "prepare") {
    await prepare();
  } else if (command === "status") {
    if (!argv[3]) usage();
    await status(argv[3]);
  } else if (command === "advance") {
    if (!argv[3]) usage();
    await advance(argv[3]);
  } else if (command === "stripe") {
    if (!argv[3]) usage();
    await stripe(argv[3]);
  } else if (command === "tick") {
    if (!argv[3]) usage();
    await tick(argv[3], argv[4] || "1");
  } else if (command === "cancel") {
    if (!argv[3]) usage();
    await cancel(argv[3]);
  } else {
    usage();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  exit(1);
}
