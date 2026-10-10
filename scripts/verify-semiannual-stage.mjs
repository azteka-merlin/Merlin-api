// Creates three disposable sandbox Pix purchases. Never runs against production.
// Requires staging real-email delivery to be off. Prints no PIN, QR or license key.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";

if (process.argv[2] !== "--create-sandbox-purchases") {
  throw new Error("Use --create-sandbox-purchases to explicitly create stage-only QA orders.");
}
const origin = "https://staging.api-merlin.com";
const run = Date.now().toString(36);
async function api(path, body) {
  const response = await fetch(`${origin}${path}`, body ? {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  } : undefined);
  const payload = await response.json();
  if (!response.ok || payload.success === false) throw new Error(`${path}: ${response.status} ${payload.error || "request failed"}`);
  return payload;
}

const purchases = [];
for (const tier of ["bronze", "prata", "ouro"]) {
  const email = `qa-semiannual-${run}-${tier}@example.invalid`;
  const recoveryPin = randomBytes(4).toString("hex");
  const verification = await api("/api/public/email-verification/start", { email });
  assert.equal(verification.deliveryMode, "staging_test", "QA requires staging test-code mode");
  await api("/api/public/email-verification/verify", { email, code: "12345" });
  const order = await api("/api/public/pix/orders", {
    name: "QA Semestral", contact: email, recoveryPin, acceptedRecoveryNotice: true,
    planType: "semiannual", planTier: tier,
  });
  assert.equal(order.planType, "semiannual");
  assert.equal(order.planTier, tier);
  purchases.push({ tier, ref: order.paymentIntentId });
}
await wait(6000);
for (const purchase of purchases) {
  const path = `/api/public/pix/orders/${encodeURIComponent(purchase.ref)}/status`;
  const paid = await api(path);
  assert.equal(paid.status, "paid", "sandbox order did not settle");
  assert.ok(paid.license?.expiresAt, "paid order must activate a license");
  const again = await api(path);
  assert.equal(again.license?.expiresAt, paid.license.expiresAt, "repeated status must not add a second period");
  console.log(JSON.stringify({ tier: purchase.tier, period: "semiannual", status: paid.status,
    expiresAt: paid.license.expiresAt, repeatedStatusStable: true }));
}
console.log(JSON.stringify({ run, purchases: purchases.length, environment: "stage/test" }));
