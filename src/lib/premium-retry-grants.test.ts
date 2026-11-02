import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import type { AppContext } from '../types';
import { claimPremiumRetryGrant, createPremiumRetryGrant, finishPremiumRetryFailure } from './premium-retry-grants';

function harness() {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE licenses(id INTEGER PRIMARY KEY);
    CREATE TABLE premium_games(app_id TEXT PRIMARY KEY,enabled INTEGER DEFAULT 1,activation_limit INTEGER DEFAULT 1,updated_at TEXT DEFAULT 'x');
    CREATE TABLE premium_activations(id INTEGER PRIMARY KEY,license_id INTEGER,app_id TEXT,status TEXT,cooldown_until TEXT,
      activated_at TEXT DEFAULT '2026-11-02T14:00:00.000Z',reserved_at TEXT,updated_at TEXT);
    INSERT INTO licenses VALUES(4),(5); INSERT INTO premium_games(app_id) VALUES('123');
    INSERT INTO premium_activations(id,license_id,app_id,status,cooldown_until) VALUES(1,4,'123','active','2026-11-03T12:00:00.000Z');`);
  db.exec(readFileSync(new URL('../../migrations/0090_premium_wishes_and_retries.sql', import.meta.url), 'utf8'));
  const env = { merlin_db: { prepare(sql: string) { return { bind(...args: unknown[]) { return { async run() {
    const result = db.prepare(sql).run(...args as []);
    return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  } }; } }; } } };
  return { db, c: { env } as unknown as AppContext };
}

describe('exclusive premium retry grants', () => {
  it('does not change the original activation and allows only one matching claim', async () => {
    const h = harness();
    const grant = await createPremiumRetryGrant(h.c, 1, 7, new Date('2026-11-02T15:00:00Z'));
    expect(grant.expiresAt).toBe('2026-11-02T15:15:00.000Z');
    expect(h.db.prepare('SELECT status,cooldown_until FROM premium_activations WHERE id=1').get()).toEqual({ status: 'active', cooldown_until: '2026-11-03T12:00:00.000Z' });
    expect(await claimPremiumRetryGrant(h.c, grant.id, 5, '123', new Date('2026-11-02T15:01:00Z'))).toBe(false);
    expect(await claimPremiumRetryGrant(h.c, grant.id, 4, '123', new Date('2026-11-02T15:01:00Z'))).toBe(true);
    expect(await claimPremiumRetryGrant(h.c, grant.id, 4, '123', new Date('2026-11-02T15:01:00Z'))).toBe(false);
    h.db.close();
  });
  it('expires at the deadline and permits reauthorization without freeing a public slot', async () => {
    const h = harness();
    const first = await createPremiumRetryGrant(h.c, 1, 7, new Date('2026-11-02T15:00:00Z'));
    expect(await claimPremiumRetryGrant(h.c, first.id, 4, '123', new Date('2026-11-02T15:15:00Z'))).toBe(false);
    const second = await createPremiumRetryGrant(h.c, 1, 7, new Date('2026-11-02T15:16:00Z'));
    expect(second.id).not.toBe(first.id);
    expect(h.db.prepare('SELECT status FROM premium_retry_grants WHERE id=1').get()?.status).toBe('expired');
    expect(h.db.prepare('SELECT status FROM premium_activations WHERE id=1').get()?.status).toBe('active');
    h.db.close();
  });
  it('returns a definite failure to the remaining window and holds unknown results for review', async () => {
    const h = harness();
    const grant = await createPremiumRetryGrant(h.c, 1, 7, new Date('2026-11-02T15:00:00Z'));
    await claimPremiumRetryGrant(h.c, grant.id, 4, '123', new Date('2026-11-02T15:01:00Z'));
    await finishPremiumRetryFailure(h.c, grant.id, false, new Date('2026-11-02T15:02:00Z'));
    expect(await claimPremiumRetryGrant(h.c, grant.id, 4, '123', new Date('2026-11-02T15:03:00Z'))).toBe(true);
    await finishPremiumRetryFailure(h.c, grant.id, true, new Date('2026-11-02T15:04:00Z'));
    expect(await claimPremiumRetryGrant(h.c, grant.id, 4, '123', new Date('2026-11-02T15:05:00Z'))).toBe(false);
    expect(h.db.prepare('SELECT status FROM premium_retry_grants WHERE id=?').get(grant.id)?.status).toBe('review');
    h.db.close();
  });
});
