import { getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { AppContext } from "../types";

export const SESSION_COOKIE_NAME = "merlin_admin_session";
export const ADMIN_USER_LOCK_THRESHOLD = 5;
export const ADMIN_USER_LOCK_MINUTES = 60;
export const ADMIN_IP_BLOCK_THRESHOLD = 5;
export const ADMIN_IP_BLOCK_HOURS = 5;
export const ADMIN_SESSION_TTL_MINUTES = 300;
export const ADMIN_SESSION_ABSOLUTE_MAX_HOURS = 5;
export const ADMIN_SESSION_REMEMBER_TTL_HOURS = 12;
export const ADMIN_SESSION_REMEMBER_ABSOLUTE_MAX_HOURS = 12;
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_HASH = "SHA-256";
const encoder = new TextEncoder();

export type AdminUserRecord = {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  status: "active" | "disabled" | "locked";
  failed_login_count: number;
  locked_until: string | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AdminSessionRecord = {
  id: string;
  admin_user_id: number;
  token_hash: string;
  ip_hash: string;
  user_agent_hash: string;
  device_hash: string | null;
  created_at: string;
  expires_at: string;
  absolute_expires_at: string;
  last_seen_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
  username: string;
  role: string;
  status: "active" | "disabled" | "locked";
};

export type AuthSessionResult = {
  session: AdminSessionRecord;
  token: string;
  csrfToken: string;
  expiresAt: string;
  absoluteExpiresAt: string;
  cookieMaxAge: number;
};

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";

  for (const byte of buffer) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(`${normalized}${padding}`);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function importHmacKey(secret: string) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function importPbkdf2Key(password: string) {
  return crypto.subtle.importKey("raw", encoder.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]);
}

async function hmacHex(secret: string, label: string, value: string): Promise<string> {
  const key = await importHmacKey(secret);
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`${label}:${value}`));
  return toHex(digest);
}

function constantTimeEquals(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }

  return result === 0;
}

