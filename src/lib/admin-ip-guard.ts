import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../types";
import { isAdminIpBlocked } from "./admin-security";

// The launcher and other API clients use /api; the web UI and panel API are
// guarded here before authentication or static assets are served.
export const adminIpGuard: MiddlewareHandler<{ Bindings: AppBindings }> = async (c, next) => {
  if (c.req.path === "/api" || c.req.path.startsWith("/api/") ||
      c.req.path === "/payment/webhooks/stripe" ||
      c.req.path === "/merlin-cloud" || c.req.path.startsWith("/merlin-cloud/") ||
      c.req.path === "/internal/custom-game-indexing" || c.req.path.startsWith("/internal/custom-game-indexing/")) {
    await next();
    return;
  }

  if (await isAdminIpBlocked(c)) {
    c.header("Cache-Control", "no-store");
    return c.text("Acesso temporariamente indisponivel.", 403);
  }
  await next();
};
