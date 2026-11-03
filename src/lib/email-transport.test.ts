import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import type { AppBindings, AppContext } from '../types';
import { sendTransactionalEmail, type EmailMessage } from './email-transport';
import { startPublicEmailVerification, verifyPublicEmailCode } from './email-verification';
import { sendWelcomeAccessKeyEmail, sendRecoveredAccessKeyEmail } from './access-key-emails';
import { sendBillingEmail } from './billing-emails';
import { Hono } from 'hono';

const databases: DatabaseSync[] = [];
const message: EmailMessage = {from:'Merlin <notice@mail.example.com>',to:['azteka@example.com'],subject:'Código Merlin: 123456',html:'<p>123456</p>',text:'Código: 123456'};
function harness() {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  db.exec(readFileSync(new URL('../../migrations/0091_email_delivery_routes.sql',import.meta.url),'utf8'));
  db.exec(readFileSync(new URL('../../migrations/0013_email_verifications.sql',import.meta.url),'utf8'));
  function prepare(sql:string) {
    let args:unknown[]=[];
    return {
      bind(...values:unknown[]) {args=values;return this;},
      async run() {const result=db.prepare(sql).run(...args as []);return {success:true,meta:{changes:Number(result.changes)}};},
      async first() {return db.prepare(sql).get(...args as []) || null;},
    };
  }
  const env={ENVIRONMENT:'production',BREVO_API_KEY:'test-brevo',RESEND_API_KEY:'test-resend',SESSION_HASH_SECRET:'unit-test-secret',
    EMAIL_FROM:message.from,merlin_db:{prepare}} as unknown as AppBindings;
  const request=vi.fn<typeof fetch>(async url => {
    if(String(url).endsWith('/account')) return Response.json({relay:{enabled:true},plan:[{type:'free',creditsType:'sendLimit',credits:300}]});
    if(String(url).includes('brevo'))return Response.json({messageId:'brevo-id'});
    return Response.json({id:'resend-id'});
  });
  const send=(key='test-message')=>sendTransactionalEmail(env,message,key,{request});
  return {db,env,request,send};
}
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();for(const db of databases.splice(0))db.close();});

