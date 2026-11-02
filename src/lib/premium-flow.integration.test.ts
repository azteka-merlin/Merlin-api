import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { URL } from 'node:url';
import type { AppContext } from '../types';
import {
  completePremiumActivation,
  cleanupPremiumActivations,
  completePremiumActivationForLicense,
  claimPremiumGenerationForLicense,
  deletePremiumGame,
  failPremiumActivationReservation,
  getBronzePremiumActivationCycleSummary,
  listPremiumCatalog,
  reservePremiumActivation,
  updatePremiumGame,
} from './premium-games';
import { claimPremiumRetryGrant, createPremiumRetryGrant } from './premium-retry-grants';
import { finishPremiumOperation, readPremiumOperation, startPremiumOperation } from './premium-operations';

const NOW = '2026-11-02T15:00:00.000Z';
const ORIGINAL_AT = '2026-11-02T13:00:00.000Z';
const ORIGINAL_COOLDOWN = '2026-11-03T13:00:00.000Z';

/** Execute the same prepared SQL and transactional batches that D1 accepts. */
function fixture() {
  const db = new DatabaseSync(':memory:');
  const writes: { sql: string; changes: number; lastRowId: number }[] = [];
  db.exec('PRAGMA foreign_keys=ON;');
  const migrationDirectory = new URL('../../migrations/', import.meta.url);
  for (const file of readdirSync(migrationDirectory).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(file, migrationDirectory), 'utf8'));
  }

  class Prepared {
    constructor(readonly sql: string, readonly args: unknown[] = []) {}
    bind(...args: unknown[]) { return new Prepared(this.sql, args); }
    runSync() {
      const before = Number(db.prepare('SELECT total_changes() AS changes').get()?.changes);
      const result = db.prepare(this.sql).run(...this.args as []);
      // D1 reports the total change delta, including rows changed by triggers.
      // Read it for each statement so a batch does not include its siblings.
      const changes = Number(db.prepare('SELECT total_changes() AS changes').get()?.changes) - before;
      const lastRowId = Number(result.lastInsertRowid);
      writes.push({ sql: this.sql, changes, lastRowId });
      return { success: true, results: [], meta: { changes, last_row_id: lastRowId } };
    }
    async run() { return this.runSync(); }
    async all() { return { success: true, results: db.prepare(this.sql).all(...this.args as []) }; }
    async first(column?: string) {
      const row = db.prepare(this.sql).get(...this.args as []) || null;
      return column ? row?.[column] ?? null : row;
    }
  }
  const database = {
    prepare(sql: string) { return new Prepared(sql); },
    async batch(statements: Prepared[]) {
      db.exec('BEGIN IMMEDIATE;');
      try {
        const results = statements.map((statement) => statement.runSync());
        db.exec('COMMIT;');
        return results;
      } catch (error) {
        db.exec('ROLLBACK;');
        throw error;
      }
    },
  };
  db.exec(`UPDATE billing_settings SET plans_enabled=1 WHERE id=1;`);
  for (const [id, tier] of [[1, 'bronze'], [2, 'ouro'], [3, 'prata']] as const) {
    db.prepare(`INSERT INTO licenses
      (id,license_key,name,contact,contact_type,expires_at,status,license_type,plan_tier,
       created_at,updated_at,billing_current_period_start,billing_current_period_end,access_type)
      VALUES (?,?,?,?,'email',?,'active','normal',?,?,?,?,?,'monthly')`)
      .run(id, `MERLIN-TEST-${id}`, `Pessoa ${id}`, `person${id}@example.com`,
        '2026-12-01T00:00:00.000Z', tier, '2026-11-01T00:00:00.000Z', NOW,
        '2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z');
  }
  db.prepare(`INSERT INTO premium_games
    (app_id,name,archive_key,enabled,activation_limit,created_at,updated_at,access_bronze_enabled,
     access_prata_enabled,access_ouro_enabled,activation_cooldown_hours)
    VALUES ('123','Jogo de teste','123/123.zip',1,1,?,?,1,1,1,24)`)
    .run('2026-10-01T00:00:00.000Z', NOW);
  const c = {
    env: { merlin_db: database, MERLIN_ACTIVATIONS: { head: vi.fn(async () => ({ key: '123/123.zip' })) } },
  } as unknown as AppContext;

  function addActivation({ licenseId = 1, appId = '123', status = 'active', at = ORIGINAL_AT, cooldown = ORIGINAL_COOLDOWN } = {}) {
    return Number(db.prepare(`INSERT INTO premium_activations
      (license_id,app_id,status,reserved_at,activated_at,cooldown_until,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(licenseId, appId, status, at, at, cooldown, at, at).lastInsertRowid);
  }
  function addWish(licenseId: number, { removed = false, phone = null as string | null, consent = null as string | null } = {}) {
    return Number(db.prepare(`INSERT INTO premium_wishlist
      (license_id,app_id,email,phone,phone_consent_at,created_at,updated_at,removed_at)
      VALUES (?,'123',?,?,?,?,?,?)`).run(licenseId, `wish${licenseId}@example.com`, phone, consent, NOW, NOW, removed ? NOW : null).lastInsertRowid);
  }
  return { db, c, addActivation, addWish, writes };
}

type Fixture = ReturnType<typeof fixture>;
const openFixtures: Fixture[] = [];
function useFixture() { const value = fixture(); openFixtures.push(value); return value; }

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(NOW)); });
afterEach(() => { for (const item of openFixtures.splice(0)) item.db.close(); vi.useRealTimers(); });

describe('Premium approved flows against the full migrated database', () => {
  it('counts triggered rows in each D1 batch statement without changing the inserted row ID', async () => {
    const h = useFixture();
    h.addActivation({ licenseId: 3, status: 'expired', at: '2026-10-01T00:00:00.000Z', cooldown: '2026-10-02T00:00:00.000Z' });
    const operationId = 'f8b5a4cb-d138-4962-b45f-5c2be7a1070e';
    await startPremiumOperation(h.c, 1, '123', operationId);
    const [insert, update] = await h.c.env.merlin_db.batch([
      h.c.env.merlin_db.prepare(`INSERT INTO premium_activations
        (license_id,app_id,status,reserved_at,created_at,updated_at,operation_id)
        VALUES (1,'123','reserved',?,?,?,?)`).bind(NOW, NOW, NOW, operationId),
      h.c.env.merlin_db.prepare('UPDATE premium_games SET updated_at=? WHERE app_id=?').bind(NOW, '123'),
    ]);
    if (!insert || !update) throw new Error('Expected one D1 result for each batch statement');
    expect(insert.meta.changes).toBe(2);
    expect(update.meta.changes).toBe(1);
    expect(insert.meta.last_row_id).toBe(2);
    expect(h.db.prepare('SELECT id,reservation_id FROM premium_operations WHERE operation_id=?').get(operationId))
      .toEqual({ id: 1, reservation_id: insert.meta.last_row_id });
  });

  it('reserves, generates and completes a legacy UUID operation without false conflicts or losing the Bronze charge', async () => {
    const h = useFixture();
    h.addActivation({ licenseId: 3, status: 'expired', at: '2026-10-01T00:00:00.000Z', cooldown: '2026-10-02T00:00:00.000Z' });
    const operationId = 'a4778063-403f-4eba-b81d-126837f43025';
    await startPremiumOperation(h.c, 1, '123', operationId);
    const reservation = await reservePremiumActivation(h.c, 1, '123', { operationId });
    expect(reservation.reservationId).toBe(2);
    expect(h.writes.find((write) => /INSERT INTO premium_activations/.test(write.sql)))
      .toMatchObject({ changes: 2, lastRowId: reservation.reservationId });
    expect(h.db.prepare('SELECT id,reservation_id,status FROM premium_operations WHERE operation_id=?').get(operationId))
      .toEqual({ id: 1, reservation_id: reservation.reservationId, status: 'pending' });
    expect((await getBronzePremiumActivationCycleSummary(h.c, 1)).used).toBe(0);

    await expect(claimPremiumGenerationForLicense(h.c, reservation.reservationId, 1, '123')).resolves.toBeUndefined();
    const completed = await completePremiumActivationForLicense(h.c, reservation.reservationId, 1, '123', true);
    expect(h.writes.find((write) => /UPDATE premium_activations\s+SET\s+status = 'active'/.test(write.sql))?.changes).toBe(2);
    expect(h.db.prepare('SELECT id,status,operation_id FROM premium_activations WHERE id=?').get(reservation.reservationId))
      .toEqual({ id: reservation.reservationId, status: 'active', operation_id: operationId });
    expect(await readPremiumOperation(h.c, 1, operationId))
      .toEqual({ status: 'active', appId: '123', cooldownUntil: completed.cooldownUntil });
    expect((await getBronzePremiumActivationCycleSummary(h.c, 1)).used).toBe(1);
    expect(h.db.prepare('SELECT activation_count FROM premium_activation_cycle_usage WHERE license_id=1').get()?.activation_count).toBe(1);
    await expect(completePremiumActivationForLicense(h.c, reservation.reservationId, 1, '123', true)).rejects.toThrow();
    expect((await getBronzePremiumActivationCycleSummary(h.c, 1)).used).toBe(1);
  });

  it('completes a legacy UUID support retry with D1 trigger counts and keeps the Bronze monthly limit intact', async () => {
    const h = useFixture();
    const original = h.addActivation();
    h.addActivation({ status: 'expired', at: '2026-11-01T01:00:00.000Z', cooldown: '2026-11-01T02:00:00.000Z' });
    h.addActivation({ status: 'expired', at: '2026-11-01T03:00:00.000Z', cooldown: '2026-11-01T04:00:00.000Z' });
    expect((await getBronzePremiumActivationCycleSummary(h.c, 1)).used).toBe(3);
    const grant = await createPremiumRetryGrant(h.c, original, 7);
    const operationId = '2f54c526-c89e-44b7-87e9-29fb0c605cf8';
    await startPremiumOperation(h.c, 1, '123', operationId);
    const reservation = await reservePremiumActivation(h.c, 1, '123', { operationId, retryGrantId: grant.id });
    expect(reservation.reservationId).toBe(4);
    expect(h.writes.find((write) => /INSERT INTO premium_activations/.test(write.sql)))
      .toMatchObject({ changes: 3, lastRowId: reservation.reservationId });
    expect(h.db.prepare('SELECT id,reservation_id FROM premium_operations WHERE operation_id=?').get(operationId))
      .toEqual({ id: 1, reservation_id: reservation.reservationId });
    expect(h.db.prepare('SELECT retry_activation_id,status FROM premium_retry_grants WHERE id=?').get(grant.id))
      .toEqual({ retry_activation_id: reservation.reservationId, status: 'processing' });

    await expect(claimPremiumGenerationForLicense(h.c, reservation.reservationId, 1, '123')).resolves.toBeUndefined();
    const completed = await completePremiumActivationForLicense(h.c, reservation.reservationId, 1, '123', true);
    expect(h.writes.find((write) => /UPDATE premium_activations\s+SET\s+status = 'active'/.test(write.sql))?.changes).toBe(4);
    expect(h.db.prepare('SELECT status FROM premium_activations WHERE id=?').get(original)?.status).toBe('expired');
    expect(h.db.prepare('SELECT id,retry_of,status FROM premium_activations WHERE id=?').get(reservation.reservationId))
      .toEqual({ id: reservation.reservationId, retry_of: original, status: 'active' });
    expect(h.db.prepare('SELECT retry_activation_id,status FROM premium_retry_grants WHERE id=?').get(grant.id))
      .toEqual({ retry_activation_id: reservation.reservationId, status: 'used' });
    expect(await readPremiumOperation(h.c, 1, operationId))
      .toEqual({ status: 'active', appId: '123', cooldownUntil: completed.cooldownUntil });
    expect((await getBronzePremiumActivationCycleSummary(h.c, 1)).used).toBe(3);
    expect((await listPremiumCatalog(h.c, 2))[0]!.availability.occupiedSlots).toBe(1);
    expect(h.writes.some((write) => /UPDATE premium_activation_cycle_usage\s+SET activation_count = activation_count - 1/.test(write.sql))).toBe(false);
  });

  it('closes an interrupted operation without a reservation and rejects its delayed request',async()=>{
    const h=useFixture();
    await startPremiumOperation(h.c,2,'123','interrupted-op');
    vi.setSystemTime(new Date('2026-11-02T15:03:01.000Z'));
    await cleanupPremiumActivations(h.c);
    expect((await readPremiumOperation(h.c,2,'interrupted-op')).status).toBe('failed');
    await expect(reservePremiumActivation(h.c,2,'123',{operationId:'interrupted-op'})).rejects.toThrow();
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM premium_activations').get()?.n).toBe(0);
    await startPremiumOperation(h.c,2,'123','replacement-op');
    const reservation=await reservePremiumActivation(h.c,2,'123',{operationId:'replacement-op'});
    expect(h.db.prepare("SELECT reservation_id FROM premium_operations WHERE operation_id='replacement-op'").get()?.reservation_id).toBe(reservation.reservationId);
  });

  it('returns a timed-out retry that never began generation to the remaining support window',async()=>{
    const h=useFixture();const original=h.addActivation();
    const grant=await createPremiumRetryGrant(h.c,original,7);
    await startPremiumOperation(h.c,1,'123','download-timeout-op');
    await reservePremiumActivation(h.c,1,'123',{retryGrantId:grant.id,operationId:'download-timeout-op'});
    vi.setSystemTime(new Date('2026-11-02T15:03:01.000Z'));
    await cleanupPremiumActivations(h.c);
    expect(h.db.prepare('SELECT status,retry_activation_id FROM premium_retry_grants WHERE id=?').get(grant.id)).toEqual({status:'available',retry_activation_id:null});
    expect((await readPremiumOperation(h.c,1,'download-timeout-op')).status).toBe('failed');
    expect(h.db.prepare('SELECT cooldown_until FROM premium_activations WHERE id=?').get(original)?.cooldown_until).toBe(ORIGINAL_COOLDOWN);
  });

  it('starts the generation timeout when generation begins and holds an uncertain result for support',async()=>{
    const h=useFixture();const original=h.addActivation();
    const grant=await createPremiumRetryGrant(h.c,original,7);
    await startPremiumOperation(h.c,1,'123','generation-timeout');
    const reservation=await reservePremiumActivation(h.c,1,'123',{retryGrantId:grant.id,operationId:'generation-timeout'});
    vi.setSystemTime(new Date('2026-11-02T15:02:00.000Z'));
    await claimPremiumGenerationForLicense(h.c,reservation.reservationId,1,'123');
    vi.setSystemTime(new Date('2026-11-02T15:03:01.000Z'));
    await cleanupPremiumActivations(h.c);
    expect((await readPremiumOperation(h.c,1,'generation-timeout')).status).toBe('pending');
    vi.setSystemTime(new Date('2026-11-02T15:05:01.000Z'));
    await cleanupPremiumActivations(h.c);
    expect((await readPremiumOperation(h.c,1,'generation-timeout')).status).toBe('review');
    expect(h.db.prepare('SELECT status FROM premium_retry_grants WHERE id=?').get(grant.id)?.status).toBe('review');
    expect(h.db.prepare('SELECT status,cooldown_until FROM premium_activations WHERE id=?').get(original)).toEqual({status:'active',cooldown_until:ORIGINAL_COOLDOWN});
  });
  it('holds the same public slot for an unused exclusive grant and restores the original cooldown after 15 minutes', async () => {
    const h = useFixture();
    const original = h.addActivation();
    const grant = await createPremiumRetryGrant(h.c, original, 7);
    const owner = (await listPremiumCatalog(h.c, 1))[0]!;
    const other = (await listPremiumCatalog(h.c, 2))[0]!;
    expect(owner.viewer.retry?.id).toBe(grant.id);
    expect(owner.viewer.canActivate).toBe(true);
    expect(other.viewer.canActivate).toBe(false);
    expect(other.availability.occupiedSlots).toBe(1);
    expect(other.availability.nextSlotAt).toBe(ORIGINAL_COOLDOWN);
    expect(other.availability.cooldownEntries.some((entry) => entry.availableAt === grant.expiresAt)).toBe(false);

    vi.setSystemTime(new Date('2026-11-02T15:15:00.000Z'));
    expect(await claimPremiumRetryGrant(h.c, grant.id, 1, '123')).toBe(false);
    const after = (await listPremiumCatalog(h.c, 1))[0]!;
    expect(after.viewer.retry).toBeNull();
    expect(after.viewer.canActivate).toBe(false);
    expect(after.viewer.cooldownUntil).toBe(ORIGINAL_COOLDOWN);
    expect(h.db.prepare('SELECT status,activated_at,cooldown_until FROM premium_activations WHERE id=?').get(original))
      .toEqual({ status: 'active', activated_at: ORIGINAL_AT, cooldown_until: ORIGINAL_COOLDOWN });
  });

  it('accepts one owner claim and rejects a different license or duplicate click', async () => {
    const h = useFixture();
    const original = h.addActivation();
    const grant = await createPremiumRetryGrant(h.c, original, 7);
    await expect(reservePremiumActivation(h.c, 2, '123', { retryGrantId: grant.id })).rejects.toThrow();
    const results = await Promise.allSettled([
      reservePremiumActivation(h.c, 1, '123', { retryGrantId: grant.id }),
      reservePremiumActivation(h.c, 1, '123', { retryGrantId: grant.id }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(h.db.prepare('SELECT COUNT(*) AS total FROM premium_activations WHERE retry_of=?').get(original)?.total).toBe(1);
    expect(h.db.prepare('SELECT status FROM premium_activations WHERE id=?').get(original)?.status).toBe('active');
  });

  it('reserves capacity for a retry whose original public slot has already elapsed without announcing its expiry as a public vacancy', async () => {
    const h = useFixture();
    const original = h.addActivation({ at: '2026-11-01T12:00:00.000Z' });
    const grant = await createPremiumRetryGrant(h.c, original, 7);
    const other = (await listPremiumCatalog(h.c, 2))[0]!;
    expect(other.availability.occupiedSlots).toBe(1);
    expect(other.availability.reservedCount).toBe(1);
    expect(other.availability.cooldownEntries.some((entry) => entry.availableAt === grant.expiresAt)).toBe(false);
    await expect(reservePremiumActivation(h.c, 2, '123')).rejects.toThrow();
    vi.setSystemTime(new Date(grant.expiresAt));
    expect((await listPremiumCatalog(h.c, 2))[0]!.availability.availableSlots).toBe(1);
    expect((await listPremiumCatalog(h.c, 1))[0]!.viewer.cooldownUntil).toBe(ORIGINAL_COOLDOWN);
  });

  it('does not take another customer slot to authorize an old correction after its public slot elapsed', async () => {
    const h = useFixture();
    const original = h.addActivation({ at: '2026-11-01T12:00:00.000Z' });
    h.addActivation({ licenseId: 2, at: '2026-11-02T14:00:00.000Z', cooldown: '2026-11-03T14:00:00.000Z' });
    await expect(createPremiumRetryGrant(h.c, original, 7)).rejects.toThrow();
    expect(h.db.prepare('SELECT COUNT(*) AS total FROM premium_retry_grants').get()?.total).toBe(0);
    expect((await listPremiumCatalog(h.c, 2))[0]!.availability.occupiedSlots).toBe(1);
  });

  it('completes a Bronze correction at the monthly limit without charging twice or duplicating a slot', async () => {
    const h = useFixture();
    const original = h.addActivation();
    h.addActivation({ status: 'expired', at: '2026-11-01T01:00:00.000Z', cooldown: '2026-11-01T02:00:00.000Z' });
    h.addActivation({ status: 'expired', at: '2026-11-01T03:00:00.000Z', cooldown: '2026-11-01T04:00:00.000Z' });
    expect((await getBronzePremiumActivationCycleSummary(h.c, 1)).used).toBe(3);
    const grant = await createPremiumRetryGrant(h.c, original, 7);
    const reservation = await reservePremiumActivation(h.c, 1, '123', { retryGrantId: grant.id });
    const during = (await listPremiumCatalog(h.c, 2))[0]!;
    expect(during.availability.occupiedSlots).toBe(1);
    expect(during.availability.reservedCount).toBe(0);
    const completed = await completePremiumActivation(h.c, reservation.reservationId);
    expect(completed.activatedAt).toBe(NOW);
    expect(completed.cooldownUntil).toBe('2026-11-03T15:00:00.000Z');
    expect(h.db.prepare('SELECT status FROM premium_activations WHERE id=?').get(original)?.status).toBe('expired');
    expect(h.db.prepare('SELECT retry_of,status FROM premium_activations WHERE id=?').get(reservation.reservationId))
      .toEqual({ retry_of: original, status: 'active' });
    expect(h.db.prepare('SELECT status FROM premium_retry_grants WHERE id=?').get(grant.id)?.status).toBe('used');
    expect((await getBronzePremiumActivationCycleSummary(h.c, 1)).used).toBe(3);
    expect((await listPremiumCatalog(h.c, 2))[0]!.availability.occupiedSlots).toBe(1);
  });

  it('requires explicit support confirmation for an unknown retry and retains the original cooldown', async () => {
    const h = useFixture();
    const original = h.addActivation();
    const grant = await createPremiumRetryGrant(h.c, original, 7);
    const reservation = await reservePremiumActivation(h.c, 1, '123', { retryGrantId: grant.id });
    await failPremiumActivationReservation(h.c, reservation.reservationId, 'uncertain_result', 'A resposta do gerador se perdeu.', true);
    expect((await listPremiumCatalog(h.c, 1))[0]!.viewer.retry?.status).toBe('review');
    await expect(createPremiumRetryGrant(h.c, original, 7)).rejects.toThrow();
    expect(await claimPremiumRetryGrant(h.c, grant.id, 1, '123')).toBe(false);
    const authorized = await createPremiumRetryGrant(h.c, original, 7, new Date(), true);
    expect(authorized.id).not.toBe(grant.id);
    expect(h.db.prepare('SELECT status FROM premium_retry_grants WHERE id=?').get(grant.id)?.status).toBe('canceled');
    expect(h.db.prepare('SELECT cooldown_until FROM premium_activations WHERE id=?').get(original)?.cooldown_until).toBe(ORIGINAL_COOLDOWN);
    await expect(reservePremiumActivation(h.c, 1, '123', { retryGrantId: authorized.id })).resolves.toMatchObject({ archiveAvailable: true });
  });

  it('queues every current wishlist email on publication even for plans without release access', async () => {
    const h = useFixture();
    h.db.prepare('UPDATE premium_games SET coming_soon=1,access_bronze_enabled=0,access_prata_enabled=0 WHERE app_id=?').run('123');
    h.addWish(1);
    h.addWish(2, { phone: '11999999999', consent: NOW });
    h.addWish(3, { removed: true });
    expect((await listPremiumCatalog(h.c, 1))[0]!.comingSoon).toBe(true);
    await expect(reservePremiumActivation(h.c, 1, '123')).rejects.toThrow('Premium game not found');
    await updatePremiumGame(h.c, '123', { comingSoon: false });
    const published=(await listPremiumCatalog(h.c,1))[0]!;
    expect(published.viewer.canActivate).toBe(false);
    expect(published.viewer.tierAvailability.find(tier=>tier.tier==='prata')?.availableAt).toBe('2026-11-07T15:00:00.000Z');
    expect(published.viewer.tierAvailability.find(tier=>tier.tier==='bronze')?.availableAt).toBe('2026-11-09T15:00:00.000Z');
    expect(h.db.prepare('SELECT license_id,email,status,kind FROM premium_notification_outbox ORDER BY license_id').all())
      .toEqual([
        { license_id: 1, email: 'wish1@example.com', status: 'scheduled', kind: 'game_available' },
        { license_id: 2, email: 'wish2@example.com', status: 'scheduled', kind: 'game_available' },
      ]);
    expect(h.db.prepare('SELECT COUNT(*) AS total FROM premium_wishlist WHERE removed_at IS NULL').get()?.total).toBe(2);
    await updatePremiumGame(h.c, '123', { name: 'Novo título' });
    expect(h.db.prepare('SELECT COUNT(*) AS total FROM premium_notification_outbox').get()?.total).toBe(2);
  });

  it('rolls back publication if inserting the notification queue fails', async () => {
    const h = useFixture();
    h.db.prepare('UPDATE premium_games SET coming_soon=1 WHERE app_id=?').run('123');
    h.addWish(1);
    h.db.exec(`CREATE TRIGGER reject_notification BEFORE INSERT ON premium_notification_outbox BEGIN SELECT RAISE(ABORT,'test queue write failed'); END;`);
    await expect(updatePremiumGame(h.c, '123', { comingSoon: false })).rejects.toThrow('test queue write failed');
    expect(h.db.prepare('SELECT coming_soon,available_at FROM premium_games WHERE app_id=?').get('123'))
      .toEqual({ coming_soon: 1, available_at: null });
  });

  it('allows deleting a game after a person removes it from their wishlist', async () => {
    const h = useFixture();
    h.addWish(1, { removed: true });
    await expect(deletePremiumGame(h.c, '123')).resolves.toBe(true);
    expect(h.db.prepare('SELECT COUNT(*) AS total FROM premium_wishlist').get()?.total).toBe(0);
  });

  it('scopes operation status to its owner and atomically confirms the resulting cooldown', async () => {
    const h = useFixture();
    await startPremiumOperation(h.c, 2, '123', 'opaque-operation');
    expect(await readPremiumOperation(h.c, 1, 'opaque-operation')).toEqual({ status: 'failed', cooldownUntil: null, appId: '0' });
    await expect(startPremiumOperation(h.c, 1, '123', 'opaque-operation')).rejects.toThrow();
    expect(await readPremiumOperation(h.c, 2, 'opaque-operation')).toMatchObject({ status: 'pending', appId: '123' });
    await expect(startPremiumOperation(h.c, 2, '123', 'opaque-operation')).rejects.toThrow();
    const reservation = await reservePremiumActivation(h.c, 2, '123', { operationId: 'opaque-operation' });
    const completion = await completePremiumActivation(h.c, reservation.reservationId);
    expect(await readPremiumOperation(h.c, 2, 'opaque-operation')).toEqual({ status: 'active', appId: '123', cooldownUntil: completion.cooldownUntil });
    await finishPremiumOperation(h.c, 2, 'opaque-operation', 'failed');
    expect((await readPremiumOperation(h.c, 2, 'opaque-operation')).status).toBe('active');
  });

  it('closes a missing operation so a delayed activation cannot start after the client was told it failed', async () => {
    const h = useFixture();
    expect((await readPremiumOperation(h.c, 1, 'delayed-request')).status).toBe('failed');
    await expect(startPremiumOperation(h.c, 1, '123', 'delayed-request')).rejects.toThrow();
    expect(h.db.prepare('SELECT COUNT(*) AS total FROM premium_activations').get()?.total).toBe(0);
  });

  it('claims generation once before invoking the generator and confirms a processing reservation with its operation', async () => {
    const h = useFixture();
    await startPremiumOperation(h.c, 2, '123', 'claimed-operation');
    const reservation = await reservePremiumActivation(h.c, 2, '123', { operationId: 'claimed-operation' });
    const generator = vi.fn(async () => 'local-test-ticket');
    const generateOnce = async () => {
      await claimPremiumGenerationForLicense(h.c, reservation.reservationId, 2, '123');
      return generator();
    };
    await expect(claimPremiumGenerationForLicense(h.c, reservation.reservationId, 1, '123')).rejects.toThrow();
    const results = await Promise.allSettled([generateOnce(), generateOnce()]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(generator).toHaveBeenCalledTimes(1);
    expect(h.db.prepare('SELECT status FROM premium_activations WHERE id=?').get(reservation.reservationId)?.status).toBe('processing');
    await expect(completePremiumActivationForLicense(h.c, reservation.reservationId, 1, '123', true)).rejects.toThrow();
    const completed = await completePremiumActivationForLicense(h.c, reservation.reservationId, 2, '123', true);
    expect(await readPremiumOperation(h.c, 2, 'claimed-operation'))
      .toEqual({ status: 'active', appId: '123', cooldownUntil: completed.cooldownUntil });
    await expect(completePremiumActivationForLicense(h.c, reservation.reservationId, 2, '123', true)).rejects.toThrow();
  });

  it.each(['pending', 'review'] as const)('blocks a second operation while an earlier operation is %s', async (status) => {
    const h = useFixture();
    await startPremiumOperation(h.c, 2, '123', 'previous-operation');
    if (status === 'review') await finishPremiumOperation(h.c, 2, 'previous-operation', 'review');
    const item = (await listPremiumCatalog(h.c, 2))[0]!;
    expect(item.viewer.status).toBe('reserved');
    expect(item.viewer.canActivate).toBe(false);
    expect((await listPremiumCatalog(h.c, 1))[0]!.viewer.canActivate).toBe(true);
    await startPremiumOperation(h.c, 2, '123', 'second-operation');
    await expect(reservePremiumActivation(h.c, 2, '123', { operationId: 'second-operation' })).rejects.toThrow('Há uma tentativa aguardando confirmação');
    expect(h.db.prepare('SELECT COUNT(*) AS total FROM premium_activations').get()?.total).toBe(0);
  });
});
