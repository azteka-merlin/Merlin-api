import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppBindings, AppContext } from '../types';
import { getPremiumGame, getTierAvailability, listOpenPremiumRetries, PREMIUM_GAME_SLOT_COOLDOWN_MS, type PremiumGame } from './premium-games';
import { getPlanSettings, planTierLabel } from './plan-tiers';
import { nextPublicPremiumSlot } from './premium-notification-rules';
import { renderShell as renderMerlinEmailShell } from './billing-emails';
import { hasEmailTransport, sendTransactionalEmail, type EmailMessage } from './email-transport';

const FIVE_MINUTES = 5 * 60_000;
const LEASE_MS = 2 * 60_000;
const MAX_ATTEMPTS = 6;
const MAX_SENDS = 20;
const emailSchema = z.object({ email: z.string().trim().email().max(254) });
type Retry = Awaited<ReturnType<typeof listOpenPremiumRetries>>[number];
type OutboxRow = {
  id: number; license_id: number; app_id: string; kind: 'game_available' | 'slot_available';
  dedupe_key: string; email: string; status: string; scheduled_at: string; slot_at: string | null;
  source_updated_at: string; attempts: number; lease_until: string | null;
  first_attempt_at: string | null; payload_json: string | null; created_at: string;
};

/** Private retry deadlines and temporary reservations must never become public release announcements. */
async function slotState(c: AppContext, game: PremiumGame, now: Date, suppliedRetries?: Retry[]) {
  const at = now.toISOString();
  const cutoff = new Date(now.getTime() - PREMIUM_GAME_SLOT_COOLDOWN_MS).toISOString();
  const reserveCutoff = new Date(now.getTime() - 3 * 60_000).toISOString();
  const [result, retries] = await Promise.all([
    c.env.merlin_db.prepare(`SELECT id,status,activated_at,reserved_at,retry_of FROM premium_activations
      WHERE app_id=? AND ((status='active' AND activated_at>?)
        OR (status IN ('reserved','processing') AND retry_of IS NULL AND reserved_at>?))`)
      .bind(game.appId, cutoff, reserveCutoff).all<{id:number;status:string;activated_at:string|null;reserved_at:string|null;retry_of:number|null}>(),
    suppliedRetries ? Promise.resolve(suppliedRetries) : listOpenPremiumRetries(c, now),
  ]);
  const privateRetries = retries.filter(row => row.appId === game.appId);
  const heldOriginals = new Set(privateRetries.map(row => row.activationId));
  const rows = result.results || [];
  const publicReleaseTimes = rows.filter(row => row.status === 'active' && row.activated_at && !heldOriginals.has(row.id))
    .map(row => new Date(Date.parse(row.activated_at!) + PREMIUM_GAME_SLOT_COOLDOWN_MS).toISOString());
  const additionalHolds = privateRetries.filter(row => !row.activatedAt ||
    new Date(Date.parse(row.activatedAt) + PREMIUM_GAME_SLOT_COOLDOWN_MS).toISOString() <= at).length;
  const occupied = rows.length + additionalHolds;
  return { occupied, nextSlotAt: nextPublicPremiumSlot({ occupied, limit: game.activationLimit, publicReleaseTimes }, now) };
}

function validateOwner(licenseId: number, appId: string) {
  if (!Number.isInteger(licenseId) || licenseId < 1 || !/^\d{1,12}$/.test(appId)) {
    throw new HTTPException(400, { message: 'Licença ou jogo inválido.' });
  }
}