function nowIso() {
  return new Date().toISOString();
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function addHours(date: Date, hours: number) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function parseDate(value: string | null) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getSessionProfile(createdAtIso: string, absoluteExpiresAtIso: string) {
  const createdAt = parseDate(createdAtIso);
  const absoluteExpiresAt = parseDate(absoluteExpiresAtIso);
  const absoluteHours =
    createdAt && absoluteExpiresAt
      ? Math.round((absoluteExpiresAt.getTime() - createdAt.getTime()) / (1000 * 60 * 60))
      : ADMIN_SESSION_ABSOLUTE_MAX_HOURS;
  const rememberMe = absoluteHours >= ADMIN_SESSION_REMEMBER_ABSOLUTE_MAX_HOURS;
  const ttlMinutes = rememberMe ? ADMIN_SESSION_REMEMBER_TTL_HOURS * 60 : ADMIN_SESSION_TTL_MINUTES;
  return {
    rememberMe,
    ttlMinutes,
    cookieMaxAge: ttlMinutes * 60,
  };
}

export function getClientIp(c: AppContext): string | null {
  const headers = c.req.raw.headers;
  return (
    headers.get("cf-connecting-ip")?.trim() ||
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip")?.trim() ||
    null
  );
}

export function getUserAgent(c: AppContext): string {
  return c.req.header("user-agent")?.trim() || "unknown";
}

export async function hashAdminPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await importPbkdf2Key(password);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: PBKDF2_HASH, iterations: PBKDF2_ITERATIONS, salt },
    key,
    256,
  );

  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${base64Url(salt)}$${base64Url(bits)}`;
}

export async function verifyAdminPassword(password: string, storedHash: string): Promise<boolean> {
  const [scheme, iterationsRaw, saltRaw, hashRaw] = storedHash.split("$");
  if (scheme !== "pbkdf2_sha256" || !iterationsRaw || !saltRaw || !hashRaw) {
    return false;
  }

  const iterations = Number(iterationsRaw);
  if (!Number.isFinite(iterations) || iterations <= 0) {
    return false;
  }

  const salt = decodeBase64Url(saltRaw);
  const expected = decodeBase64Url(hashRaw);
  const key = await importPbkdf2Key(password);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: PBKDF2_HASH, iterations, salt },
    key,
    expected.length * 8,
  );

  return constantTimeEquals(new Uint8Array(bits), expected);
}

export function requireInternalAdminSecret(c: AppContext) {
  const secret = c.req.header("x-merlin-internal-secret");
  if (!c.env.INTERNAL_ADMIN_AUTH_SECRET || secret !== c.env.INTERNAL_ADMIN_AUTH_SECRET) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }
}

export async function getAdminHashes(c: AppContext) {
  const secret = c.env.SESSION_HASH_SECRET;
  if (!secret) {
    throw new HTTPException(500, { message: "Session hash secret is not configured" });
  }

  const ip = getClientIp(c) || "unknown";
  const userAgent = getUserAgent(c);

  return {
    ipHash: await hmacHex(secret, "ip", ip),
    userAgentHash: await hmacHex(secret, "ua", userAgent),
  };
}

export async function hashSessionToken(secret: string, token: string) {
  return hmacHex(secret, "session", token);
}

export async function buildCsrfToken(secret: string, token: string) {
  return hmacHex(secret, "csrf", token);
}

export function setAdminSessionCookie(c: AppContext, token: string, maxAge = ADMIN_SESSION_TTL_MINUTES * 60) {
  setCookie(c, SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge,
    expires: new Date(Date.now() + maxAge * 1000),
  });
}

export function clearAdminSessionCookie(c: AppContext) {
  setCookie(c, SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 0,
  });
}

export async function writeAdminAuditLog(
  c: AppContext,
  input: {
    adminUserId?: number | null;
    action: string;
    entityType?: string | null;
    entityId?: string | null;
    metadata?: Record<string, unknown> | null;
    ipHash?: string | null;
    userAgentHash?: string | null;
  },
) {
  await c.env.merlin_db
    .prepare(
      `
        INSERT INTO admin_audit_logs (
          admin_user_id,
          action,
          entity_type,
          entity_id,
          ip_hash,
          user_agent_hash,
          metadata_json,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .bind(
      input.adminUserId ?? null,
      input.action,
      input.entityType ?? null,
      input.entityId ?? null,
      input.ipHash ?? null,
      input.userAgentHash ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      nowIso(),
    )
    .run();
}

async function findAdminUserByUsername(c: AppContext, username: string) {
  return c.env.merlin_db
    .prepare(
      `
        SELECT
          id,
          username,
          password_hash,
          role,
          status,
          failed_login_count,
          locked_until,
          last_login_at,
          created_at,
          updated_at
        FROM admin_users
        WHERE username = ?
      `,
    )
    .bind(username)
    .first<AdminUserRecord>();
}

async function getBlockedIpRecord(c: AppContext, ipHash: string) {
  return c.env.merlin_db
    .prepare(
      `
        SELECT id, failed_count, blocked_until, manually_unblocked_at
        FROM admin_blocked_ips
        WHERE ip_hash = ?
      `,
    )
    .bind(ipHash)
    .first<{ id: number; failed_count: number; blocked_until: string | null; manually_unblocked_at: string | null }>();
}

