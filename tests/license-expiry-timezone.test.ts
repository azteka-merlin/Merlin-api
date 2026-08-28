import { describe, expect, it } from "vitest";
import { isLicenseDateExpired, toIsoDateEndBrt } from "../src/lib/licenses";

describe("admin license expiry dates", () => {
  it("keeps an admin-selected date valid through the end of the BRT day", () => {
    const expiresAt = toIsoDateEndBrt("2026-08-28");

    expect(expiresAt).toBe("2026-08-29T02:59:59.999Z");
    expect(isLicenseDateExpired(expiresAt, new Date("2026-08-28T23:59:59.998-03:00"))).toBe(false);
    expect(isLicenseDateExpired(expiresAt, new Date("2026-08-29T00:00:00.000-03:00"))).toBe(true);
  });
});