export async function savePremiumSlotWatch(c: AppContext, licenseId: number, appId: string, input: unknown, now = new Date()) {
  validateOwner(licenseId, appId);
  const parsed = emailSchema.safeParse(input);
  if (!parsed.success) throw new HTTPException(400, { message: 'Informe um e-mail válido para receber o aviso.' });
  const game = await getPremiumGame(c, appId);
  if (!game?.enabled || game.comingSoon) throw new HTTPException(409, { message: 'Este jogo não está disponível para avisos de ativação.' });
  const state = await slotState(c, game, now);
  if (state.occupied < game.activationLimit) throw new HTTPException(409, { message: 'Já há uma vaga disponível. Confira o jogo no launcher.' });
  const at = now.toISOString();
  await c.env.merlin_db.prepare(`INSERT INTO premium_slot_watches(license_id,app_id,email,status,created_at,updated_at)
    VALUES(?,?,?,'watching',?,?) ON CONFLICT(license_id,app_id) DO UPDATE SET
      updated_at=CASE WHEN status='watching' AND email=excluded.email THEN updated_at ELSE excluded.updated_at END,
      email=excluded.email,status='watching'`).bind(licenseId, appId, parsed.data.email.toLowerCase(), at, at).run();
  return { watching: true };
}

export async function cancelPremiumSlotWatch(c: AppContext, licenseId: number, appId: string, now = new Date()) {
  validateOwner(licenseId, appId);
  const at = now.toISOString();
  const result = await c.env.merlin_db.batch([
    c.env.merlin_db.prepare(`UPDATE premium_slot_watches SET status='canceled',updated_at=?
      WHERE license_id=? AND app_id=? AND status='watching'`).bind(at, licenseId, appId),
    c.env.merlin_db.prepare(`UPDATE premium_notification_outbox SET status='canceled',lease_until=NULL,updated_at=?
      WHERE license_id=? AND app_id=? AND kind='slot_available' AND status IN ('scheduled','failed','sending')`).bind(at, licenseId, appId),
  ]);
  return Number(result[0]?.meta.changes || 0) > 0;
}

export async function listAdminPremiumNotifications(c: AppContext, input: {kind?:string;status?:string;appId?:string;beforeId?:number} = {}) {
  if (input.kind && !['game_available','slot_available'].includes(input.kind)) throw new HTTPException(400, { message: 'Tipo de aviso inválido.' });
  if (input.status && !['scheduled','sending','sent','failed','canceled'].includes(input.status)) throw new HTTPException(400, { message: 'Status inválido.' });
  if (input.appId && !/^\d{1,12}$/.test(input.appId)) throw new HTTPException(400, { message: 'Jogo inválido.' });
  if (input.beforeId !== undefined && (!Number.isInteger(input.beforeId) || input.beforeId < 1)) throw new HTTPException(400, { message: 'Página inválida.' });
  const result = await c.env.merlin_db.prepare(`SELECT n.id,n.kind,n.status,n.email,n.app_id AS appId,g.name AS gameName,
    n.license_id AS licenseId,l.name AS licenseName,n.scheduled_at AS scheduledAt,n.sent_at AS sentAt,
    n.slot_at AS slotAt,n.attempts,n.last_error AS lastError,n.created_at AS createdAt
    FROM premium_notification_outbox n JOIN premium_games g ON g.app_id=n.app_id JOIN licenses l ON l.id=n.license_id
    WHERE (? IS NULL OR n.kind=?) AND (? IS NULL OR n.status=?) AND (? IS NULL OR n.app_id=?) AND (? IS NULL OR n.id<?)
    ORDER BY n.id DESC LIMIT 101`).bind(input.kind || null, input.kind || null, input.status || null, input.status || null,
      input.appId || null, input.appId || null, input.beforeId ?? null, input.beforeId ?? null).all<{id:number}>();
  const rows = result.results || [];
  const notifications = rows.slice(0, 100);
  return { notifications, nextBeforeId: rows.length > 100 ? notifications.at(-1)!.id : null };
}

