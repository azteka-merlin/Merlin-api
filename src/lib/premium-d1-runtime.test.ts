import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { Miniflare } from 'miniflare';
import worker from '../index';
import type { AppBindings, AppContext } from '../types';
import { signAccessToken } from './auth';
import { createPremiumRetryGrant } from './premium-retry-grants';

const NOW = '2026-11-02T15:00:00.000Z';
const TEST_SECRET = 'premium-local-regression-only';
const runtimes: Miniflare[] = [];

async function fixture() {
  // Compile the current migration history, including its actual triggers. Never
  // replace D1 run()/meta.changes with a hand-written database adapter here.
  const schema = new DatabaseSync(':memory:');
  let definitions: string[];
  try {
    const directory = new NodeURL('../../migrations/', import.meta.url);
    for (const name of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) {
      schema.exec(readFileSync(new NodeURL(name, directory), 'utf8'));
    }
    definitions = schema.prepare(`SELECT sql FROM sqlite_master
      WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
        AND tbl_name NOT IN (SELECT name FROM pragma_table_list WHERE type='shadow')
      ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END`)
      .all().map(row => String(row.sql));
  } finally { schema.close(); }

  const runtime = new Miniflare({
    modules: true, script: 'export default { fetch() { return new Response("local test only"); } };',
    compatibilityDate: '2026-06-20', d1Databases: ['DB'],
  });
  runtimes.push(runtime);
  const database = await runtime.getD1Database('DB');
  await database.batch(definitions.map(sql => database.prepare(sql)));
  await database.prepare(`INSERT INTO billing_settings
    (id,plans_enabled,updated_at) VALUES (1,1,?)`).bind(NOW).run();
  for (const [id, tier] of [[1, 'bronze'], [2, 'ouro'], [3, 'ouro']] as const) {
    await database.prepare(`INSERT INTO licenses
      (id,license_key,name,contact,contact_type,hwid,expires_at,status,license_type,plan_tier,
       created_at,updated_at,billing_current_period_start,billing_current_period_end,access_type)
      VALUES (?,?,?,?,'email',?,?,'active','normal',?,?,?,?,?,'monthly_subscription')`)
      .bind(id, `MERLIN-LOCAL-TEST-${id}`, `Pessoa ${id}`, `person${id}@example.test`, `device-${id}`,
        '2026-12-01T00:00:00.000Z', tier, '2026-11-01T00:00:00.000Z', NOW,
        '2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z').run();
  }
  await database.prepare(`INSERT INTO premium_games
    (app_id,name,archive_key,enabled,activation_limit,activation_type,created_at,updated_at,
     access_bronze_enabled,access_prata_enabled,access_ouro_enabled,activation_cooldown_hours)
    VALUES ('123','Jogo local','123/123.zip',1,1,'steam_ticket',?,?,1,1,1,24)`)
    .bind('2026-10-01T00:00:00.000Z', NOW).run();

  const generate = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) !== 'https://premium-generator.test.invalid/ticket-jobs') {
      throw new Error('External network is forbidden in Premium regression tests');
    }
    return Response.json({ parsed: { ticket: 'local-fixture-ticket' }, configIni: 'fixture-config' });
  });
  vi.stubGlobal('fetch', generate);
  const env = {
    merlin_db: database, JWT_SECRET: TEST_SECRET,
    STEAM_ACCOUNT_ID: '76561198000000000', MERLIN_WORKER_TOKEN: 'fixture-only',
    MERLIN_WORKER_URL: 'https://premium-generator.test.invalid',
    MERLIN_ACTIVATIONS: { head: vi.fn(async () => ({ key: '123/123.zip' })) },
  } as unknown as AppBindings;
  const c = { env } as AppContext;
  async function activate(licenseId: number, extra: Record<string, unknown> = {}) {
    const token = await signAccessToken({ sub: licenseId, hwid: `device-${licenseId}`, type: 'access',
      exp: Math.floor(Date.now() / 1000) + 3600, jti: `fixture-${licenseId}` }, TEST_SECRET);
    return worker.fetch(new Request('https://api.example.test/api/premium/activate', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: '123', ...extra }),
    }), env, {} as ExecutionContext);
  }
  async function addActivation(status: 'active' | 'expired', at: string) {
    const result = await database.prepare(`INSERT INTO premium_activations
      (license_id,app_id,status,reserved_at,activated_at,cooldown_until,created_at,updated_at)
      VALUES (1,'123',?,?,?,?,?,?)`).bind(status, at, at,
        status === 'active' ? '2026-11-03T13:00:00.000Z' : '2026-11-02T01:00:00.000Z', at, at).run();
    return Number(result.meta.last_row_id);
  }
  return { database, c, activate, addActivation, generate };
}

