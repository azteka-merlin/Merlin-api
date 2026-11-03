import type { AppBindings } from '../types';

export type EmailProvider = 'brevo' | 'resend';
export type EmailMessage = { from: string; to: string[]; subject: string; html: string; text: string };
type DeliveryRow = {
  payload_hash: string; provider: 'pending' | EmailProvider; provider_started_at: string | null;
  message_id: string | null; updated_at: string;
};
type DeliveryOptions = {
  request?: typeof fetch;
  beforeSend?: () => Promise<void>;
  /** Frozen messages created by the old Resend-only dispatcher stay on Resend. */
  legacyResend?: boolean;
};
const BREVO_BUDGET_MS = 3_000;
const RESEND_BUDGET_MS = 5_000;
const DAY_MS = 24 * 60 * 60_000;
// Conservative rolling window, independent of the provider's daily reset timezone.
const BREVO_ROLLING_LIMIT = 280;
const BREVO_CREDIT_MARGIN = 10;

export function hasEmailTransport(env: Pick<AppBindings, 'BREVO_API_KEY' | 'RESEND_API_KEY'>) {
  return Boolean(env.BREVO_API_KEY?.trim() || env.RESEND_API_KEY?.trim());
}

async function hash(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function brevoUuid(hex: string) {
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}

function sender(address: string) {
  const match = /^\s*(.*?)\s*<([^<>]+)>\s*$/.exec(address);
  return match ? { name: match[1]!.trim(), email: match[2]!.trim() } : { email: address.trim() };
}

/** Covers headers AND response body; even a stalled body cannot postpone fallback. */
async function requestJson(request: typeof fetch, url: string, init: RequestInit, milliseconds: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('Email provider timeout')); }, Math.max(1, milliseconds));
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await request(url, { ...init, signal: controller.signal });
        const body = await response.json().catch(() => null) as Record<string, unknown> | null;
        return { ok: response.ok, status: response.status, body };
      })(),
      timeout,
    ]);
  } finally { clearTimeout(timer!); }
}

