import { describe, expect, it, vi } from "vitest";
import { signAccessToken } from "./auth";
import { requireGoldLauncherLicense } from "./launcher-auth";
import type { AppContext } from "../types";

const jwtSecret = "test-secret-for-launcher-auth";

async function contextForTier(planTier: string | null, overrides: { status?: string; expiresAt?: string } = {}) {
	const token = await signAccessToken({
		sub: 7,
		hwid: "machine-1",
		type: "access",
		exp: Math.floor(Date.now() / 1000) + 60,
		jti: crypto.randomUUID(),
	}, jwtSecret);
	const row = {
		id: 7,
		license_key: "MERLIN-TEST-KEY",
		name: "Test User",
		hwid: "machine-1",
		expires_at: overrides.expiresAt || new Date(Date.now() + 60_000).toISOString(),
		status: overrides.status || "active",
		plan_tier: planTier,
	};
	const first = vi.fn().mockResolvedValue(row);
	const bind = vi.fn().mockReturnValue({ first });
	const prepare = vi.fn().mockReturnValue({ bind });
	const context = {
		env: { JWT_SECRET: jwtSecret, merlin_db: { prepare } },
		req: { raw: new Request("https://api-merlin.test/custom-games", { headers: { authorization: `Bearer ${token}` } }) },
	} as unknown as AppContext;
	return { context, prepare };
}

describe("Gold-only custom-game entitlement", () => {
	it("allows an active Gold license, including legacy rows without plan_tier", async () => {
		for (const tier of ["ouro", null]) {
			const { context } = await contextForTier(tier);
			await expect(requireGoldLauncherLicense(context)).resolves.toMatchObject({ planTier: "ouro" });
		}
	});

	it("rejects Bronze and Silver licenses with 403", async () => {
		for (const tier of ["bronze", "prata"]) {
			const { context } = await contextForTier(tier);
			await expect(requireGoldLauncherLicense(context)).rejects.toMatchObject({ status: 403 });
		}
	});

	it("keeps the existing active-license checks in force", async () => {
		const { context } = await contextForTier("ouro", {
			status: "expired",
			expiresAt: new Date(Date.now() - 60_000).toISOString(),
		});
		await expect(requireGoldLauncherLicense(context)).rejects.toMatchObject({ status: 401 });
	});
});
