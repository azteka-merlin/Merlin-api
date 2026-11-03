import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import type { AppBindings, AppContext } from '../types';
import type { PremiumGame } from './premium-games';
import { cancelPremiumSlotWatch, listAdminPremiumNotifications, runPremiumNotificationCron, savePremiumSlotWatch } from './premium-notifications';

const state = vi.hoisted(() => ({ games: new Map<string, PremiumGame>(), retries: [] as Array<{id:number;activationId:number;licenseId:number;appId:string;status:'available'|'processing'|'review';expiresAt:string;activatedAt:string|null}>, plansEnabled:true }));
vi.mock('./premium-games', async importOriginal => ({
  ...await importOriginal<typeof import('./premium-games')>(),
  getPremiumGame: vi.fn(async (_c, appId) => state.games.get(appId) || null),
  listOpenPremiumRetries: vi.fn(async () => state.retries),
}));
vi.mock('./plan-tiers', async importOriginal => ({
  ...await importOriginal<typeof import('./plan-tiers')>(),
  getPlanSettings: vi.fn(async () => ({ plansEnabled:state.plansEnabled })),
}));

const at = new Date('2026-11-02T15:00:00.000Z');
const databases: DatabaseSync[] = [];
function harness() {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE licenses(id INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE premium_games(app_id TEXT PRIMARY KEY,name TEXT,cover_url TEXT,enabled INTEGER,created_at TEXT,updated_at TEXT);
    CREATE TABLE premium_activations(id INTEGER PRIMARY KEY,license_id INTEGER,app_id TEXT,status TEXT,cooldown_until TEXT,activated_at TEXT,reserved_at TEXT,updated_at TEXT);
    INSERT INTO licenses VALUES(1,'Player A'),(2,'Player B');
    INSERT INTO premium_games VALUES('123','Upcoming <game>',NULL,1,'2026-11-02T15:00:00.000Z','2026-11-02T15:00:00.000Z');`);
  db.exec(readFileSync(new URL('../../migrations/0090_premium_wishes_and_retries.sql', import.meta.url),'utf8'));
  function prepare(sql: string) {
    let args: unknown[] = [];
    return {
      bind(...values: unknown[]) { args = values; return this; },
      async run() { const r=db.prepare(sql).run(...args as []); return { success:true,meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)} }; },
      async first() { return db.prepare(sql).get(...args as []) || null; },
      async all() { return {results:db.prepare(sql).all(...args as []),success:true}; },
    };
  }
  const env = { RESEND_API_KEY:'test-key',EMAIL_FROM:'Merlin <notice@example.com>',PUBLIC_APP_ORIGIN:'https://test.example.com',merlin_db:{prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      db.exec('BEGIN');
      try { const results=[]; for (const statement of statements) results.push(await statement.run()); db.exec('COMMIT'); return results; }
      catch(error) { db.exec('ROLLBACK'); throw error; }
    },
  } } as unknown as AppBindings;
  const c = { env } as AppContext;
  const game: PremiumGame = { id:1,appId:'123',name:'Upcoming <game>',coverUrl:null,archiveKey:'game.zip',installSubpath:null,
    activationType:'steam_ticket',launchExecutablePath:null,activationLimit:1,activationCooldownHours:24,
    accessBronzeEnabled:false,accessPrataEnabled:false,accessOuroEnabled:true,featured:false,featuredAt:null,
    enabled:true,comingSoon:false,availableAt:at.toISOString(),earlyAccessCount:0,createdAt:at.toISOString(),updatedAt:at.toISOString() };
  state.games.set('123',game);
  const request = vi.fn<typeof fetch>(async () => Response.json({id:'email-id'}));
  const tick = (time=at) => runPremiumNotificationCron(env,time,{request,pause:async()=>{}});
  function active(id=1, release='2026-11-02T15:04:00.000Z', appId='123') {
    const activated=new Date(Date.parse(release)-24*60*60_000).toISOString();
    db.prepare(`INSERT INTO premium_activations(id,license_id,app_id,status,cooldown_until,activated_at,updated_at) VALUES(?,1,?,'active',?,?,?)`).run(id,appId,release,activated,activated);
  }
  function wish(licenseId=1) {
    db.prepare(`INSERT INTO premium_wishlist(license_id,app_id,email,created_at,updated_at) VALUES(?,'123',?,?,?)`).run(licenseId,`player${licenseId}@example.com`,at.toISOString(),at.toISOString());
  }
  function launch() {
    db.prepare(`UPDATE premium_games SET coming_soon=1 WHERE app_id='123'`).run();
    db.prepare(`UPDATE premium_games SET coming_soon=0,available_at=?,updated_at=? WHERE app_id='123'`).run(at.toISOString(),at.toISOString());
  }
  return {db,c,env,game,request,tick,active,wish,launch};
}

beforeEach(()=>{state.games.clear();state.retries=[];state.plansEnabled=true;});
afterEach(()=>{for (const db of databases.splice(0)) db.close();vi.restoreAllMocks();});

describe('Premium notifications',()=>{
  it('requires a valid email and an enabled available game with no public capacity',async()=>{
    const h=harness();
    await expect(savePremiumSlotWatch(h.c,1,'123',{email:'bad'},at)).rejects.toMatchObject({status:400});
    await expect(savePremiumSlotWatch(h.c,1,'123',{email:'one@example.com'},at)).rejects.toMatchObject({status:409});
    h.active();
    h.game.comingSoon=true;
    await expect(savePremiumSlotWatch(h.c,1,'123',{email:'one@example.com'},at)).rejects.toMatchObject({status:409});
    h.game.comingSoon=false;
    await savePremiumSlotWatch(h.c,1,'123',{email:' One@Example.com '},at);
    await savePremiumSlotWatch(h.c,1,'123',{email:'one@example.com'},new Date(at.getTime()+1000));
    expect(h.db.prepare('SELECT email,status,updated_at FROM premium_slot_watches').get()).toEqual({email:'one@example.com',status:'watching',updated_at:at.toISOString()});
  });

  it('sends a single five-minute prediction and marks only that subscription as sent',async()=>{
    const h=harness();h.active();
    await savePremiumSlotWatch(h.c,1,'123',{email:'one@example.com'},at);
    const result=await h.tick();
    expect(result).toMatchObject({sent:1,scheduled:1});
    expect(h.request).toHaveBeenCalledTimes(1);
    const body=JSON.parse(String(h.request.mock.calls[0]![1]!.body));
    expect(body.text).toContain('não reserva a vaga');
    expect(body.text).toContain('02/11/2026, 12:04');
    expect(body.html).toContain('&lt;game&gt;');
    expect(h.db.prepare('SELECT status FROM premium_slot_watches').get()?.status).toBe('sent');
    await h.tick(new Date(at.getTime()+30_000));
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it('schedules early, then reschedules if the public 24h activation changes',async()=>{
    const h=harness();h.active(1,'2026-11-02T16:00:00.000Z');
    await savePremiumSlotWatch(h.c,1,'123',{email:'one@example.com'},at);
    expect(await h.tick()).toMatchObject({scheduled:1,sent:0});
    h.db.prepare(`UPDATE premium_activations SET activated_at='2026-11-01T17:00:00.000Z' WHERE id=1`).run();
    await h.tick(new Date('2026-11-02T15:56:00.000Z'));
    expect(h.request).not.toHaveBeenCalled();
    expect(h.db.prepare(`SELECT status,slot_at FROM premium_notification_outbox ORDER BY id`).all()).toEqual([
      {status:'canceled',slot_at:'2026-11-02T16:00:00.000Z'}, {status:'scheduled',slot_at:'2026-11-02T17:00:00.000Z'},
    ]);
  });

  it('restores a canceled prediction when capacity returns to the same release without duplicating delivery',async()=>{
    const h=harness();h.game.activationLimit=2;
    h.active(1,'2026-11-02T16:00:00.000Z');h.active(2,'2026-11-02T17:00:00.000Z');
    await savePremiumSlotWatch(h.c,1,'123',{email:'one@example.com'},at);
    await h.tick();
    const original=h.db.prepare('SELECT id,dedupe_key FROM premium_notification_outbox').get();
    h.game.activationLimit=1;
    await h.tick(new Date('2026-11-02T15:10:00.000Z'));
    h.game.activationLimit=2;
    expect(await h.tick(new Date('2026-11-02T15:20:00.000Z'))).toMatchObject({scheduled:1,sent:0});
    expect(h.db.prepare('SELECT id,dedupe_key,status,slot_at FROM premium_notification_outbox ORDER BY id').all()).toEqual([
      {...original,status:'scheduled',slot_at:'2026-11-02T16:00:00.000Z'},
      {id:expect.any(Number),dedupe_key:expect.any(String),status:'canceled',slot_at:'2026-11-02T17:00:00.000Z'},
    ]);
    expect(h.request).not.toHaveBeenCalled();
    expect(await h.tick(new Date('2026-11-02T15:56:00.000Z'))).toMatchObject({sent:1});
    await h.tick(new Date('2026-11-02T15:57:00.000Z'));
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.db.prepare('SELECT status FROM premium_slot_watches').get()?.status).toBe('sent');
  });

  it('does not announce private support deadlines or reservation expiry',async()=>{
    const h=harness();h.active();
    state.retries=[{id:9,activationId:1,licenseId:1,appId:'123',status:'available',expiresAt:'2026-11-02T15:15:00.000Z',activatedAt:'2026-11-01T15:04:00.000Z'}];
    await savePremiumSlotWatch(h.c,2,'123',{email:'two@example.com'},at);
    await h.tick();
    expect(h.request).not.toHaveBeenCalled();
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM premium_notification_outbox').get()?.n).toBe(0);
    state.retries=[];
    h.db.prepare('DELETE FROM premium_activations').run();
    h.db.prepare(`INSERT INTO premium_activations(id,license_id,app_id,status,reserved_at) VALUES(2,1,'123','reserved','2026-11-02T14:59:00.000Z')`).run();
    await h.tick();
    expect(h.request).not.toHaveBeenCalled();
    await h.tick(new Date('2026-11-02T15:04:00.000Z'));
    expect(h.request).not.toHaveBeenCalled();
  });

  it('keeps the same frozen message and provider key when an uncertain prediction is restored',async()=>{
    const h=harness();h.active(1,'2026-11-02T16:00:00.000Z');
    await savePremiumSlotWatch(h.c,1,'123',{email:'one@example.com'},at);
    await h.tick();
    h.request.mockRejectedValueOnce(new Error('response lost after sending'));
    expect(await h.tick(new Date('2026-11-02T15:56:00.000Z'))).toMatchObject({failed:1,sent:0});
    const original=h.db.prepare('SELECT id,dedupe_key,payload_json,first_attempt_at FROM premium_notification_outbox').get();
    h.game.activationLimit=2;
    await h.tick(new Date('2026-11-02T15:56:30.000Z'));
    expect(h.db.prepare('SELECT status FROM premium_notification_outbox').get()?.status).toBe('canceled');
    h.game.activationLimit=1;
    expect(await h.tick(new Date('2026-11-02T15:58:00.000Z'))).toMatchObject({sent:1});
    expect(h.db.prepare('SELECT id,dedupe_key,payload_json,first_attempt_at,attempts,status FROM premium_notification_outbox').get())
      .toEqual({...original,attempts:2,status:'sent'});
    expect(h.request.mock.calls[1]![1]!.body).toBe(h.request.mock.calls[0]![1]!.body);
    expect(h.request.mock.calls[1]![1]!.headers).toEqual(h.request.mock.calls[0]![1]!.headers);
    h.game.activationLimit=2;
    await h.tick(new Date('2026-11-02T15:58:20.000Z'));
    h.game.activationLimit=1;
    await h.tick(new Date('2026-11-02T15:58:40.000Z'));
    expect(h.request).toHaveBeenCalledTimes(2);
  });

  it('accounts private additional holds when the original catalog slot already elapsed',async()=>{
    const h=harness();h.active(1,'2026-11-02T15:04:00.000Z');
    state.retries=[{id:9,activationId:99,licenseId:1,appId:'123',status:'review',expiresAt:'2026-11-02T14:59:00.000Z',activatedAt:'2026-11-01T14:00:00.000Z'}];
    await savePremiumSlotWatch(h.c,2,'123',{email:'two@example.com'},at);
    await h.tick();
    expect(h.request).not.toHaveBeenCalled(); // one public release cannot free capacity while a second private hold exists
  });

  it('cancels watches and pending notifications together and never delivers canceled subscriptions',async()=>{
    const h=harness();h.active(1,'2026-11-02T16:00:00.000Z');
    await savePremiumSlotWatch(h.c,1,'123',{email:'one@example.com'},at);
    await h.tick();
    expect(await cancelPremiumSlotWatch(h.c,1,'123',new Date(at.getTime()+1000))).toBe(true);
    await h.tick(new Date('2026-11-02T15:56:00.000Z'));
    expect(h.request).not.toHaveBeenCalled();
    expect(h.db.prepare('SELECT status FROM premium_notification_outbox').get()?.status).toBe('canceled');
  });

  it('notifies all launch interests, names only currently available tiers, and retains wishes',async()=>{
    const h=harness();h.wish(1);h.wish(2);h.launch();
    expect(await h.tick()).toMatchObject({sent:2});
    const body=JSON.parse(String(h.request.mock.calls[0]![1]!.body));
    expect(body.text).toContain('Disponível agora para: Ouro.');
    expect(body.text).toContain('depende das vagas disponíveis');
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM premium_wishlist WHERE removed_at IS NULL').get()?.n).toBe(2);
    await h.tick();expect(h.request).toHaveBeenCalledTimes(2);
  });

  it('cancels a queued launch when the wish was removed or its contact version changed',async()=>{
    const h=harness();h.wish(1);h.wish(2);h.launch();
    h.db.prepare(`UPDATE premium_wishlist SET removed_at=? WHERE license_id=1`).run(at.toISOString());
    h.db.prepare(`UPDATE premium_wishlist SET email='new@example.com',updated_at='2026-11-02T15:01:00.000Z' WHERE license_id=2`).run();
    expect(await h.tick()).toMatchObject({sent:0,canceled:2});
    expect(h.request).not.toHaveBeenCalled();
  });

  it('uses all-plan launch wording when plans are disabled',async()=>{
    const h=harness();state.plansEnabled=false;h.wish();h.launch();await h.tick();
    expect(JSON.parse(String(h.request.mock.calls[0]![1]!.body)).text).toContain('todos os planos');
  });

  it('retries delivery using the identical body and idempotency key despite metadata changes',async()=>{
    const h=harness();h.wish();h.launch();
    h.request.mockRejectedValueOnce(new Error('network timeout'));
    expect(await h.tick()).toMatchObject({failed:1,sent:0});
    h.game.name='Renamed game';h.game.updatedAt='2026-11-02T15:01:00.000Z';
    h.env.PUBLIC_APP_ORIGIN='https://changed.example.com';
    expect(await h.tick(new Date('2026-11-02T15:03:00.000Z'))).toMatchObject({sent:1});
    expect(h.request.mock.calls[0]![1]!.body).toBe(h.request.mock.calls[1]![1]!.body);
    expect(h.request.mock.calls[0]![1]!.headers).toEqual(h.request.mock.calls[1]![1]!.headers);
  });

  it('does not duplicate queued slot emails when ordinary game metadata changes',async()=>{
    const h=harness();h.active(1,'2026-11-02T16:00:00.000Z');
    await savePremiumSlotWatch(h.c,1,'123',{email:'one@example.com'},at);
    await h.tick();h.game.name='Updated title';h.game.updatedAt='2026-11-02T15:30:00.000Z';
    await h.tick(new Date('2026-11-02T15:56:00.000Z'));
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM premium_notification_outbox').get()?.n).toBe(1);
  });

  it('rechecks cancellation after preparing a message and before delivery',async()=>{
    const h=harness();h.wish();h.launch();
    const { getPlanSettings }=await import('./plan-tiers');
    vi.mocked(getPlanSettings).mockImplementationOnce(async()=>{
      h.db.prepare(`UPDATE premium_wishlist SET removed_at=?`).run(at.toISOString());
      return {plansEnabled:true};
    });
    expect(await h.tick()).toMatchObject({canceled:1,sent:0});
    expect(h.request).not.toHaveBeenCalled();
  });

  it('bounds sends per tick and leaves the remaining interests queued for a later tick',async()=>{
    const h=harness();
    for(let id=3;id<=24;id++) h.db.prepare('INSERT INTO licenses VALUES(?,?)').run(id,`Player ${id}`);
    for(let id=1;id<=24;id++) h.wish(id);
    h.launch();
    expect(await h.tick()).toMatchObject({sent:20});
    expect(await h.tick(new Date(at.getTime()+60_000))).toMatchObject({sent:4});
    expect(h.request).toHaveBeenCalledTimes(24);
  });

  it('requires provider acknowledgement and stops automatic delivery after six failures',async()=>{
    const h=harness();h.wish();h.launch();
    h.request.mockImplementation(async()=>Response.json({}));
    for(let i=0;i<7;i++) await h.tick(new Date(at.getTime()+i*2*60*60_000));
    expect(h.request).toHaveBeenCalledTimes(6);
    expect(h.db.prepare('SELECT attempts,status FROM premium_notification_outbox').get()).toMatchObject({attempts:6,status:'failed'});
  });

  it('cancels older launch events after a game is announced again',async()=>{
    const h=harness();h.wish();h.launch();
    const relaunch='2026-11-02T15:02:00.000Z';
    h.game.availableAt=relaunch;
    h.db.prepare(`UPDATE premium_games SET coming_soon=1 WHERE app_id='123'`).run();
    h.db.prepare(`UPDATE premium_games SET coming_soon=0,available_at=?,updated_at=? WHERE app_id='123'`).run(relaunch,relaunch);
    expect(await h.tick(new Date(relaunch))).toMatchObject({sent:1,canceled:1});
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it('does not consume watches or send email if Resend is not configured',async()=>{
    const h=harness();h.active();
    await savePremiumSlotWatch(h.c,1,'123',{email:'one@example.com'},at);
    h.env.RESEND_API_KEY='';
    expect(await h.tick()).toMatchObject({sent:0,skipped:1});
    expect(h.request).not.toHaveBeenCalled();
    expect(h.db.prepare('SELECT status FROM premium_slot_watches').get()?.status).toBe('watching');
  });

  it('recovers an expired send lease and prevents two cron runs from sending the same event',async()=>{
    const h=harness();h.wish();h.launch();
    h.db.prepare(`UPDATE premium_notification_outbox SET status='sending',lease_until='2026-11-02T14:59:00.000Z'`).run();
    await Promise.all([h.tick(),h.tick()]);
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.db.prepare('SELECT status FROM premium_notification_outbox').get()?.status).toBe('sent');
  });

  it('stops retrying unconfirmed sends before provider idempotency retention expires',async()=>{
    const h=harness();h.wish();h.launch();
    h.db.prepare(`UPDATE premium_notification_outbox SET first_attempt_at='2026-11-01T15:00:00.000Z',attempts=1,status='failed'`).run();
    expect(await h.tick()).toMatchObject({failed:1,sent:0});
    expect(h.request).not.toHaveBeenCalled();
    expect(h.db.prepare('SELECT attempts,last_error FROM premium_notification_outbox').get()).toMatchObject({attempts:6,last_error:expect.stringContaining('conferir no provedor')});
  });

  it('keeps the admin list bounded and filterable without leaking body or delivery credentials',async()=>{
    const h=harness();h.wish();h.launch();await h.tick();
    const result=await listAdminPremiumNotifications(h.c,{kind:'game_available',status:'sent',appId:'123'});
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0]).toMatchObject({gameName:'Upcoming <game>',licenseName:'Player A',status:'sent'});
    expect(result.notifications[0]).not.toHaveProperty('payload_json');
    await expect(listAdminPremiumNotifications(h.c,{kind:'bad'})).rejects.toMatchObject({status:400});
  });
});
