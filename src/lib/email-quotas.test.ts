import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppBindings } from '../types';
import { getEmailProviderQuotas } from './email-quotas';
import worker from '../index';

const env={BREVO_API_KEY:'brevo-test-secret',RESEND_API_KEY:'resend-test-secret'} as AppBindings;
const account={email:'private@example.com',plan:[{type:'free',creditsType:'sendLimit',credits:293}]};
const usage={emails:{daily:{used:17,limit:100,resets_at:'2026-11-04T00:00:00Z'},monthly:{used:2490,limit:3000,resets_at:'2026-12-01T00:00:00Z'}},contacts:{used:999}};
function network() {return vi.fn<typeof fetch>(async url=>Response.json(String(url).includes('brevo')?account:usage));}
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});

describe('email provider quotas',()=>{
  it('requires the existing Admin session before contacting either provider',async()=>{
    const request=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Provider must not be called'));
    const response=await worker.fetch(new Request('https://admin.api-merlin.com/panel-api/email/quotas'),{
      ...env,SESSION_HASH_SECRET:'test-session-secret',ADMIN_APP_HOST:'admin.api-merlin.com',
      merlin_db:{prepare:()=>({bind:()=>({first:async()=>null})})},
    } as unknown as AppBindings);
    expect(response.status).toBe(401);expect(request).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain('test-secret');
  });
  it('reads real provider balances without sending emails, estimating usage or exposing account data',async()=>{
    const request=network();const result=await getEmailProviderQuotas(env,request);
    expect(result.providers[0]).toMatchObject({provider:'brevo',status:'ok',quotas:[{period:'daily',remaining:293,used:null,limit:null}]});
    expect(result.providers[1]).toMatchObject({provider:'resend',status:'ok',quotas:[{period:'daily',used:17,limit:100,remaining:83},{period:'monthly',used:2490,limit:3000,remaining:510}]});
    expect(request.mock.calls.map(call=>call[0])).toEqual(['https://api.brevo.com/v3/account','https://api.resend.com/usage']);
    expect(request.mock.calls.every(call=>!call[1]?.body&&(!call[1]?.method||call[1].method==='GET'))).toBe(true);
    const json=JSON.stringify(result);expect(json).not.toContain('private@example.com');expect(json).not.toContain('test-secret');expect(json).not.toContain('contacts');
  });

  it('distinguishes a verified zero balance from a failed lookup',async()=>{
    const request=vi.fn<typeof fetch>(async url=>String(url).includes('brevo')?Response.json({plan:[{type:'free',creditsType:'sendLimit',credits:0}]}):Response.json({},{status:503}));
    const result=await getEmailProviderQuotas(env,request);
    expect(result.providers[0]).toMatchObject({status:'ok',quotas:[{remaining:0}]});
    expect(result.providers[1]).toMatchObject({status:'unavailable',quotas:[]});
  });

  it('keeps the other provider visible when a key has no permission to read usage',async()=>{
    const request=network();request.mockImplementation(async url=>String(url).includes('resend')?Response.json({message:'secret internal detail'},{status:403}):Response.json(account));
    const result=await getEmailProviderQuotas(env,request);
    expect(result.providers[0].status).toBe('ok');
    expect(result.providers[1]).toMatchObject({status:'restricted',quotas:[],message:expect.stringContaining('não permite consultar')});
    expect(JSON.stringify(result)).not.toContain('secret internal detail');
  });

  it('shows uncapped Resend plans without inventing a remaining balance',async()=>{
    const request=network();request.mockImplementation(async url=>Response.json(String(url).includes('brevo')?account:{emails:{daily:{used:800,limit:null},monthly:{used:3200,limit:50000}}}));
    const result=await getEmailProviderQuotas(env,request);
    expect(result.providers[1].quotas).toMatchObject([{period:'daily',used:800,limit:null,remaining:null},{remaining:46800}]);
  });

  it('does not call unconfigured providers',async()=>{
    const request=network();const result=await getEmailProviderQuotas({} as AppBindings,request);
    expect(request).not.toHaveBeenCalled();expect(result.providers.every(provider=>provider.status==='unconfigured')).toBe(true);
  });

  it.each([{}, {plan:[{type:'sms',creditsType:'sendLimit',credits:500}]}, {plan:[{type:'free',creditsType:'sendLimit',credits:-1}]}])('does not turn unknown Brevo balances into zero',async body=>{
    const request=network();request.mockImplementation(async url=>Response.json(String(url).includes('brevo')?body:usage));
    const result=await getEmailProviderQuotas(env,request);expect(result.providers[0]).toMatchObject({status:'unavailable',quotas:[]});
  });

  it('bounds the entire lookup including response bodies to three seconds',async()=>{
    vi.useFakeTimers();const request=vi.fn<typeof fetch>(async url=>String(url).includes('brevo')?new Promise(()=>{}):{ok:true,status:200,json:()=>new Promise(()=>{})} as unknown as Response);
    const pending=getEmailProviderQuotas(env,request);
    await vi.advanceTimersByTimeAsync(3_001);
    expect((await pending).providers.every(provider=>provider.status==='unavailable')).toBe(true);
  });
});
