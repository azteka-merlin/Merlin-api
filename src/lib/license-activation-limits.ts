import { HTTPException } from "hono/http-exception";
import type { AppContext } from "../types";

export const TEST_LICENSE_NORMAL_LIMIT_CODE = "TEST_LICENSE_NORMAL_ACTIVATION_LIMIT_REACHED";
export const TEST_LICENSE_PREMIUM_LIMIT_CODE = "TEST_LICENSE_PREMIUM_ACTIVATION_LIMIT_REACHED";

type LicenseActivationProfile = {
  license_type: "normal" | "test" | null;
  normal_activation_limit: number | null;
  premium_activation_limit: number | null;
  activation_usage_reset_at: string | null;
};

async function getActivationProfile(c: AppContext, licenseId: number): Promise<LicenseActivationProfile> {
  const profile = await c.env.merlin_db
    .prepare(
      `
        SELECT
          COALESCE(license_type, 'normal') AS license_type,
          normal_activation_limit,
          premium_activation_limit,
          activation_usage_reset_at
        FROM licenses
        WHERE id = ?
        LIMIT 1
      `,
    )
    .bind(licenseId)
    .first<LicenseActivationProfile>();

  if (!profile) {
    throw new HTTPException(401, { message: "License not found" });
  }

  return profile;
}

export async function assertNormalActivationLimit(c: AppContext, licenseId: number, appId: string) {
  const profile = await getActivationProfile(c, licenseId);
  if (profile.license_type !== "test") return;

  const normalizedAppId = String(appId || "").trim();
  const existingForApp = await c.env.merlin_db
    .prepare(
      `
        SELECT id
        FROM user_activity_logs
        WHERE license_id = ?
          AND action = 'game_activation_success'
          AND app_id = ?
          AND (? IS NULL OR created_at > ?)
        LIMIT 1
      `,
    )
    .bind(licenseId, normalizedAppId, profile.activation_usage_reset_at, profile.activation_usage_reset_at)
    .first<{ id: number }>();

  if (existingForApp) return;

  const usage = await c.env.merlin_db
    .prepare(
      `
        SELECT COUNT(DISTINCT app_id) AS total
        FROM user_activity_logs
        WHERE license_id = ?
          AND action = 'game_activation_success'
          AND app_id IS NOT NULL
          AND (? IS NULL OR created_at > ?)
      `,
    )
    .bind(licenseId, profile.activation_usage_reset_at, profile.activation_usage_reset_at)
    .first<{ total: number }>();

  if (Number(usage?.total || 0) >= Number(profile.normal_activation_limit || 0)) {
    const error = new HTTPException(403, { message: "Limite de ativacoes normais da licenca de teste atingido." });
    (error as HTTPException & { code: string }).code = TEST_LICENSE_NORMAL_LIMIT_CODE;
    throw error;
  }
}

export async function assertPremiumActivationLimit(c: AppContext, licenseId: number) {
  const profile = await getActivationProfile(c, licenseId);
  if (profile.license_type !== "test") return;

  const usage = await c.env.merlin_db
    .prepare(
      `
        SELECT COUNT(*) AS total
        FROM premium_activations
        WHERE license_id = ?
          AND status IN ('reserved', 'active', 'expired')
          AND (? IS NULL OR created_at > ?)
      `,
    )
    .bind(licenseId, profile.activation_usage_reset_at, profile.activation_usage_reset_at)
    .first<{ total: number }>();

  if (Number(usage?.total || 0) >= Number(profile.premium_activation_limit || 0)) {
    const error = new HTTPException(403, { message: "Limite de ativacoes premium da licenca de teste atingido." });
    (error as HTTPException & { code: string }).code = TEST_LICENSE_PREMIUM_LIMIT_CODE;
    throw error;
  }
}