async function scheduleSlotMessages(c: AppContext, game: PremiumGame, now: Date, retries: Retry[]) {
  const at = now.toISOString();
  const state = await slotState(c, game, now, retries);
  const slot = game.enabled && !game.comingSoon && state.nextSlotAt && state.nextSlotAt > at ? state.nextSlotAt : null;
  const prefix = `slot:${game.appId}:${game.availableAt || game.createdAt}:${slot}:`;
  await c.env.merlin_db.prepare(`UPDATE premium_notification_outbox SET status='canceled',updated_at=?
    WHERE app_id=? AND kind='slot_available' AND status IN ('scheduled','failed') AND (slot_at IS NOT ?
      OR substr(dedupe_key,1,length(?))<>?
      OR NOT EXISTS(SELECT 1 FROM premium_slot_watches w WHERE w.license_id=premium_notification_outbox.license_id
        AND w.app_id=premium_notification_outbox.app_id AND w.status='watching'
        AND w.updated_at=premium_notification_outbox.source_updated_at))`).bind(at, game.appId, slot, prefix, prefix).run();
  if (!slot) return 0;
  const scheduled = new Date(Math.max(now.getTime(), Date.parse(slot) - FIVE_MINUTES)).toISOString();
  // A prediction may move away and return to a previously canceled release.
  // Reuse that event only for its still-active subscription. Preserve delivery
  // attempts, the frozen body and the provider key if a send was uncertain.
  const restored = await c.env.merlin_db.prepare(`UPDATE premium_notification_outbox
    SET status='scheduled',scheduled_at=?,lease_until=NULL,updated_at=?
    WHERE app_id=? AND kind='slot_available' AND status='canceled' AND slot_at=? AND attempts<?
      AND substr(dedupe_key,1,length(?))=?
      AND EXISTS(SELECT 1 FROM premium_slot_watches w WHERE w.license_id=premium_notification_outbox.license_id
        AND w.app_id=premium_notification_outbox.app_id AND w.status='watching'
        AND w.updated_at=premium_notification_outbox.source_updated_at AND w.email=premium_notification_outbox.email)`)
    .bind(scheduled, at, game.appId, slot, MAX_ATTEMPTS, prefix, prefix).run();
  const inserted = await c.env.merlin_db.prepare(`INSERT OR IGNORE INTO premium_notification_outbox
    (license_id,app_id,kind,dedupe_key,email,status,scheduled_at,slot_at,source_updated_at,created_at,updated_at)
    SELECT w.license_id,w.app_id,'slot_available',?||w.id||':'||w.updated_at,w.email,'scheduled',?,?,w.updated_at,?,?
    FROM premium_slot_watches w WHERE w.app_id=? AND w.status='watching'
      AND NOT EXISTS(SELECT 1 FROM premium_notification_outbox n WHERE n.dedupe_key=?||w.id||':'||w.updated_at)
    ORDER BY w.id LIMIT 100`).bind(prefix, scheduled, slot, at, at, game.appId, prefix).run();
  return Number(restored.meta.changes || 0) + Number(inserted.meta.changes || 0);
}

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]!));
}

