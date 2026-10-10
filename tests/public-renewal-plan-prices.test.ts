import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AppContext } from "../src/types";

vi.mock("../src/lib/billing-settings", async (original) => ({
  ...await original<typeof import("../src/lib/billing-settings")>(),
  getBillingSettings: vi.fn(),
}));
vi.mock("../src/lib/admin-license-service", async (original) => ({
  ...await original<typeof import("../src/lib/admin-license-service")>(),
  getLicense: vi.fn(),
}));
vi.mock("../src/lib/subscription-plan-change", async (original) => ({
  ...await original<typeof import("../src/lib/subscription-plan-change")>(),
  listPublicBillingPlanPrices: vi.fn(),
  previewSubscriptionPlanChange: vi.fn(),
}));
import { getBillingSettings } from "../src/lib/billing-settings";
import { getLicense } from "../src/lib/admin-license-service";
import { listPublicBillingPlanPrices, previewSubscriptionPlanChange } from "../src/lib/subscription-plan-change";
import { getPublicAccessDetailsForLicense, previewPublicAccessPlanChangeForLicense } from "../src/lib/public-access-management";

const c = { env: {
  ENVIRONMENT: "staging", PIX_ENV: "test", PIX_ENABLED: "true",
  PIX_PROVIDER: "mercadopago", MERCADO_PAGO_TEST_ACCESS_TOKEN: "test-fixture",
  merlin_db: { prepare() { return { bind() { return this; }, async first() { return null; } }; } },
} } as unknown as AppContext;

function settings(overrides = {}) {
  vi.mocked(getBillingSettings).mockResolvedValue({
    plansEnabled: true, billingEnabled: true, publicSignupEnabled: true,
    monthlyEnabled: true, semiannualEnabled: true, annualEnabled: true,
    pixEnabled: true, pixMonthlyEnabled: true, pixSemiannualEnabled: true, pixAnnualEnabled: true,
    // Deliberately no legacy Price: tiered renewal must not depend on it.
    prices: { monthly: null, annual: null }, ...overrides,
  } as Awaited<ReturnType<typeof getBillingSettings>>);
}
function license(period: "monthly" | "semiannual" | "annual", method: "pix" | "card", expiry = "2020-01-01T00:00:00Z") {
  vi.mocked(getLicense).mockResolvedValue({
    id: 1, status: "active", expires_at: expiry, plan_tier: "bronze",
    access_type: method === "pix" && period !== "monthly" ? `${period}_manual` : `${period}_subscription`,
    source: method === "pix" ? "mercadopago" : "stripe", customer_id: null,
    stripe_customer_id: method === "card" ? "cus_fixture" : null,
    stripe_subscription_id: method === "card" ? "sub_fixture" : null,
  } as Awaited<ReturnType<typeof getLicense>>);
}

describe("renewal parity across all tiered billing periods", () => {
  beforeEach(() => { vi.clearAllMocks(); settings(); });
  for (const period of ["monthly", "semiannual", "annual"] as const) {
    for (const method of ["card", "pix"] as const) {
      test(`${method} ${period} uses the tier price rather than legacy defaults`, async () => {
        license(period, method);
        vi.mocked(listPublicBillingPlanPrices).mockResolvedValue([
          { planTier: "bronze", billingPeriod: period, paymentMethod: method, amountCents: 6590, currency: "brl", active: true },
        ]);
        const result = await getPublicAccessDetailsForLicense(c, 1);
        expect(result).toMatchObject({ access: { renewal: {
          available: true, card: method === "card", pix: method === "pix", price: { amountCents: 6590 },
        } } });
      });
    }
    test(`${period} cannot be selected for a card change when disabled`, async () => {
      settings({ [`${period}Enabled`]: false });
      await expect(previewPublicAccessPlanChangeForLicense(c, 1, { targetTier: "bronze", targetPeriod: period }))
        .rejects.toThrow("periodo de destino");
      expect(previewSubscriptionPlanChange).not.toHaveBeenCalled();
    });
    test(`${period} does not offer Pix renewal when its Pix flag is off`, async () => {
      license(period, "pix");
      settings({ [`pix${period[0].toUpperCase()}${period.slice(1)}Enabled`]: false });
      vi.mocked(listPublicBillingPlanPrices).mockResolvedValue([
        { planTier: "bronze", billingPeriod: period, paymentMethod: "pix", amountCents: 6590, currency: "brl", active: true },
      ]);
      const result = await getPublicAccessDetailsForLicense(c, 1);
      expect(result).toMatchObject({ access: { renewal: { available: false, pix: false, earlyPix: false } } });
    });
  }
  test("early Pix renewal obeys the checkout's global availability flags", async () => {
    const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    license("semiannual", "pix", expiry);
    settings({ publicSignupEnabled: false });
    vi.mocked(listPublicBillingPlanPrices).mockResolvedValue([
      { planTier: "bronze", billingPeriod: "semiannual", paymentMethod: "pix", amountCents: 6590, currency: "brl", active: true },
    ]);
    expect(await getPublicAccessDetailsForLicense(c, 1)).toMatchObject({ access: { renewal: { earlyPix: false } } });
    settings();
    expect(await getPublicAccessDetailsForLicense(c, 1)).toMatchObject({ access: { renewal: { earlyPix: true } } });
    settings({ billingEnabled: false });
    expect(await getPublicAccessDetailsForLicense(c, 1)).toMatchObject({ access: { renewal: { earlyPix: false } } });
  });
});
