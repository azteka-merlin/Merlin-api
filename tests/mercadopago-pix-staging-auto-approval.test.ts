import { describe, expect, test } from "vitest";
import { getPixBillingCancelAtPeriodEnd, shouldAutoApproveStagingTestPix } from "../src/lib/mercadopago-pix";

describe("staging Mercado Pago Pix auto approval", () => {
  const expiresAt = "2026-09-18T06:11:09.634Z";
  const createdAt = new Date(expiresAt).getTime() - 30 * 60 * 1_000;
  const waitingTestOrder = {
    appEnvironment: "staging",
    pixEnvironment: "test",
    providerEnvironment: "test",
    providerStatus: "action_required",
    providerStatusDetail: "waiting_transfer",
    expiresAt,
  };

  test("settles a sandbox APRO Pix order after its short test delay", () => {
    expect(shouldAutoApproveStagingTestPix({ ...waitingTestOrder, nowMs: createdAt + 5_000 })).toBe(true);
  });

  test("never settles production, non-test, or expired orders locally", () => {
    expect(shouldAutoApproveStagingTestPix({ ...waitingTestOrder, appEnvironment: "production", nowMs: createdAt + 5_000 })).toBe(false);
    expect(shouldAutoApproveStagingTestPix({ ...waitingTestOrder, providerStatus: "processed", nowMs: createdAt + 5_000 })).toBe(false);
    expect(shouldAutoApproveStagingTestPix({ ...waitingTestOrder, nowMs: new Date(expiresAt).getTime() })).toBe(false);
  });
});

describe("Pix renewal policy", () => {
  test("keeps every recurring Pix plan manually renewable", () => {
    expect(getPixBillingCancelAtPeriodEnd("monthly")).toBe(1);
    expect(getPixBillingCancelAtPeriodEnd("annual")).toBe(1);
    expect(getPixBillingCancelAtPeriodEnd("lifetime")).toBe(0);
  });
});
