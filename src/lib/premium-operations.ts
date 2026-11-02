import { HTTPException } from 'hono/http-exception';
import type { AppContext } from '../types';

export async function startPremiumOperation(c: AppContext, licenseId: number, appId: string, operationId: string) {
  const now = new Date().toISOString();
  const result = await c.env.merlin_db.prepare(`INSERT OR IGNORE INTO premium_operations
    (license_id,operation_id,app_id,status,created_at,updated_at) VALUES (?,?,?,'pending',?,?)`)
    .bind(licenseId, operationId, appId, now, now).run();
  if (Number(result.meta.changes || 0) !== 1) throw new HTTPException(409, { message: 'Esta tentativa já foi recebida. Atualize o estado antes de tentar novamente.' });
}

export async function finishPremiumOperation(c: AppContext, licenseId: number, operationId: string, status: 'failed' | 'review') {
  await c.env.merlin_db.prepare(`UPDATE premium_operations SET status=?,updated_at=?
    WHERE license_id=? AND operation_id=? AND status='pending'`)
    .bind(status, new Date().toISOString(), licenseId, operationId).run();
}

export async function readPremiumOperation(c: AppContext, licenseId: number, operationId: string) {
  // Closing a missing id atomically also rejects a POST that arrives later.
  // This makes an unsuccessful lookup a definite failure rather than an
  // invitation to start a second request alongside a delayed first request.
  const now=new Date().toISOString();
  await c.env.merlin_db.prepare(`INSERT OR IGNORE INTO premium_operations
    (license_id,operation_id,app_id,status,created_at,updated_at) VALUES (?,?,'0','failed',?,?)`)
    .bind(licenseId,operationId,now,now).run();
  const row = await c.env.merlin_db.prepare(`SELECT status,cooldown_until AS cooldownUntil,app_id AS appId
    FROM premium_operations WHERE license_id=? AND operation_id=?`).bind(licenseId, operationId)
    .first<{ status: 'pending'|'active'|'failed'|'review'; cooldownUntil: string|null; appId: string }>();
  return row || { status: 'not_found' as const, cooldownUntil: null, appId: null };
}