async function registerLoginAttempt(
  c: AppContext,
  input: {
    username: string;
    adminUserId?: number | null;
    ipHash: string;
    userAgentHash: string;
    success: boolean;
    failureReason?: string | null;
  },
) {
  await c.env.merlin_db
    .prepare(
      `
        INSERT INTO admin_login_attempts (
          username,
          admin_user_id,
          ip_hash,
          user_agent_hash,
          success,
          failure_reason,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .bind(
      input.username,
      input.adminUserId ?? null,
      input.ipHash,
      input.userAgentHash,
      input.success ? 1 : 0,
      input.failureReason ?? null,
      nowIso(),
    )
    .run();
}

async function recordFailedIpAttempt(c: AppContext, ipHash: string) {
  const timestamp = nowIso();
  const blockUntil = addHours(new Date(), ADMIN_IP_BLOCK_HOURS).toISOString();

  await c.env.merlin_db
    .prepare(
      `
        INSERT INTO admin_blocked_ips (
          ip_hash,
          reason,
          failed_count,
          blocked_at,
          blocked_until,
          manually_unblocked_at,
          manually_unblocked_by
        )
        VALUES (?, 'failed_attempt', 1, ?, NULL, NULL, NULL)
        ON CONFLICT(ip_hash) DO UPDATE SET
          failed_count = admin_blocked_ips.failed_count + 1,
          blocked_at = excluded.blocked_at,
          manually_unblocked_at = NULL,
          manually_unblocked_by = NULL,
          reason = CASE
            WHEN admin_blocked_ips.failed_count + 1 >= ${ADMIN_IP_BLOCK_THRESHOLD} THEN 'too_many_failures'
            ELSE 'failed_attempt'
          END,
          blocked_until = CASE
            WHEN admin_blocked_ips.failed_count + 1 >= ${ADMIN_IP_BLOCK_THRESHOLD} THEN ?
            ELSE admin_blocked_ips.blocked_until
          END
      `,
    )
    .bind(ipHash, timestamp, blockUntil)
    .run();

  return getBlockedIpRecord(c, ipHash);
}

async function registerFailedUserAttempt(c: AppContext, user: AdminUserRecord) {
  const nextCount = user.failed_login_count + 1;
  const lockUntil = nextCount >= ADMIN_USER_LOCK_THRESHOLD ? addMinutes(new Date(), ADMIN_USER_LOCK_MINUTES).toISOString() : null;
  const nextStatus = nextCount >= ADMIN_USER_LOCK_THRESHOLD ? "locked" : user.status;

  await c.env.merlin_db
    .prepare(
      `
        UPDATE admin_users
        SET failed_login_count = ?, locked_until = ?, status = ?, updated_at = ?
        WHERE id = ?
      `,
    )
    .bind(nextCount, lockUntil, nextStatus, nowIso(), user.id)
    .run();

  return { nextCount, lockUntil };
}

async function resetAdminUserFailures(c: AppContext, userId: number) {
  await c.env.merlin_db
    .prepare(
      `
        UPDATE admin_users
        SET failed_login_count = 0, locked_until = NULL, status = 'active', last_login_at = ?, updated_at = ?
        WHERE id = ?
      `,
    )
    .bind(nowIso(), nowIso(), userId)
    .run();
}

async function revokeSessionById(c: AppContext, sessionId: string, reason: string) {
  await c.env.merlin_db
    .prepare(
      `
        UPDATE admin_sessions
        SET revoked_at = ?, revoke_reason = ?
        WHERE id = ? AND revoked_at IS NULL
      `,
    )
    .bind(nowIso(), reason, sessionId)
    .run();
}

export async function createAdminSession(
  c: AppContext,
  user: AdminUserRecord,
  options?: { rememberMe?: boolean },
): Promise<AuthSessionResult> {
  const secret = c.env.SESSION_HASH_SECRET;
  if (!secret) {
    throw new HTTPException(500, { message: "Session hash secret is not configured" });
  }

  const { ipHash, userAgentHash } = await getAdminHashes(c);
  const token = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await hashSessionToken(secret, token);
  const csrfToken = await buildCsrfToken(secret, token);
  const createdAt = new Date();
  const rememberMe = Boolean(options?.rememberMe);
  const expiresAt = rememberMe
    ? addHours(createdAt, ADMIN_SESSION_REMEMBER_TTL_HOURS).toISOString()
    : addMinutes(createdAt, ADMIN_SESSION_TTL_MINUTES).toISOString();
  const absoluteExpiresAt = rememberMe
    ? addHours(createdAt, ADMIN_SESSION_REMEMBER_ABSOLUTE_MAX_HOURS).toISOString()
    : addHours(createdAt, ADMIN_SESSION_ABSOLUTE_MAX_HOURS).toISOString();
  const sessionId = crypto.randomUUID();
  const sessionProfile = getSessionProfile(createdAt.toISOString(), absoluteExpiresAt);

  await c.env.merlin_db
    .prepare(
      `
        INSERT INTO admin_sessions (
          id,
          admin_user_id,
          token_hash,
          ip_hash,
          user_agent_hash,
          device_hash,
          created_at,
          expires_at,
          absolute_expires_at,
          last_seen_at,
          revoked_at,
          revoke_reason
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      `,
    )
    .bind(
      sessionId,
      user.id,
      tokenHash,
      ipHash,
      userAgentHash,
      null,
      createdAt.toISOString(),
      expiresAt,
      absoluteExpiresAt,
      createdAt.toISOString(),
    )
    .run();

  return {
    session: {
      id: sessionId,
      admin_user_id: user.id,
      token_hash: tokenHash,
      ip_hash: ipHash,
      user_agent_hash: userAgentHash,
      device_hash: null,
      created_at: createdAt.toISOString(),
      expires_at: expiresAt,
      absolute_expires_at: absoluteExpiresAt,
      last_seen_at: createdAt.toISOString(),
      revoked_at: null,
      revoke_reason: null,
      username: user.username,
      role: user.role,
      status: user.status,
    },
    token,
    csrfToken,
    expiresAt,
    absoluteExpiresAt,
    cookieMaxAge: sessionProfile.cookieMaxAge,
  };
}

export async function loginAdminUser(
  c: AppContext,
  username: string,
  password: string,
  options?: { rememberMe?: boolean },
): Promise<AuthSessionResult> {
  const normalizedUsername = username.trim().toLowerCase();
  const { ipHash, userAgentHash } = await getAdminHashes(c);

  const blockedIp = await getBlockedIpRecord(c, ipHash);
  const blockedUntil = parseDate(blockedIp?.blocked_until ?? null);
  if (blockedIp && !blockedIp.manually_unblocked_at && blockedIp.failed_count >= ADMIN_IP_BLOCK_THRESHOLD && (!blockedUntil || blockedUntil > new Date())) {
    await registerLoginAttempt(c, {
      username: normalizedUsername,
      ipHash,
      userAgentHash,
      success: false,
      failureReason: "ip_blocked",
    });
    await writeAdminAuditLog(c, { action: "admin_login_denied", ipHash, userAgentHash, metadata: { reason: "ip_blocked", username: normalizedUsername } });
    throw new HTTPException(401, { message: "AUTH_GENERIC_FAILURE" });
  }

  const user = await findAdminUserByUsername(c, normalizedUsername);

  if (!user) {
    await registerLoginAttempt(c, {
      username: normalizedUsername,
      ipHash,
      userAgentHash,
      success: false,
      failureReason: "invalid_credentials",
    });
    const ipRecord = await recordFailedIpAttempt(c, ipHash);
    if (ipRecord && ipRecord.failed_count >= ADMIN_IP_BLOCK_THRESHOLD) {
      await writeAdminAuditLog(c, { action: "admin_ip_blocked", ipHash, userAgentHash, metadata: { username: normalizedUsername } });
    }
    await writeAdminAuditLog(c, { action: "admin_login_denied", ipHash, userAgentHash, metadata: { reason: "invalid_credentials", username: normalizedUsername } });
    throw new HTTPException(401, { message: "AUTH_GENERIC_FAILURE" });
  }

  if (user.status === "disabled") {
    await registerLoginAttempt(c, {
      username: normalizedUsername,
      adminUserId: user.id,
      ipHash,
      userAgentHash,
      success: false,
      failureReason: "user_disabled",
    });
    await writeAdminAuditLog(c, { adminUserId: user.id, action: "admin_login_denied", ipHash, userAgentHash, metadata: { reason: "user_disabled" } });
    throw new HTTPException(401, { message: "AUTH_GENERIC_FAILURE" });
  }

  const lockDate = parseDate(user.locked_until);
  if (user.status === "locked" && lockDate && lockDate > new Date()) {
    await registerLoginAttempt(c, {
      username: normalizedUsername,
      adminUserId: user.id,
      ipHash,
      userAgentHash,
      success: false,
      failureReason: "user_locked",
    });
    await writeAdminAuditLog(c, { adminUserId: user.id, action: "admin_login_denied", ipHash, userAgentHash, metadata: { reason: "user_locked" } });
    throw new HTTPException(401, { message: "AUTH_GENERIC_FAILURE" });
  }

  if (user.status === "locked" && (!lockDate || lockDate <= new Date())) {
    await c.env.merlin_db
      .prepare(`UPDATE admin_users SET status = 'active', failed_login_count = 0, locked_until = NULL, updated_at = ? WHERE id = ?`)
      .bind(nowIso(), user.id)
      .run();
    user.status = "active";
    user.failed_login_count = 0;
    user.locked_until = null;
  }

  const passwordOk = await verifyAdminPassword(password, user.password_hash);
  if (!passwordOk) {
    await registerLoginAttempt(c, {
      username: normalizedUsername,
      adminUserId: user.id,
      ipHash,
      userAgentHash,
      success: false,
      failureReason: "invalid_credentials",
    });
    const { nextCount } = await registerFailedUserAttempt(c, user);
    const ipRecord = await recordFailedIpAttempt(c, ipHash);

    if (nextCount >= ADMIN_USER_LOCK_THRESHOLD) {
      await writeAdminAuditLog(c, { adminUserId: user.id, action: "admin_user_locked", ipHash, userAgentHash, metadata: { username: normalizedUsername } });
    }
    if (ipRecord && ipRecord.failed_count >= ADMIN_IP_BLOCK_THRESHOLD) {
      await writeAdminAuditLog(c, { adminUserId: user.id, action: "admin_ip_blocked", ipHash, userAgentHash, metadata: { username: normalizedUsername } });
    }
    await writeAdminAuditLog(c, { adminUserId: user.id, action: "admin_login_denied", ipHash, userAgentHash, metadata: { reason: "invalid_credentials" } });
    throw new HTTPException(401, { message: "AUTH_GENERIC_FAILURE" });
  }

  await resetAdminUserFailures(c, user.id);
  await registerLoginAttempt(c, {
    username: normalizedUsername,
    adminUserId: user.id,
    ipHash,
    userAgentHash,
    success: true,
    failureReason: null,
  });
  const session = await createAdminSession(c, user, { rememberMe: options?.rememberMe });
  await writeAdminAuditLog(c, { adminUserId: user.id, action: "admin_login_success", ipHash, userAgentHash });
  return session;
}

export async function readAdminSession(c: AppContext, options?: { rotate?: boolean; touch?: boolean }) {
  const secret = c.env.SESSION_HASH_SECRET;
  if (!secret) {
    throw new HTTPException(500, { message: "Session hash secret is not configured" });
  }

  const token = getCookie(c, SESSION_COOKIE_NAME);
  if (!token) {
    return null;
  }

  return readAdminSessionByToken(c, token, options);
}

export async function readAdminSessionByToken(c: AppContext, token: string, options?: { rotate?: boolean; touch?: boolean }) {
  const secret = c.env.SESSION_HASH_SECRET;
  if (!secret) {
    throw new HTTPException(500, { message: "Session hash secret is not configured" });
  }

  const tokenHash = await hashSessionToken(secret, token);
  const session = await c.env.merlin_db
    .prepare(
      `
        SELECT
          s.id,
          s.admin_user_id,
          s.token_hash,
          s.ip_hash,
          s.user_agent_hash,
          s.device_hash,
          s.created_at,
          s.expires_at,
          s.absolute_expires_at,
          s.last_seen_at,
          s.revoked_at,
          s.revoke_reason,
          u.username,
          u.role,
          u.status
        FROM admin_sessions s
        INNER JOIN admin_users u ON u.id = s.admin_user_id
        WHERE s.token_hash = ?
        LIMIT 1
      `,
    )
    .bind(tokenHash)
    .first<AdminSessionRecord>();

  if (!session || session.revoked_at) {
    return null;
  }

  const { ipHash, userAgentHash } = await getAdminHashes(c);
  const now = new Date();
  const expiresAt = parseDate(session.expires_at);
  const absoluteExpiresAt = parseDate(session.absolute_expires_at);

  if (
    session.ip_hash !== ipHash ||
    session.user_agent_hash !== userAgentHash ||
    session.status === "disabled" ||
    !expiresAt ||
    !absoluteExpiresAt ||
    expiresAt <= now ||
    absoluteExpiresAt <= now
  ) {
    await revokeSessionById(c, session.id, session.status === "disabled" ? "user_disabled" : "session_invalidated");
    await writeAdminAuditLog(c, {
      adminUserId: session.admin_user_id,
      action: expiresAt && expiresAt <= now ? "admin_session_expired" : "admin_session_revoked",
      ipHash,
      userAgentHash,
      metadata: { sessionId: session.id },
    });
    return null;
  }

  const shouldTouch = options?.touch !== false;
  const shouldRotate = Boolean(options?.rotate);
  let effectiveToken = token;

  if (shouldTouch || shouldRotate) {
    const sessionProfile = getSessionProfile(session.created_at, session.absolute_expires_at);
    const nextExpires = addMinutes(now, sessionProfile.ttlMinutes);
    const boundedExpires = nextExpires > absoluteExpiresAt ? absoluteExpiresAt : nextExpires;
    let nextTokenHash = session.token_hash;

    if (shouldRotate) {
      effectiveToken = base64Url(crypto.getRandomValues(new Uint8Array(32)));
      nextTokenHash = await hashSessionToken(secret, effectiveToken);
    }

    await c.env.merlin_db
      .prepare(
        `
          UPDATE admin_sessions
          SET token_hash = ?, expires_at = ?, last_seen_at = ?
          WHERE id = ?
        `,
      )
      .bind(nextTokenHash, boundedExpires.toISOString(), now.toISOString(), session.id)
      .run();

    session.token_hash = nextTokenHash;
    session.expires_at = boundedExpires.toISOString();
    session.last_seen_at = now.toISOString();
  }

  return {
    session,
    token: effectiveToken,
    csrfToken: await buildCsrfToken(secret, effectiveToken),
    expiresAt: session.expires_at,
    absoluteExpiresAt: session.absolute_expires_at,
    cookieMaxAge: getSessionProfile(session.created_at, session.absolute_expires_at).cookieMaxAge,
  } satisfies AuthSessionResult;
}

export async function requireAdminSession(c: AppContext, options?: { mutate?: boolean; rotate?: boolean }) {
  const sessionResult = await readAdminSession(c, { touch: true, rotate: options?.rotate });
  if (!sessionResult) {
    clearAdminSessionCookie(c);
    throw new HTTPException(401, { message: "Sessao expirada. Faca login novamente." });
  }

  if (options?.mutate) {
    const expectedCsrf = sessionResult.csrfToken;
    const receivedCsrf = c.req.header("x-csrf-token");
    if (!receivedCsrf || receivedCsrf !== expectedCsrf) {
      throw new HTTPException(403, { message: "Invalid CSRF token" });
    }

    const origin = c.req.header("origin");
    const referer = c.req.header("referer");
    const currentOrigin = new URL(c.req.url).origin;
    if (origin && origin !== currentOrigin) {
      throw new HTTPException(403, { message: "Invalid origin" });
    }
    if (referer && !referer.startsWith(`${currentOrigin}/`)) {
      throw new HTTPException(403, { message: "Invalid referer" });
    }
  }

  setAdminSessionCookie(c, sessionResult.token, sessionResult.cookieMaxAge);
  return sessionResult;
}

export async function logoutAdminSession(c: AppContext) {
  const current = await readAdminSession(c, { touch: false, rotate: false });
  if (current) {
    await revokeSessionById(c, current.session.id, "logout");
    await writeAdminAuditLog(c, {
      adminUserId: current.session.admin_user_id,
      action: "admin_logout",
      ipHash: current.session.ip_hash,
      userAgentHash: current.session.user_agent_hash,
      metadata: { sessionId: current.session.id },
    });
  }

  clearAdminSessionCookie(c);
}

export async function logoutAdminSessionByToken(c: AppContext, token: string) {
  const current = await readAdminSessionByToken(c, token, { touch: false, rotate: false });
  if (!current) {
    return;
  }

  await revokeSessionById(c, current.session.id, "logout");
  await writeAdminAuditLog(c, {
    adminUserId: current.session.admin_user_id,
    action: "admin_logout",
    ipHash: current.session.ip_hash,
    userAgentHash: current.session.user_agent_hash,
    metadata: { sessionId: current.session.id },
  });
}




