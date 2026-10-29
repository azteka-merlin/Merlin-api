type ExistingLicenseSnapshot = {
  status: string;
  expires_at: string;
};

export function addReactivationEvidence(
  evidenceJson: string,
  license: ExistingLicenseSnapshot | null | undefined,
  now = new Date(),
) {
  if (!license) return evidenceJson;

  let evidence: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(evidenceJson) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      evidence = parsed as Record<string, unknown>;
    }
  } catch {
    // Keep the checkout flow usable if the previous evidence blob is malformed.
  }

  const expiredAt = Date.parse(license.expires_at);
  const reason = license.status === "revoked"
    ? "revoked"
    : license.status === "expired" || (Number.isFinite(expiredAt) && expiredAt <= now.getTime())
      ? "expired"
      : "free_to_paid";

  return JSON.stringify({
    ...evidence,
    reactivationReason: reason,
    reactivationPreviousExpiresAt: reason === "expired" ? license.expires_at : null,
  });
}