async function renderMessage(c: AppContext, row: OutboxRow, game: PremiumGame, now: Date) {
  const { plansEnabled } = await getPlanSettings(c);
  const tiers = plansEnabled ? getTierAvailability(game, now).filter(tier => tier.availableNow).map(tier => planTierLabel(tier.tier)).filter(Boolean).join(', ') : 'todos os planos';
  const launched = row.kind === 'game_available';
  const slotLabel = launched ? '' : new Intl.DateTimeFormat('pt-BR', {
    timeZone:'America/Sao_Paulo', dateStyle:'short', timeStyle:'short',
  }).format(new Date(row.slot_at!));
  const detail = launched ? (tiers || 'nenhum plano neste momento') : `${slotLabel} (horário de Brasília)`;
  const intro = launched
    ? 'O jogo que você colocou na sua lista de desejos já está disponível no Premium do Merlin.'
    : 'Você pediu para ser avisado sobre a próxima ativação deste jogo. A liberação está prevista para o horário abaixo.';
  const notice = launched
    ? 'As ativações estão sujeitas à disponibilidade e às regras do seu plano.'
    : 'Este aviso não reserva uma ativação. A disponibilidade pode mudar; confira as regras do seu plano no Merlin.';
  const instruction = `Abra o Merlin, acesse a aba Premium e procure por ${game.name}.`;
  const subject = launched ? `${game.name} chegou ao Premium` : `Próxima ativação disponível: ${game.name}`;
  const preheader = launched ? `${game.name} já está disponível. Confira os planos com acesso.` : `Próxima ativação de ${game.name}: ${detail}.`;
  const footer = launched
    ? 'Merlin Launcher • Você recebeu este e-mail porque adicionou este jogo à sua lista de desejos.'
    : 'Merlin Launcher • Você recebeu este e-mail porque solicitou um aviso sobre a próxima ativação deste jogo.';
  const bodyHtml = `
              <p style="margin:0 0 22px;font-size:14px;line-height:22px;color:#374151;">${escapeHtml(intro)}</p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border:1px solid #ddd6fe;border-radius:14px;border-collapse:separate;background:#faf5ff;">
                <tr>
                  <td style="padding:20px;font-family:Arial,Helvetica,sans-serif;">
                    <p style="margin:0 0 16px;color:#111827;font-size:20px;line-height:27px;font-weight:700;">${escapeHtml(game.name)}</p>
                    <p style="margin:0;color:#6b21a8;font-size:12px;line-height:18px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">${launched ? 'Planos com acesso agora' : 'Próxima ativação prevista'}</p>
                    <p style="margin:6px 0 0;color:#111827;font-size:${launched ? '18' : '22'}px;line-height:28px;font-weight:700;">${escapeHtml(launched ? detail : slotLabel)}</p>
                    ${launched ? '' : '<p style="margin:4px 0 0;color:#6b7280;font-size:12px;line-height:18px;">Horário de Brasília</p>'}
                  </td>
                </tr>
              </table>
              <p style="margin:22px 0 14px;font-size:14px;line-height:22px;color:#374151;">${escapeHtml(notice)}</p>
              <p style="margin:0;font-size:14px;line-height:22px;color:#374151;font-weight:700;">${escapeHtml(instruction)}</p>
              ${launched ? '<p style="margin:18px 0 0;font-size:12px;line-height:18px;color:#6b7280;">Este jogo continua na sua lista de desejos.</p>' : ''}`;
  return {
    from: String(c.env.EMAIL_FROM || '').trim() || 'Merlin <onboarding@resend.dev>', to:[row.email], subject,
    text: [subject, intro, `${game.name}\n${launched ? 'Disponível agora para' : 'Próxima ativação prevista'}: ${detail}.`, notice, instruction,
      ...(launched ? ['Você continua com este jogo na sua lista de desejos.'] : []), footer].join('\n\n'),
    html: renderMerlinEmailShell({ title:subject, preheader, heroLabel:'Merlin Premium',
      eyebrow:launched ? 'Lista de desejos' : 'Aviso de ativação',
      heading:launched ? 'Seu jogo chegou ao Premium' : 'Uma ativação está chegando', bodyHtml, footer }),
  };
}

async function sourceStillValid(c: AppContext, row: OutboxRow, game: PremiumGame, now: Date) {
  if (!game.enabled || game.comingSoon) return false;
  if (row.kind === 'game_available' && game.availableAt && game.availableAt !== row.created_at) return false;
  const source = row.kind === 'game_available'
    ? await c.env.merlin_db.prepare(`SELECT email,updated_at FROM premium_wishlist WHERE license_id=? AND app_id=? AND removed_at IS NULL`).bind(row.license_id,row.app_id).first<{email:string;updated_at:string}>()
    : await c.env.merlin_db.prepare(`SELECT email,updated_at FROM premium_slot_watches WHERE license_id=? AND app_id=? AND status='watching'`).bind(row.license_id,row.app_id).first<{email:string;updated_at:string}>();
  if (!source || source.updated_at !== row.source_updated_at || source.email !== row.email) return false;
  if (row.kind === 'slot_available') {
    const state = await slotState(c, game, now);
    return Boolean(row.slot_at && row.slot_at > now.toISOString() && state.nextSlotAt === row.slot_at
      && Date.parse(row.slot_at) - now.getTime() <= FIVE_MINUTES);
  }
  return true;
}

