type ExpiredCardRenewalLicense = {
  status: string;
  expires_at: string;
  billing_status?: string | null;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  access_type?: string | null;
};

function isRecurringPixAccess(accessType?: string | null) {
  return ["monthly_subscription", "annual_subscription", "annual_manual"].includes(accessType || "");
}

// `status` is denormalized in D1 while entitlement expiry is calculated from
// `expires_at`. Admin tests may persist either active or expired, so both are
// valid expired states. Revoked licenses are intentionally never renewable.
export function isEligibleForExpiredCardRenewal(
  license: ExpiredCardRenewalLicense,
  now = Date.now(),
) {
  const expiresAt = new Date(license.expires_at).getTime();
  const hasExpired = Number.isFinite(expiresAt) && expiresAt < now;
  const hasRenewableStatus = license.status === "active" || license.status === "expired";
  const isCardAccess = Boolean(license.stripe_customer_id && license.stripe_subscription_id);
  const isRecurring = ["monthly_subscription", "annual_subscription"].includes(license.access_type || "");

  return hasExpired
    && hasRenewableStatus
    && isCardAccess
    && isRecurring
    && license.billing_status === "canceled";
}

export function isEligibleForExpiredPixRenewal(
  license: ExpiredCardRenewalLicense,
  now = Date.now(),
) {
  const expiresAt = new Date(license.expires_at).getTime();
  const hasExpired = Number.isFinite(expiresAt) && expiresAt < now;
  const hasRenewableStatus = license.status === "active" || license.status === "expired";
  const isPixAccess = !license.stripe_customer_id && !license.stripe_subscription_id;
  const isRecurring = isRecurringPixAccess(license.access_type);

  return hasExpired && hasRenewableStatus && isPixAccess && isRecurring;
}

// Pix may be paid ahead of time during the final four days of an access period.
// Reminder e-mails may start later, but renewal cannot become unavailable as the
// deadline gets closer. Stripe subscriptions remain excluded because they renew
// through Stripe.
export function isEligibleForEarlyPixRenewal(
  license: ExpiredCardRenewalLicense,
  now = Date.now(),
) {
  const expiresAt = new Date(license.expires_at).getTime();
  const latest = now + 4 * 24 * 60 * 60 * 1000;
  const isPixAccess = !license.stripe_customer_id && !license.stripe_subscription_id;
  const isRecurring = isRecurringPixAccess(license.access_type);

  return license.status === "active"
    && isPixAccess
    && isRecurring
    && Number.isFinite(expiresAt)
    && expiresAt >= now
    && expiresAt <= latest;
}