beforeEach(() => {
  // Do not fake runtime timers: workerd runs on its own clock and local IPC.
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
});

describe('Premium HTTP regression with native local D1 and migrated triggers', () => {
  it.each([undefined, 'client-operation-123'])('completes a normal Premium activation (operationId=%s)', async operationId => {
    const h = await fixture();
    const response = await h.activate(1, operationId ? { operationId } : {});
    const body = await response.json() as { success: boolean; cooldownUntil: string; activation: { ticket: string } };
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ success: true, cooldownUntil: '2026-11-03T15:00:00.000Z', activation: { ticket: 'local-fixture-ticket' } });
    expect(h.generate).toHaveBeenCalledTimes(1);
    const activation = await h.database.prepare('SELECT id,status,operation_id FROM premium_activations').first<{ id: number; status: string; operation_id: string }>();
    expect(activation?.status).toBe('active');
    if (operationId) expect(activation?.operation_id).toBe(operationId);
    else expect(activation?.operation_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(await h.database.prepare('SELECT reservation_id,status,cooldown_until FROM premium_operations').first())
      .toEqual({ reservation_id: activation!.id, status: 'active', cooldown_until: body.cooldownUntil });
    expect(await h.database.prepare('SELECT activation_count FROM premium_activation_cycle_usage WHERE license_id=1').first('activation_count')).toBe(1);

    const duplicate = await h.activate(1, operationId ? { operationId } : {});
    expect(duplicate.status).toBe(409);
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(await h.database.prepare('SELECT COUNT(*) AS n FROM premium_activations').first('n')).toBe(1);
    expect(await h.database.prepare('SELECT activation_count FROM premium_activation_cycle_usage WHERE license_id=1').first('activation_count')).toBe(1);
  }, 30000);

  it('completes a support retry with multiple native trigger writes without charging Bronze twice', async () => {
    const h = await fixture();
    const original = await h.addActivation('active', '2026-11-02T13:00:00.000Z');
    await h.addActivation('expired', '2026-11-01T01:00:00.000Z');
    await h.addActivation('expired', '2026-11-01T03:00:00.000Z');
    const grant = await createPremiumRetryGrant(h.c, original, 7);
    const response = await h.activate(1, { retryGrantId: grant.id, operationId: 'support-retry-operation' });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(await h.database.prepare('SELECT status FROM premium_activations WHERE id=?').bind(original).first('status')).toBe('expired');
    expect(await h.database.prepare('SELECT retry_of,status FROM premium_activations WHERE operation_id=?').bind('support-retry-operation').first())
      .toEqual({ retry_of: original, status: 'active' });
    expect(await h.database.prepare('SELECT status FROM premium_retry_grants WHERE id=?').bind(grant.id).first('status')).toBe('used');
    expect(await h.database.prepare('SELECT COUNT(*) AS n FROM premium_activations WHERE status=\'active\'').first('n')).toBe(1);
    expect(await h.database.prepare('SELECT COUNT(*) AS n FROM premium_activations WHERE retry_of IS NULL AND activated_at IS NOT NULL').first('n')).toBe(3);
    // Retry must not refund or add a monthly charge, including when no counter was initialized yet.
    const count = await h.database.prepare('SELECT activation_count FROM premium_activation_cycle_usage WHERE license_id=1').first('activation_count');
    expect(count === null || count === 3).toBe(true);
  }, 30000);

  it('gives the last slot to only one of two concurrent customers', async () => {
    const h = await fixture();
    const responses = await Promise.all([h.activate(2), h.activate(3)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(await h.database.prepare('SELECT COUNT(*) AS n FROM premium_activations').first('n')).toBe(1);
    expect(await h.database.prepare('SELECT COUNT(*) AS n FROM premium_activations WHERE status=\'reserved\'').first('n')).toBe(0);
  }, 30000);
});
