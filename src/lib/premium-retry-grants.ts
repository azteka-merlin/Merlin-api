import { HTTPException } from 'hono/http-exception';
import type { AppContext } from '../types';

const RETRY_WINDOW_MS = 15 * 60 * 1000;

/** Register a support-authorized retry without changing the original slot or cooldown. */
export async function createPremiumRetryGrant(c: AppContext, activationId: number, adminId: number, now = new Date(), confirmedFailure = false) {
  if (!Number.isInteger(activationId) || activationId < 1 || !Number.isInteger(adminId) || adminId < 1) {
    throw new HTTPException(400, { message: 'Ativação ou administrador inválido.' });
  }
  const at = now.toISOString();
  const expiresAt = new Date(now.getTime() + RETRY_WINDOW_MS).toISOString();
  if (confirmedFailure) {
    // Support has checked the result with the customer. Retain the previous
    // authorization as history and issue a new, independently expiring grant.
    await c.env.merlin_db.batch([
      c.env.merlin_db.prepare(`UPDATE premium_operations SET status='failed',updated_at=? WHERE status='review'
        AND reservation_id IN (SELECT retry_activation_id FROM premium_retry_grants WHERE activation_id=? AND status='review')`).bind(at,activationId),
      c.env.merlin_db.prepare(`UPDATE premium_retry_grants SET status='canceled',updated_at=?
        WHERE activation_id=? AND status='review'`).bind(at, activationId),
    ]);
  }
  // Expired but unclaimed grants cannot remain open indefinitely and block a new authorization.
  await c.env.merlin_db.prepare(`UPDATE premium_retry_grants SET status='expired',updated_at=?
    WHERE activation_id=? AND status='available' AND expires_at<=?`).bind(at, activationId, at).run();
  try {
    const result = await c.env.merlin_db.prepare(`INSERT INTO premium_retry_grants
      (activation_id,license_id,app_id,granted_by,granted_at,expires_at,status,updated_at)
      SELECT a.id,a.license_id,a.app_id,?,?,?,'available',? FROM premium_activations a JOIN premium_games p ON p.app_id=a.app_id
      WHERE a.id=? AND a.status='active' AND a.cooldown_until>? AND p.enabled=1 AND p.coming_soon=0
      AND (a.activated_at>? OR (
        (SELECT COUNT(*) FROM premium_activations x WHERE x.app_id=a.app_id AND
          ((x.status='active' AND x.activated_at>?) OR (x.retry_of IS NULL AND x.status IN ('reserved','processing') AND x.reserved_at>?)))
        + (SELECT COUNT(*) FROM premium_retry_grants g JOIN premium_activations x ON x.id=g.activation_id
          WHERE g.app_id=a.app_id AND (g.status IN ('processing','review') OR (g.status='available' AND g.expires_at>?))
            AND (x.activated_at IS NULL OR x.activated_at<=?)) < p.activation_limit
      ))`).bind(adminId, at, expiresAt, at, activationId, at,
        new Date(now.getTime()-86400000).toISOString(),new Date(now.getTime()-86400000).toISOString(),
        new Date(now.getTime()-180000).toISOString(),at,new Date(now.getTime()-86400000).toISOString()).run();
    if (Number(result.meta.changes || 0) !== 1) throw new HTTPException(409, { message: 'A ativação não está em cooldown ou não há vaga para reservar a nova tentativa.' });
    return { id: Number(result.meta.last_row_id), activationId, status:'available' as const, grantedAt: at, expiresAt };
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    if (String(error).toLowerCase().includes('unique')) throw new HTTPException(409, { message: 'Já existe uma nova tentativa pendente para esta ativação.' });
    throw error;
  }
}

export async function getPremiumRetry(c: AppContext, licenseId: number, appId: string) {
  return c.env.merlin_db.prepare(`SELECT id,activation_id AS activationId,status,expires_at AS expiresAt
    FROM premium_retry_grants WHERE license_id=? AND app_id=?
      AND (status IN ('processing','review') OR (status='available' AND expires_at>?))
    ORDER BY id DESC LIMIT 1`).bind(licenseId, appId, new Date().toISOString())
    .first<{id:number;activationId:number;status:'available'|'processing'|'review';expiresAt:string}>();
}

/** Atomic compare-and-set prevents two clicks from starting the same grant. */
export async function claimPremiumRetryGrant(c: AppContext, grantId: number, licenseId: number, appId: string, now = new Date()): Promise<boolean> {
  const at = now.toISOString();
  const result = await c.env.merlin_db.prepare(`UPDATE premium_retry_grants SET status='processing',updated_at=?
    WHERE id=? AND license_id=? AND app_id=? AND status='available' AND expires_at>?
      AND EXISTS (SELECT 1 FROM premium_activations a WHERE a.id=premium_retry_grants.activation_id
        AND a.license_id=premium_retry_grants.license_id AND a.app_id=premium_retry_grants.app_id
        AND a.status='active' AND a.cooldown_until>?)`)
    .bind(at, grantId, licenseId, appId, at, at).run();
  return Number(result.meta.changes || 0) === 1;
}

/** Only a definite pre-generation failure is reusable; unknown results require review. */
export async function finishPremiumRetryFailure(c: AppContext, grantId: number, uncertain: boolean, now = new Date()) {
  const at = now.toISOString();
  const result = await c.env.merlin_db.prepare(`UPDATE premium_retry_grants
    SET status=CASE WHEN ?=1 THEN 'review' WHEN expires_at>? THEN 'available' ELSE 'expired' END,
      retry_activation_id=CASE WHEN ?=1 THEN retry_activation_id ELSE NULL END,updated_at=?
    WHERE id=? AND status='processing'`).bind(uncertain ? 1 : 0, at, uncertain ? 1 : 0, at, grantId).run();
  return Number(result.meta.changes || 0) === 1;
}
