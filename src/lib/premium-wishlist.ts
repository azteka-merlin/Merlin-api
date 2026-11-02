import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppContext } from "../types";

const interestSchema = z.object({
  email: z.string().trim().email().max(254),
  phone: z.string().trim().max(40).optional().nullable(),
  phoneConsent: z.boolean().optional(),
}).superRefine((value, ctx) => {
  if (value.phone && !value.phoneConsent) {
    ctx.addIssue({ code: "custom", path: ["phoneConsent"], message: "Confirme o uso do telefone para contato sobre o jogo." });
  }
});

/** A license may keep one interest per game and may edit or restore it. */
export async function savePremiumWish(c: AppContext, licenseId: number, appId: string, input: unknown, now = new Date()) {
  if (!Number.isInteger(licenseId) || licenseId < 1 || !/^\d{1,12}$/.test(appId)) {
    throw new HTTPException(400, { message: "Licença ou jogo inválido." });
  }
  const parsed = interestSchema.safeParse(input);
  if (!parsed.success) throw new HTTPException(400, { message: parsed.error.issues[0]?.message || "Dados inválidos." });
  const at = now.toISOString();
  const phone = parsed.data.phone || null;
  const result = await c.env.merlin_db.prepare(`
    INSERT INTO premium_wishlist (license_id,app_id,email,phone,phone_consent_at,created_at,updated_at,removed_at)
    SELECT ?,app_id,?,?,?,?,?,NULL FROM premium_games WHERE app_id=? AND coming_soon=1 AND enabled=1
    ON CONFLICT(license_id,app_id) DO UPDATE SET email=excluded.email,phone=excluded.phone,
      phone_consent_at=excluded.phone_consent_at,updated_at=excluded.updated_at,removed_at=NULL
  `).bind(licenseId, parsed.data.email, phone, phone ? at : null, at, at, appId).run();
  if (Number(result.meta.changes || 0) !== 1) {
    throw new HTTPException(409, { message: "Este jogo não está disponível para inscrição na lista de desejos." });
  }
}

export async function removePremiumWish(c: AppContext, licenseId: number, appId: string, now = new Date()) {
  const at = now.toISOString();
  const result = await c.env.merlin_db.prepare(`UPDATE premium_wishlist SET removed_at=?,updated_at=?
    WHERE license_id=? AND app_id=? AND removed_at IS NULL`).bind(at, at, licenseId, appId).run();
  return Number(result.meta.changes || 0) === 1;
}

export async function listPremiumWishes(c: AppContext, licenseId: number) {
  const result = await c.env.merlin_db.prepare(`SELECT w.app_id AS appId,g.name,g.cover_url AS coverUrl,
    g.coming_soon AS comingSoon,w.email,w.phone,w.created_at AS createdAt
    FROM premium_wishlist w JOIN premium_games g ON g.app_id=w.app_id
    WHERE w.license_id=? AND w.removed_at IS NULL ORDER BY w.created_at DESC,w.id DESC`)
    .bind(licenseId).all();
  return result.results || [];
}

/** Administrative view is deliberately separate from the customer's view. */
export async function listAdminPremiumWishes(c: AppContext, appId?: string, beforeId?: number) {
  if (appId && !/^\d{1,12}$/.test(appId)) throw new HTTPException(400, { message: "Jogo inválido." });
  if (beforeId !== undefined && (!Number.isInteger(beforeId) || beforeId < 1)) throw new HTTPException(400, { message: "Página inválida." });
  const result = await c.env.merlin_db.prepare(`SELECT w.id,w.app_id AS appId,g.name AS gameName,
    g.coming_soon AS comingSoon,l.id AS licenseId,l.name AS licenseName,w.email,w.phone,
    w.phone_consent_at AS phoneConsentAt,w.created_at AS createdAt,w.updated_at AS updatedAt
    FROM premium_wishlist w JOIN premium_games g ON g.app_id=w.app_id JOIN licenses l ON l.id=w.license_id
    WHERE w.removed_at IS NULL AND (? IS NULL OR w.app_id=?) AND (? IS NULL OR w.id<?)
    ORDER BY w.id DESC LIMIT 101`).bind(appId || null, appId || null, beforeId ?? null, beforeId ?? null).all<{ id: number }>();
  const rows = result.results || [];
  const wishes = rows.slice(0, 100);
  return { wishes, nextBeforeId: rows.length > 100 ? wishes[wishes.length - 1]!.id : null };
}
