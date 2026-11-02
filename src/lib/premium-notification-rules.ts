/** A predicted release represents one slot that will become public. Temporary
 * reservations and support-only retries are not reliable public releases. */
export type PremiumSlotState = {
  occupied: number;
  limit: number;
  publicReleaseTimes: string[];
};

export function nextPublicPremiumSlot(state: PremiumSlotState, now = new Date()): string | null {
  if (!Number.isInteger(state.occupied) || !Number.isInteger(state.limit) || state.limit < 1 || state.occupied < 0) return null;
  if (state.occupied < state.limit) return now.toISOString();
  const needed = state.occupied - state.limit + 1;
  const releases = state.publicReleaseTimes
    .map(value => Date.parse(value))
    .filter(value => Number.isFinite(value) && value > now.getTime())
    .sort((a, b) => a - b);
  return releases.length >= needed ? new Date(releases[needed - 1]!).toISOString() : null;
}

export type PremiumRetryGrant = {
  licenseId: number;
  appId: string;
  status: 'available' | 'processing' | 'used' | 'expired' | 'canceled' | 'review';
  expiresAt: string;
};

/** The deadline applies when starting. An already processing attempt is not
 * interrupted at the deadline; uncertain outcomes require support review. */
export function canStartPremiumRetry(grant: PremiumRetryGrant, licenseId: number, appId: string, now = new Date()): boolean {
  const expires = Date.parse(grant.expiresAt);
  return grant.status === 'available' && grant.licenseId === licenseId && grant.appId === appId
    && Number.isFinite(expires) && expires > now.getTime();
}