describe('Brevo primary and fast Resend fallback',()=>{
  it('sends branded HTML and text through the authenticated sender, records acknowledgement and deduplicates replay',async()=>{
    const h=harness();expect(await h.send()).toEqual({id:'brevo-id',provider:'brevo'});
    const body=JSON.parse(String(h.request.mock.calls[1]![1]!.body));
    expect(body).toMatchObject({sender:{name:'Merlin',email:'no-reply@api-merlin.com'},to:[{email:message.to[0]}],subject:message.subject,htmlContent:message.html,textContent:message.text});
    expect(body.headers.idempotencyKey).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(await h.send()).toEqual({id:'brevo-id',provider:'brevo'});
    expect(h.request).toHaveBeenCalledTimes(2);
    const stored=JSON.stringify(h.db.prepare('SELECT * FROM email_delivery_routes').all());
    expect(stored).not.toContain('123456');expect(stored).not.toContain(message.to[0]);
  });

  it('falls back once on Brevo HTTP failure, preserving every content field and the Resend key',async()=>{
    const h=harness();h.request.mockImplementation(async url=>String(url).endsWith('/account')
      ? Response.json({relay:{enabled:true},plan:[{type:'free',creditsType:'sendLimit',credits:300}]})
      : String(url).includes('brevo') ? Response.json({code:'unauthorized'},{status:401}) : Response.json({id:'resend-id'}));
    expect(await h.send()).toEqual({id:'resend-id',provider:'resend'});
    expect(h.request).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(h.request.mock.calls[2]![1]!.body))).toEqual(message);
    expect(h.request.mock.calls[2]![1]!.headers).toMatchObject({'Idempotency-Key':'test-message'});
    expect(h.db.prepare('SELECT provider,message_id FROM email_delivery_routes').get()).toEqual({provider:'resend',message_id:'resend-id'});
  });

  it.each(['network','invalid-ack','invalid-json'])('falls back on %s without treating HTTP 2xx alone as delivery',async failure=>{
    const h=harness();h.request.mockImplementation(async url=>{
      if(String(url).endsWith('/account'))return Response.json({relay:{enabled:true},plan:[{type:'free',creditsType:'sendLimit',credits:300}]});
      if(String(url).includes('brevo')){if(failure==='network')throw new Error('network');return failure==='invalid-json'?new Response('broken'):Response.json({});}
      return Response.json({id:'fallback'});
    });
    expect(await h.send()).toEqual({id:'fallback',provider:'resend'});
  });

  it.each(['account','send','body'])('starts fallback within 3 seconds when the Brevo %s stalls',async stall=>{
    vi.useFakeTimers();const h=harness();
    h.request.mockImplementation(async url=>{
      const account=String(url).endsWith('/account');
      if((account&&stall==='account')||(!account&&String(url).includes('brevo')&&stall==='send'))return new Promise(()=>{});
      if(account)return Response.json({relay:{enabled:true},plan:[{type:'free',creditsType:'sendLimit',credits:300}]});
      if(String(url).includes('brevo'))return {ok:true,status:201,json:()=>new Promise(()=>{})} as unknown as Response;
      return Response.json({id:'fallback'});
    });
    const pending=h.send();
    await vi.waitFor(()=>expect(h.request).toHaveBeenCalled(),{interval:1});
    await vi.advanceTimersByTimeAsync(3_001);
    expect(await pending).toEqual({id:'fallback',provider:'resend'});
    expect(h.request.mock.calls.at(-1)![0]).toBe('https://api.resend.com/emails');
  });

  it('never returns to Brevo after a fallback failure across dispatcher restarts',async()=>{
    const h=harness();h.request.mockImplementation(async url=>{
      if(String(url).endsWith('/account'))return Response.json({relay:{enabled:true},plan:[{type:'free',creditsType:'sendLimit',credits:300}]});
      throw new Error('network unavailable');
    });
    await expect(h.send()).rejects.toThrow('network');
    h.request.mockClear();h.request.mockResolvedValue(Response.json({id:'recovered'}));
    expect(await h.send()).toEqual({id:'recovered',provider:'resend'});
    expect(h.request).toHaveBeenCalledExactlyOnceWith('https://api.resend.com/emails',expect.anything());
  });

  it.each([0,10])('uses Resend directly when Brevo credits are %s',async credits=>{
    const h=harness();h.request.mockImplementation(async url=>String(url).endsWith('/account')
      ?Response.json({relay:{enabled:true},plan:[{type:'free',creditsType:'sendLimit',credits}]}) : Response.json({id:'resend-id'}));
    expect((await h.send()).provider).toBe('resend');
    expect(h.request.mock.calls.map(call=>call[0])).toEqual(['https://api.brevo.com/v3/account','https://api.resend.com/emails']);
  });

  it('atomically sends only one of two concurrent messages through the last rolling credit',async()=>{
    const h=harness();const now=new Date().toISOString();
    h.db.prepare(`INSERT INTO email_delivery_routes(delivery_key,payload_hash,provider,brevo_reserved_at,recipient_count,created_at,updated_at)
      VALUES('prior','hash','brevo',?,279,?,?)`).run(now,now,now);
    const results=await Promise.all([h.send('one'),h.send('two')]);
    expect(results.map(result=>result.provider).sort()).toEqual(['brevo','resend']);
    expect(h.db.prepare('SELECT SUM(recipient_count) AS total FROM email_delivery_routes WHERE brevo_reserved_at IS NOT NULL').get()?.total).toBe(280);
  });

  it('preserves the Resend route for a frozen legacy outbox message',async()=>{
    const h=harness();expect((await sendTransactionalEmail(h.env,message,'old',{request:h.request,legacyResend:true})).provider).toBe('resend');
    expect(h.request).toHaveBeenCalledTimes(1);expect(h.request.mock.calls[0]![0]).toContain('resend');
  });

  it('keeps Resend operational when Brevo has not been configured, without requiring the new table',async()=>{
    const h=harness();h.env.BREVO_API_KEY='';h.db.exec('DROP TABLE email_delivery_routes');
    expect((await h.send()).provider).toBe('resend');expect(h.request).toHaveBeenCalledTimes(1);
  });

  it('does not replay uncertain Brevo sends after the short idempotency window',async()=>{
    const h=harness();await h.send();h.db.prepare("UPDATE email_delivery_routes SET message_id=NULL,provider_started_at=?").run(new Date(Date.now()-26*60_000).toISOString());
    h.request.mockClear();await expect(h.send()).rejects.toThrow('too old');expect(h.request).not.toHaveBeenCalled();
  });

  it('does not fallback after Brevo reports an already accepted duplicate',async()=>{
    const h=harness();h.request.mockImplementation(async url=>String(url).endsWith('/account')
      ?Response.json({relay:{enabled:true},plan:[{type:'free',creditsType:'sendLimit',credits:300}]})
      :Response.json({code:'duplicate_parameter'},{status:400}));
    await expect(h.send()).rejects.toThrow('already received');expect(h.request).toHaveBeenCalledTimes(2);
  });

  it('fails closed after both providers fail and never logs a success or changes content',async()=>{
    const h=harness();h.request.mockResolvedValue(Response.json({},{status:503}));
    await expect(h.send()).rejects.toThrow('Resend');
    expect(h.db.prepare('SELECT message_id FROM email_delivery_routes').get()?.message_id).toBeNull();
  });

  it('rejects reusing a delivery key with different content',async()=>{
    const h=harness();await h.send();
    await expect(sendTransactionalEmail(h.env,{...message,text:'changed'},'test-message',{request:h.request})).rejects.toThrow('different content');
    expect(h.request).toHaveBeenCalledTimes(2);
  });
});

