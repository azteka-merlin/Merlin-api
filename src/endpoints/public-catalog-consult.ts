import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import type { AppContext } from "../types";
import { resolveDenuvoFromSteam } from "../lib/catalog-enrichment";

const ConsultBody = z.object({ appId: z.string().regex(/^\d+$/) });
const consultAttempts = new Map<string, { count: number; resetAt: number }>();

function canConsult(request: Request): boolean {
  const key = request.headers.get("cf-connecting-ip") || "unknown";
  const now = Date.now();
  const entry = consultAttempts.get(key);
  if (!entry || entry.resetAt <= now) {
    consultAttempts.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= 3) return false;
  entry.count += 1;
  return true;
}

export class PublicCatalogConsultRoute extends OpenAPIRoute {
  schema = {
    tags: ["Public"],
    summary: "Check one reviewing catalog game on demand",
    request: { body: { content: { "application/json": { schema: ConsultBody } } } },
  };

  async handle(c: AppContext) {
    if (!canConsult(c.req.raw)) return c.json({ success: false, error: "Too many catalog consultations" }, 429);
    const { body } = await this.getValidatedData<typeof this.schema>();
    const current = await c.env.merlin_db.prepare("SELECT category FROM catalog_game_metadata WHERE app_id = ?").bind(body.appId).first<{ category: "premium" | "standard" | "reviewing" }>();
    if (!current) return c.json({ success: false, error: "Game not found in catalog" }, 404);
    if (current.category !== "reviewing") return c.json({ success: true, category: current.category, updated: false }, 200);

    const now = new Date().toISOString();
    const locked = await c.env.merlin_db.prepare(`
      UPDATE catalog_enrichment_jobs SET status = 'processing', locked_until = ?, updated_at = ?
      WHERE app_id = ? AND (locked_until IS NULL OR locked_until <= ?)
    `).bind(new Date(Date.now() + 60_000).toISOString(), now, body.appId, now).run();
    if (!locked.meta.changes) return c.json({ success: false, category: "reviewing", updated: false, queued: true, error: "Consultation already in progress" }, 202);

    try {
      const steam = await resolveDenuvoFromSteam([body.appId]);
      const resolution = steam.get(body.appId);
      if (!resolution) throw new Error("No DRM result from configured sources");

      await c.env.merlin_db.batch([
        c.env.merlin_db.prepare("UPDATE catalog_game_metadata SET category = ?, denuvo = ?, drm_notice = ?, drm_source = ?, checked_at = ?, expires_at = ? WHERE app_id = ?")
          .bind(resolution.category, resolution.denuvo, resolution.drmNotice, "steam", now, new Date(Date.now() + (resolution.denuvo ? 60 * 60_000 : 30 * 86_400_000)).toISOString(), body.appId),
        c.env.merlin_db.prepare("UPDATE catalog_enrichment_jobs SET status = 'completed', locked_until = NULL, updated_at = ? WHERE app_id = ?").bind(now, body.appId),
      ]);
      return c.json({ success: true, category: resolution.category, updated: true }, 200);
    } catch {
      await c.env.merlin_db.prepare("UPDATE catalog_enrichment_jobs SET status = 'retry', attempts = attempts + 1, next_attempt_at = ?, locked_until = NULL, updated_at = ? WHERE app_id = ?")
        .bind(new Date(Date.now() + 15 * 60_000).toISOString(), now, body.appId).run();
      return c.json({ success: false, category: "reviewing", updated: false, error: "Could not confirm DRM from Steam" }, 503);
    }
  }
}
