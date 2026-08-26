import { getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { AppContext } from "../types";

export const PUBLIC_ACCESS_SESSION_COOKIE = "merlin_public_access_session";
const STANDARD_TTL_SECONDS = 30 * 60;
const REMEMBERED_TTL_SECONDS = 7 * 24 * 60 * 60;
const encoder = new TextEncoder();

type PublicAccessSessionRow = {
  id: string;
  license_id: number;
  token_hash: string;
  user_agent_hash: string;
  remember_device: number;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  revoked_at: string | null;
};

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function sessionSecret(c: AppContext) {
  const secret = String(c.env.SESSION_HASH_SECRET || "").trim();
  if (!secret) throw new HTTPException(500, { message: "Session hash secret is not configured" });
  return secret;
}

async function hmacHex(secret: string, label: string, value: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`${label}:${value}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function userAgent(c: AppContext) {
  return c.req.header("user-agent")?.trim() || "unknown";
}

function addSeconds(seconds: number) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function setSessionCookie(c: AppContext, token: string, ttlSeconds: number) {
  setCookie(c, PUBLIC_ACCESS_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: ttlSeconds,
    expires: new Date(Date.now() + ttlSeconds * 1000),
  });
}

export function clearPublicAccessSessionCookie(c: AppContext) {
  setCookie(c, PUBLIC_ACCESS_SESSION_COOKIE, "", {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 0,
  });
}

export async function createPublicAccessSession(c: AppContext, licenseId: number, rememberDevice: boolean) {
  const secret = sessionSecret(c);
  const token = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const now = new Date().toISOString();
  const ttlSeconds = rememberDevice ? REMEMBERED_TTL_SECONDS : STANDARD_TTL_SECONDS;
  const userAgentHash = await hmacHex(secret, "public-access-ua", userAgent(c));
  await c.env.merlin_db.prepare(`
    INSERT INTO public_access_sessions (
      id, license_id, token_hash, user_agent_hash, remember_device,
      created_at, expires_at, last_seen_at, revoked_at, revoke_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
  `).bind(
    crypto.randomUUID(),
    licenseId,
    await hmacHex(secret, "public-access-session", token),
    userAgentHash,
    rememberDevice ? 1 : 0,
    now,
    addSeconds(ttlSeconds),
    now,
  ).run();
  setSessionCookie(c, token, ttlSeconds);
  return {
    csrfToken: await hmacHex(secret, "public-access-csrf", token),
    expiresAt: addSeconds(ttlSeconds),
  };
}

export async function readPublicAccessSession(c: AppContext, options: { touch?: boolean } = {}) {
  const token = getCookie(c, PUBLIC_ACCESS_SESSION_COOKIE);
  if (!token) return null;
  const secret = sessionSecret(c);
  const tokenHash = await hmacHex(secret, "public-access-session", token);
  const row = await c.env.merlin_db.prepare(`
    SELECT id, license_id, token_hash, user_agent_hash, remember_device,
      created_at, expires_at, last_seen_at, revoked_at
    FROM public_access_sessions
    WHERE token_hash = ?
    LIMIT 1
  `).bind(tokenHash).first<PublicAccessSessionRow>();
  if (!row || row.revoked_at || new Date(row.expires_at) <= new Date()) {
    clearPublicAccessSessionCookie(c);
    return null;
  }
  const userAgentHash = await hmacHex(secret, "public-access-ua", userAgent(c));
  if (row.user_agent_hash !== userAgentHash) {
    await c.env.merlin_db.prepare(`
      UPDATE public_access_sessions
      SET revoked_at = ?, revoke_reason = ?
      WHERE id = ? AND revoked_at IS NULL
    `).bind(new Date().toISOString(), "user_agent_changed", row.id).run();
    clearPublicAccessSessionCookie(c);
    return null;
  }
  const ttlSeconds = row.remember_device === 1 ? REMEMBERED_TTL_SECONDS : STANDARD_TTL_SECONDS;
  if (options.touch !== false) {
    const expiresAt = addSeconds(ttlSeconds);
    await c.env.merlin_db.prepare(`
      UPDATE public_access_sessions
      SET expires_at = ?, last_seen_at = ?
      WHERE id = ?
    `).bind(expiresAt, new Date().toISOString(), row.id).run();
    row.expires_at = expiresAt;
    setSessionCookie(c, token, ttlSeconds);
  }
  return {
    session: row,
    csrfToken: await hmacHex(secret, "public-access-csrf", token),
  };
}

export async function requirePublicAccessSession(c: AppContext, options: { mutate?: boolean } = {}) {
  const current = await readPublicAccessSession(c);
  if (!current) throw new HTTPException(401, { message: "Sessão expirada. Consulte seu acesso novamente." });
  if (options.mutate) {
    const origin = c.req.header("origin");
    const referer = c.req.header("referer");
    const currentOrigin = new URL(c.req.url).origin;
    if ((origin && origin !== currentOrigin) || (referer && !referer.startsWith(`${currentOrigin}/`))) {
      throw new HTTPException(403, { message: "Origem da solicitação inválida." });
    }
    if (c.req.header("x-merlin-access-csrf") !== current.csrfToken) {
      throw new HTTPException(403, { message: "Sessão de acesso inválida. Consulte seu acesso novamente." });
    }
  }
  return current;
}

export async function revokePublicAccessSession(c: AppContext) {
  const current = await readPublicAccessSession(c, { touch: false });
  if (current) {
    await c.env.merlin_db.prepare(`
      UPDATE public_access_sessions
      SET revoked_at = ?, revoke_reason = ?
      WHERE id = ? AND revoked_at IS NULL
    `).bind(new Date().toISOString(), "logout", current.session.id).run();
  }
  clearPublicAccessSessionCookie(c);
}