describe('existing Merlin email flows',()=>{
  it.each(['brevo','resend'])('creates and verifies the same public signup code delivered via %s',async provider=>{
    const h=harness();if(provider==='resend')h.request.mockImplementation(async url=>String(url).includes('brevo')?Response.json({},{status:503}):Response.json({id:'fallback'}));
    vi.stubGlobal('fetch',h.request);
    await startPublicEmailVerification({env:h.env} as AppContext,'azteka@example.com');
    const send=h.request.mock.calls.find(call=>String(call[0]).endsWith(provider==='brevo'?'/smtp/email':'/emails'))!;
    const body=JSON.parse(String(send[1]!.body));const code=/Código Merlin: (\d{6})/.exec(body.subject)![1]!;
    expect(h.db.prepare('SELECT provider,status FROM email_verifications').get()).toEqual({provider,status:'pending'});
    const app=new Hono<{Bindings:AppBindings}>();
    app.post('/verify',async c=>c.json(await verifyPublicEmailCode(c,{email:'azteka@example.com',code})));
    const response=await app.request('https://api-merlin.com/verify',{method:'POST'},h.env);
    expect(response.status).toBe(200);expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(h.db.prepare('SELECT status FROM email_verifications').get()?.status).toBe('verified');
  });

  it('uses Brevo for welcome, recovery and billing while keeping their templates and links',async()=>{
    const h=harness();vi.stubGlobal('fetch',h.request);const c={env:h.env} as AppContext;
    await sendWelcomeAccessKeyEmail(c,{email:'azteka@example.com',name:'Azteka',licenseKey:'MERLIN-TEST-TEST-TEST'});
    await sendRecoveredAccessKeyEmail(c,{email:'azteka@example.com',licenseKey:'MERLIN-TEST-TEST-TEST'});
    await sendBillingEmail(c,{kind:'manual_expiration_reminder',email:'azteka@example.com',name:'Azteka',ctaUrl:'https://api-merlin.com/meu-acesso',idempotencyKey:'billing-test',daysUntilExpiry:3});
    const bodies=h.request.mock.calls.filter(call=>String(call[0]).endsWith('/smtp/email')).map(call=>JSON.parse(String(call[1]!.body)));
    expect(bodies).toHaveLength(3);
    expect(bodies[0].htmlContent).toContain('MERLIN-TEST-TEST-TEST');
    expect(bodies[1].htmlContent).toContain('https://api-merlin.com/download');
    expect(bodies[2].htmlContent).toContain('https://api-merlin.com/meu-acesso');
  });
});
