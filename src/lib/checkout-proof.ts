import { getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import type { AppContext } from "../types";

const COOKIE = "merlin_checkout_proof";
const TTL_SECONDS = 24 * 60 * 60;
const encoder = new TextEncoder();

async function signingKey(c: AppContext, usages: ("sign" | "verify")[]) {
  const secret = String(c.env.SESSION_HASH_SECRET || "").trim();
  if (!secret) throw new HTTPException(500, { message: "Session hash secret is not configured" });
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usages);
}

function message(sessionId: string, timestamp: string) {
  return encoder.encode(`checkout-proof:v1:${sessionId}:${timestamp}`);
}

export async function setCheckoutProof(c: AppContext, sessionId: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await crypto.subtle.sign("HMAC", await signingKey(c, ["sign"]), message(sessionId, timestamp));
  const hex = Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("");
  setCookie(c, COOKIE, `${timestamp}.${hex}`, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/api/public/checkout-status",
    maxAge: TTL_SECONDS,
  });
}

export async function hasCheckoutProof(c: AppContext, sessionId: string) {
  const match = /^(\d{10})\.([a-f0-9]{64})$/.exec(getCookie(c, COOKIE) || "");
  if (!match) return false;
  const now = Math.floor(Date.now() / 1000);
  const timestamp = Number(match[1]);
  if (timestamp > now || now - timestamp > TTL_SECONDS) return false;
  const signature = new Uint8Array(match[2]!.match(/../g)!.map(byte => parseInt(byte, 16)));
  return crypto.subtle.verify("HMAC", await signingKey(c, ["verify"]), signature, message(sessionId, match[1]!));
}
