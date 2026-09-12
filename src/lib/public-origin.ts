import { HTTPException } from "hono/http-exception";
import type { AppContext } from "../types";

export function getPublicAppOrigin(c: AppContext) {
  const configuredOrigin = String(c.env.PUBLIC_APP_ORIGIN || "").trim();
  if (!configuredOrigin) {
    throw new HTTPException(500, { message: "PUBLIC_APP_ORIGIN is not configured" });
  }

  let url: URL;
  try {
    url = new URL(configuredOrigin);
  } catch {
    throw new HTTPException(500, { message: "PUBLIC_APP_ORIGIN is invalid" });
  }

  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new HTTPException(500, { message: "PUBLIC_APP_ORIGIN must be an HTTPS origin" });
  }

  return url.origin;
}
