// Creates three unpaid checkout sessions in stage/test mode. Never submits a card.
// Requires staging e-mail delivery to be disabled; outputs no PIN or checkout URL.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

if (process.argv[2] !== "--create-unpaid-test-checkouts") {
  throw new Error("Use --create-unpaid-test-checkouts to explicitly create stage-only QA checkouts.");
}
const origin = "https://staging.api-merlin.com";
const run = Date.now().toString(36);
async function api(path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || payload.success === false) throw new Error(`${path}: ${response.status} ${payload.error || "request failed"}`);
  return payload;
}

for (const tier of ["bronze", "prata", "ouro"]) {
  const email = `qa-semiannual-card-${run}-${tier}@example.invalid`;
  const recoveryPin = randomBytes(4).toString("hex");
  const verification = await api("/api/public/email-verification/start", { email });
  assert.equal(verification.deliveryMode, "staging_test", "QA requires staging test-code mode");
  await api("/api/public/email-verification/verify", { email, code: "12345" });
  const checkout = await api("/api/public/checkout", {
    name: "QA Semestral", contact: email, recoveryPin, acceptedRecoveryNotice: true,
    planType: "semiannual", planTier: tier,
  });
  assert.equal(new URL(checkout.checkoutUrl).hostname, "checkout.stripe.com");
  assert.ok(checkout.checkoutSessionId?.startsWith("cs_test_"), "must use a test-mode Stripe Checkout session");
  console.log(JSON.stringify({ tier, period: "semiannual", checkoutSessionId: checkout.checkoutSessionId,
    status: "unpaid", provider: "stripe/test" }));
}
console.log(JSON.stringify({ run, created: 3, environment: "stage/test" }));
