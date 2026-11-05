import type { AppBindings } from '../types';

export type EmailQuota = {
  period: 'daily' | 'monthly' | 'credits'; remaining: number | null;
  used: number | null; limit: number | null; resetsAt: string | null;
};
export type ProviderQuota = {
  provider: 'brevo' | 'resend'; name: string; role: 'Principal' | 'Reserva';
  status: 'ok' | 'unconfigured' | 'restricted' | 'unavailable';
  quotas: EmailQuota[]; message: string | null; dashboardUrl: string;
};

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

async function query(url: string, headers: Record<string,string>, request: typeof fetch) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      (async()=>{
        const response=await request(url,{headers,signal:controller.signal});
        const body=await response.json().catch(()=>null) as Record<string,unknown> | null;
        return {status:response.status,ok:response.ok,body};
      })(),
      new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Quota timeout'));},3_000);}),
    ]);
  } finally {clearTimeout(timer!);}
}

function errorResult(base: ProviderQuota, status?: number): ProviderQuota {
  return {...base,status:status===401||status===403?'restricted':'unavailable',
    message:status===401||status===403 ? 'A chave atual não permite consultar a cota. Consulte o painel do provedor.' : 'Não foi possível consultar agora. Tente novamente.'};
}

async function brevo(env: AppBindings, request: typeof fetch): Promise<ProviderQuota> {
  const base: ProviderQuota={provider:'brevo',name:'Brevo',role:'Principal',status:'unconfigured',quotas:[],message:null,dashboardUrl:'https://app.brevo.com/'};
  if (!env.BREVO_API_KEY?.trim()) return {...base,message:'Provedor não configurado.'};
  try {
    const result=await query('https://api.brevo.com/v3/account',{'api-key':env.BREVO_API_KEY.trim(),Accept:'application/json'},request);
    if(!result.ok)return errorResult(base,result.status);
    const plans=result.body?.plan as Array<{type?:string;creditsType?:string;credits?:number}> | undefined;
    const plan=Array.isArray(plans) ? plans.find(item=>item.type==='free'&&item.creditsType==='sendLimit')
      || plans.find(item=>item.type!=='sms'&&item.creditsType==='sendLimit') : undefined;
    if (!plan || !count(plan.credits)) return errorResult(base);
    // Brevo gives remaining credits, not a dependable total/used figure. Do not infer either.
    return {...base,status:'ok',quotas:[{period:plan.type==='free'?'daily':'credits',remaining:plan.credits,used:null,limit:null,resetsAt:null}]};
  } catch { return errorResult(base); }
}

async function resend(env: AppBindings, request: typeof fetch): Promise<ProviderQuota> {
  const base: ProviderQuota={provider:'resend',name:'Resend',role:'Reserva',status:'unconfigured',quotas:[],message:null,dashboardUrl:'https://resend.com/usage'};
  const usageKey = (env as AppBindings & { RESEND_QUOTA?: string }).RESEND_QUOTA?.trim() || env.RESEND_API_KEY?.trim();
  if (!usageKey) return {...base, message:'Resend n�o configurado.'};
  try {
    const result=await query('https://api.resend.com/usage',{Authorization:`Bearer ${usageKey}`,Accept:'application/json','User-Agent':'Merlin/2.0'},request);
    if (!result.ok) {
      const failure = errorResult(base, result.status);
      return failure.status === 'restricted'
        ? {...failure, message:'Para ver a cota, configure uma chave Resend com acesso completo.'}
        : failure;
    }
    const quotas: EmailQuota[]=[];
    const emails=result.body?.emails as Record<string,{used?:unknown;limit?:unknown;resets_at?:unknown}> | undefined;
    for (const period of ['daily','monthly'] as const) {
      const row=emails?.[period];
      if (!row || !count(row.used) || (row.limit!==null && !count(row.limit))) continue;
      quotas.push({period,used:row.used,limit:row.limit,remaining:row.limit===null?null:Math.max(0,row.limit-row.used),
        resetsAt:typeof row.resets_at==='string' && Number.isFinite(Date.parse(row.resets_at))?row.resets_at:null});
    }
    if (!quotas.length) return errorResult(base);
    return {...base,status:'ok',quotas};
  } catch { return errorResult(base); }
}

/** Read-only provider calls; no sends, database writes, cached estimates or account PII. */
export async function getEmailProviderQuotas(env: AppBindings, request: typeof fetch=fetch) {
  const providers=await Promise.all([brevo(env,request),resend(env,request)]);
  return {checkedAt:new Date().toISOString(),providers};
}