/** This cron is independent of expiration reminders. No delivery occurs without email credentials. */
export async function runPremiumNotificationCron(env: AppBindings, now = new Date(), delivery: {
  request?: typeof fetch; pause?: (milliseconds: number) => Promise<void>;
} = {}) {
  const c = { env } as AppContext;
  const startedAt = Date.now();
  const dispatchTime = () => new Date(now.getTime() + Math.max(0, Date.now() - startedAt));
  const request = delivery.request || fetch;
  const pause = delivery.pause || ((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  let lastRequestAt: number | null = null;
  const at = now.toISOString();
  const summary = { scheduled:0, sent:0, failed:0, canceled:0, skipped:0 };
  const retries = await listOpenPremiumRetries(c, now);
  // Soonest normal activation release goes first; games without a predictable release sort last.
  const games = await env.merlin_db.prepare(`SELECT w.app_id FROM premium_slot_watches w
    JOIN premium_games g ON g.app_id=w.app_id WHERE w.status='watching' AND g.enabled=1 AND g.coming_soon=0
    GROUP BY w.app_id ORDER BY COALESCE((SELECT MIN(a.activated_at) FROM premium_activations a
      WHERE a.app_id=w.app_id AND a.status='active' AND a.activated_at>?
        AND NOT EXISTS(SELECT 1 FROM premium_retry_grants r WHERE r.activation_id=a.id
          AND (r.status IN ('processing','review') OR (r.status='available' AND r.expires_at>?)))), '9999') ASC,w.app_id LIMIT 20`)
    .bind(new Date(now.getTime()-PREMIUM_GAME_SLOT_COOLDOWN_MS).toISOString(),at).all<{app_id:string}>();
  for (const { app_id } of games.results || []) {
    const game = await getPremiumGame(c, app_id);
    if (game) summary.scheduled += await scheduleSlotMessages(c, game, now, retries);
  }
  if (!hasEmailTransport(env)) { summary.skipped++; return summary; }
  const due = await env.merlin_db.prepare(`SELECT * FROM premium_notification_outbox
    WHERE attempts<? AND ((status IN ('scheduled','failed') AND scheduled_at<=?) OR (status='sending' AND lease_until<=?))
    ORDER BY CASE kind WHEN 'slot_available' THEN 0 ELSE 1 END,scheduled_at,id LIMIT ?`)
    .bind(MAX_ATTEMPTS, at, at, MAX_SENDS).all<OutboxRow>();
  for (const candidate of due.results || []) {
    const lease = new Date(dispatchTime().getTime()+LEASE_MS).toISOString();
    const claim = await env.merlin_db.prepare(`UPDATE premium_notification_outbox SET status='sending',lease_until=?,
      attempts=attempts+1,updated_at=? WHERE id=? AND attempts<? AND
      ((status IN ('scheduled','failed') AND scheduled_at<=?) OR (status='sending' AND lease_until<=?))`)
      .bind(lease,at,candidate.id,MAX_ATTEMPTS,at,at).run();
    if (Number(claim.meta.changes || 0)!==1) { summary.skipped++; continue; }
    let row = await env.merlin_db.prepare('SELECT * FROM premium_notification_outbox WHERE id=?').bind(candidate.id).first<OutboxRow>();
    if (!row) continue;
    const legacyResend = Boolean(row.payload_json);
    try {
      const game = await getPremiumGame(c, row.app_id);
      if (!game || !await sourceStillValid(c,row,game,dispatchTime())) {
        await env.merlin_db.prepare(`UPDATE premium_notification_outbox SET status='canceled',lease_until=NULL,updated_at=? WHERE id=? AND status='sending' AND lease_until=?`).bind(at,row.id,lease).run();
        summary.canceled++; continue;
      }
      // Provider keys last 24h. An uncertain old send must not be sent again after the dedupe window.
      if (row.first_attempt_at && now.getTime()-Date.parse(row.first_attempt_at)>=23*60*60_000) {
        await env.merlin_db.prepare(`UPDATE premium_notification_outbox SET status='failed',attempts=?,lease_until=NULL,last_error=?,updated_at=? WHERE id=? AND lease_until=?`)
          .bind(MAX_ATTEMPTS,'Envio sem confirmação há mais de 23h; conferir no provedor antes de reenviar.',at,row.id,lease).run();
        summary.failed++; continue;
      }
      if (!row.payload_json) {
        const payload = JSON.stringify(await renderMessage(c,row,game,now));
        await env.merlin_db.prepare(`UPDATE premium_notification_outbox SET payload_json=?,first_attempt_at=?,updated_at=? WHERE id=? AND status='sending' AND lease_until=? AND payload_json IS NULL`)
          .bind(payload,at,at,row.id,lease).run();
        row = await env.merlin_db.prepare('SELECT * FROM premium_notification_outbox WHERE id=?').bind(row.id).first<OutboxRow>();
      }
      if (!row?.payload_json || row.status!=='sending' || row.lease_until!==lease) { summary.skipped++; continue; }
      // Recheck immediately before crossing the network boundary, after preparing the message.
      if (lastRequestAt !== null) await pause(Math.max(0, 550 - (Date.now() - lastRequestAt)));
      const currentGame = await getPremiumGame(c,row.app_id);
      if (!currentGame || !await sourceStillValid(c,row,currentGame,dispatchTime())) {
        await env.merlin_db.prepare(`UPDATE premium_notification_outbox SET status='canceled',lease_until=NULL,updated_at=? WHERE id=? AND status='sending' AND lease_until=?`).bind(at,row.id,lease).run();
        summary.canceled++; continue;
      }
      // The frozen body also scopes the key to its original environment even if configuration changes during a retry.
      const idempotencyHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${row.dedupe_key}:${row.payload_json}`));
      const idempotencyKey = `merlin-premium:${Array.from(new Uint8Array(idempotencyHash), byte => byte.toString(16).padStart(2,'0')).join('')}`;
      lastRequestAt = Date.now();
      let canceledBeforeSend = false;
      try {
        await sendTransactionalEmail(env,JSON.parse(row.payload_json) as EmailMessage,idempotencyKey,{
          request,legacyResend,
          beforeSend:async()=>{
            const latestGame=await getPremiumGame(c,row!.app_id);
            if (!latestGame || !await sourceStillValid(c,row!,latestGame,dispatchTime())) {
              canceledBeforeSend=true;
              throw new Error('Inscrição cancelada ou previsão alterada antes do envio.');
            }
          },
        });
      } catch (error) {
        if (!canceledBeforeSend) throw error;
        await env.merlin_db.prepare(`UPDATE premium_notification_outbox SET status='canceled',lease_until=NULL,updated_at=? WHERE id=? AND status='sending' AND lease_until=?`).bind(at,row.id,lease).run();
        summary.canceled++;continue;
      }
      await env.merlin_db.batch([
        env.merlin_db.prepare(`UPDATE premium_notification_outbox SET status='sent',sent_at=?,last_error=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='sending' AND lease_until=?`).bind(at,at,row.id,lease),
        env.merlin_db.prepare(`UPDATE premium_slot_watches SET status='sent' WHERE license_id=? AND app_id=? AND updated_at=? AND status='watching'
          AND EXISTS(SELECT 1 FROM premium_notification_outbox WHERE id=? AND kind='slot_available' AND status='sent')`).bind(row.license_id,row.app_id,row.source_updated_at,row.id),
      ]);
      summary.sent++;
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0,250) : 'Falha no envio.';
      const retryAt = new Date(now.getTime()+Math.min(60,2**Math.max(1,candidate.attempts+1))*60_000).toISOString();
      await env.merlin_db.prepare(`UPDATE premium_notification_outbox SET status='failed',scheduled_at=?,lease_until=NULL,last_error=?,updated_at=? WHERE id=? AND status='sending' AND lease_until=?`)
        .bind(retryAt,reason,at,candidate.id,lease).run();
      summary.failed++;
    }
  }
  return summary;
}
