import { describe, expect, it } from 'vitest';
import { canStartPremiumRetry, nextPublicPremiumSlot } from './premium-notification-rules';

describe('premium slot forecasts', () => {
  const now = new Date('2026-11-02T15:00:00.000Z');
  it('waits for enough public releases if occupation exceeds the limit', () => {
    expect(nextPublicPremiumSlot({ occupied: 6, limit: 5, publicReleaseTimes: [
      '2026-11-02T15:20:00Z', '2026-11-02T15:10:00Z',
    ] }, now)).toBe('2026-11-02T15:20:00.000Z');
  });
  it('does not promise a public slot from an unknown or private release', () => {
    expect(nextPublicPremiumSlot({ occupied: 5, limit: 5, publicReleaseTimes: [] }, now)).toBeNull();
    expect(nextPublicPremiumSlot({ occupied: 4, limit: 5, publicReleaseTimes: [] }, now)).toBe(now.toISOString());
  });
});

describe('support retry authorization', () => {
  const grant = { licenseId: 4, appId: '123', status: 'available' as const, expiresAt: '2026-11-02T15:15:00Z' };
  it('permits only the matching license and game before the deadline', () => {
    expect(canStartPremiumRetry(grant, 4, '123', new Date('2026-11-02T15:14:59Z'))).toBe(true);
    expect(canStartPremiumRetry(grant, 4, '123', new Date('2026-11-02T15:15:00Z'))).toBe(false);
    expect(canStartPremiumRetry(grant, 5, '123', new Date('2026-11-02T15:01:00Z'))).toBe(false);
    expect(canStartPremiumRetry(grant, 4, '124', new Date('2026-11-02T15:01:00Z'))).toBe(false);
  });
  it('does not allow a duplicate or uncertain attempt to start', () => {
    for (const status of ['processing', 'used', 'review', 'canceled', 'expired'] as const) {
      expect(canStartPremiumRetry({ ...grant, status }, 4, '123', new Date('2026-11-02T15:01:00Z'))).toBe(false);
    }
  });
});