async function resend(env: AppBindings, message: EmailMessage, idempotencyKey: string, request: typeof fetch) {
  if (!env.RESEND_API_KEY?.trim()) throw new Error('Resend fallback is not configured');
  const response = await requestJson(request, 'https://api.resend.com/emails', {
    method: 'POST', headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY.trim()}`, 'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey, 'User-Agent': 'Merlin API',
    }, body: JSON.stringify(message),
  }, RESEND_BUDGET_MS);
  if (!response.ok || typeof response.body?.id !== 'string' || !response.body.id) {
    throw new Error(`Resend did not confirm email delivery (HTTP ${response.status})`);
  }
  return { id: response.body.id, provider: 'resend' as const };
}

export async function sendTransactionalEmail(env: AppBindings, message: EmailMessage, idempotencyKey: string, options: DeliveryOptions = {}) {
  const request = options.request || fetch;
  // Preserve the existing transport when Brevo has not been enabled for an environment.
  if (!env.BREVO_API_KEY?.trim()) {
    await options.beforeSend?.();
    return resend(env, message, idempotencyKey, request);
  }
  if (!message.to.length) throw new Error('Email recipient is required');
  const key = await hash(`${env.ENVIRONMENT || 'production'}:${idempotencyKey}`);
  const payloadHash = await hash(JSON.stringify(message));
  const now = new Date();
  const at = now.toISOString();
  const db = env.merlin_db;
  await db.prepare(`INSERT OR IGNORE INTO email_delivery_routes
    (delivery_key,payload_hash,provider,recipient_count,created_at,updated_at) VALUES(?,?,'pending',?,?,?)`)
    .bind(key,payloadHash,message.to.length,at,at).run();
  const read = () => db.prepare('SELECT * FROM email_delivery_routes WHERE delivery_key=?').bind(key).first<DeliveryRow>();
  let route = await read();
  if (!route) throw new Error('Email delivery record not found');
  // Recovery requests can intentionally be sent again after Resend's 24h dedupe window.
  if (route.message_id && now.getTime() - Date.parse(route.updated_at) >= DAY_MS) {
    await db.prepare(`UPDATE email_delivery_routes SET payload_hash=?,provider='pending',provider_started_at=NULL,
      message_id=NULL,created_at=?,updated_at=? WHERE delivery_key=? AND message_id IS NOT NULL AND updated_at=?`)
      .bind(payloadHash,at,at,key,route.updated_at).run();
    route = (await read())!;
  }
  if (route.payload_hash !== payloadHash) throw new Error('Email idempotency key was reused with different content');
  if (route.message_id) return { id: route.message_id, provider: route.provider as EmailProvider };
  const brevoDeadline = Date.now() + BREVO_BUDGET_MS;
  if (route.provider === 'pending') {
    let available = false;
    if (!options.legacyResend) {
      try {
        const account = await requestJson(request, 'https://api.brevo.com/v3/account', {
          headers: { 'api-key': env.BREVO_API_KEY.trim(), Accept: 'application/json' },
        }, brevoDeadline - Date.now());
        const plans = account.body?.plan as Array<{type?:string;creditsType?:string;credits?:number}> | undefined;
        const plan = Array.isArray(plans) ? plans.find(p => p.type === 'free' && p.creditsType === 'sendLimit') : undefined;
        // Unknown quota or a disabled relay must fail over, never queue an urgent code.
        const relay = account.body?.relay as {enabled?:boolean} | undefined;
        available = account.ok && relay?.enabled === true && typeof plan?.credits === 'number'
          && plan.credits >= message.to.length + BREVO_CREDIT_MARGIN;
      } catch { /* A failed quota check also uses the immediate fallback. */ }
    }
    if (available && Date.now() < brevoDeadline) {
      // The conditional write reserves credits atomically across cron and HTTP requests.
      await db.prepare(`UPDATE email_delivery_routes SET provider='brevo',provider_started_at=?,brevo_reserved_at=?,updated_at=?
        WHERE delivery_key=? AND provider='pending' AND
          (SELECT COALESCE(SUM(recipient_count),0) FROM email_delivery_routes WHERE brevo_reserved_at>?) + recipient_count <= ?`)
        .bind(at,at,at,key,new Date(now.getTime()-DAY_MS).toISOString(),BREVO_ROLLING_LIMIT).run();
    }
    await db.prepare(`UPDATE email_delivery_routes SET provider='resend',provider_started_at=?,updated_at=? WHERE delivery_key=? AND provider='pending'`)
      .bind(at,at,key).run();
    route = (await read())!;
  }
  if (route.provider === 'brevo') {
    // A crash may leave an uncertain Brevo send. Do not replay past its 30-minute window.
    if (!route.provider_started_at || now.getTime()-Date.parse(route.provider_started_at) >= 25*60_000) {
      throw new Error('Unconfirmed Brevo email is too old to retry safely; check provider logs');
    }
    let acceptedId: string | null = null;
    await options.beforeSend?.();
    try {
      if (Date.now() >= brevoDeadline) throw new Error('Brevo time budget exhausted');
      const response = await requestJson(request, 'https://api.brevo.com/v3/smtp/email', {
        method:'POST', headers:{'api-key':env.BREVO_API_KEY.trim(),'Content-Type':'application/json',Accept:'application/json'},
        body:JSON.stringify({
          sender:sender(env.BREVO_EMAIL_FROM?.trim() || 'Merlin <no-reply@api-merlin.com>'),
          to:message.to.map(email=>({email})), subject:message.subject, htmlContent:message.html, textContent:message.text,
          headers:{idempotencyKey:brevoUuid(key)}, tags:['merlin-transactional'],
        }),
      }, brevoDeadline-Date.now());
      if (response.body?.code === 'duplicate_parameter') {
        // An already accepted request is not a rejected send: fallback could duplicate it.
        const accepted = await read();
        if (accepted?.message_id) return {id:accepted.message_id,provider:accepted.provider as EmailProvider};
        throw new DuplicateBrevoEmail();
      }
      if (!response.ok || typeof response.body?.messageId !== 'string' || !response.body.messageId) {
        throw new Error(`Brevo did not confirm email delivery (HTTP ${response.status})`);
      }
      acceptedId = response.body.messageId;
      await db.prepare(`UPDATE email_delivery_routes SET message_id=?,updated_at=? WHERE delivery_key=? AND provider='brevo'`)
        .bind(response.body.messageId,at,key).run();
      console.info('[email] accepted', { provider:'brevo' });
      return {id:response.body.messageId,provider:'brevo' as const};
    } catch (error) {
      // A database error after an explicit acknowledgement is not a delivery failure.
      if (acceptedId || error instanceof DuplicateBrevoEmail) throw error;
      // Persist fallback BEFORE sending: the next cron pass must not return to Brevo.
      await db.prepare(`UPDATE email_delivery_routes SET provider='resend',provider_started_at=?,updated_at=? WHERE delivery_key=? AND provider='brevo' AND message_id IS NULL`)
        .bind(new Date().toISOString(),new Date().toISOString(),key).run();
      console.warn('[email] switching to Resend after Brevo failure');
      route = (await read())!;
      if (route.message_id) return {id:route.message_id,provider:route.provider as EmailProvider};
    }
  }
  if (route.provider !== 'resend') throw new Error('Email provider selection failed');
  if (route.provider_started_at && Date.now()-Date.parse(route.provider_started_at) >= 23*60*60_000) {
    throw new Error('Unconfirmed Resend email is too old to retry safely; check provider logs');
  }
  await options.beforeSend?.();
  const accepted = await resend(env,message,idempotencyKey,request);
  await db.prepare(`UPDATE email_delivery_routes SET message_id=?,updated_at=? WHERE delivery_key=? AND provider='resend'`)
    .bind(accepted.id,new Date().toISOString(),key).run();
  console.info('[email] accepted', {provider:'resend'});
  return accepted;
}

class DuplicateBrevoEmail extends Error {
  constructor() { super('Brevo already received this email; check provider logs before resending'); }
}
