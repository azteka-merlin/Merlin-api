import { getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import votingGames from "../data/community-voting-games.json";
import type { AppContext } from "../types";

const COOKIE_NAME = "merlin_community_voter";
const COOKIE_AGE = 365 * 24 * 60 * 60;
const DAILY_LIMIT = 3;
const IP_DAILY_LIMIT = 3;
const allowedAppIds = new Set(votingGames.map((game) => game.appid));
const encoder = new TextEncoder();

type VoteCount = { app_id: string; votes: number };
type PremiumGame = { app_id: string };
type VotedGame = { app_id: string };
type NetworkOwner = { voter_hash: string };

function voteDay() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function voterToken(c: AppContext) {
  const existing = getCookie(c, COOKIE_NAME);
  if (existing && /^[a-f0-9]{64}$/.test(existing)) return existing;
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: COOKIE_AGE,
  });
  return token;
}

async function hashIdentifier(c: AppContext, value: string) {
  const secret = c.env.SESSION_HASH_SECRET?.trim();
  if (!secret) throw new HTTPException(500, { message: "Votação indisponível no momento." });
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function voterHash(c: AppContext) {
  return hashIdentifier(c, `community-vote:${voterToken(c)}`);
}

function networkIdentity(ip: string) {
  const address = ip.toLowerCase();
  if (!address.includes(":") || address.includes(".")) return address;
  // IPv6 devices on the same LAN often have different interface addresses within one /64.
  const halves = address.split("::");
  if (halves.length > 2) return address;
  const start = halves[0] ? halves[0].split(":") : [];
  const end = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - start.length - end.length;
  const parts = halves.length === 2 ? [...start, ...Array(Math.max(0, missing)).fill("0"), ...end] : start;
  if (parts.length !== 8 || (halves.length === 2 && missing < 1)
    || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return address;
  return `ipv6:${parts.slice(0, 4).map((part) => part.padStart(4, "0")).join(":")}/64`;
}

function ipHash(c: AppContext) {
  const ip = c.req.header("cf-connecting-ip")?.trim()
    || (c.env.ENVIRONMENT === "production" ? null : c.req.header("x-forwarded-for")?.split(",")[0]?.trim());
  if (!ip) throw new HTTPException(503, { message: "Não foi possível verificar a rede para votar." });
  return hashIdentifier(c, `community-vote-ip:${networkIdentity(ip)}`);
}

function assertVoteRequest(c: AppContext) {
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(c.req.url).origin) {
    throw new HTTPException(403, { message: "Origem de votação inválida." });
  }
  if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new HTTPException(415, { message: "Envie os dados em JSON." });
  }
}

async function premiumAppIds(c: AppContext) {
  const result = await c.env.merlin_db.prepare("SELECT app_id FROM premium_games WHERE enabled = 1").all<PremiumGame>();
  return new Set(result.results.map((game) => game.app_id));
}

export async function getCommunityVoting(c: AppContext) {
  const [hash, networkHash] = await Promise.all([voterHash(c), ipHash(c)]);
  const day = voteDay();
  const [premium, counts, voted, networkVotes, networkOwner] = await Promise.all([
    premiumAppIds(c),
    c.env.merlin_db.prepare("SELECT app_id, COUNT(*) AS votes FROM community_game_votes GROUP BY app_id").all<VoteCount>(),
    c.env.merlin_db.prepare("SELECT app_id FROM community_game_votes WHERE voter_hash = ? AND vote_day = ?")
      .bind(hash, day).all<VotedGame>(),
    c.env.merlin_db.prepare("SELECT COUNT(*) AS value FROM community_game_votes WHERE ip_hash = ? AND vote_day = ? AND voter_hash = ?")
      .bind(networkHash, day, hash).first<{ value: number }>(),
    c.env.merlin_db.prepare("SELECT voter_hash FROM community_vote_ip_claims WHERE ip_hash = ? AND vote_day = ?")
      .bind(networkHash, day).first<NetworkOwner>(),
  ]);
  const voteCounts = new Map(counts.results.map((row) => [row.app_id, row.votes]));
  const votedIds = new Set(voted.results.map((row) => row.app_id));
  const ipLocked = Boolean(networkOwner && networkOwner.voter_hash !== hash);
  c.header("Cache-Control", "no-store");
  return c.json({
    games: votingGames.filter((game) => !premium.has(game.appid)).map((game) => ({
      ...game, votes: voteCounts.get(game.appid) || 0, voted: votedIds.has(game.appid),
    })),
    remainingToday: Math.max(0, DAILY_LIMIT - votedIds.size),
    ipRemainingToday: ipLocked ? 0 : Math.max(0, IP_DAILY_LIMIT - (networkVotes?.value || 0)),
    ipLocked,
    dailyLimit: DAILY_LIMIT,
    voteDay: day,
    priceCapturedAt: "2026-10-01",
  });
}

export async function postCommunityVote(c: AppContext) {
  assertVoteRequest(c);
  const body = await c.req.json().catch(() => null) as { appid?: unknown } | null;
  const appid = String(body?.appid || "");
  if (!allowedAppIds.has(appid)) throw new HTTPException(400, { message: "Jogo inválido." });
  const premium = await premiumAppIds(c);
  if (premium.has(appid)) throw new HTTPException(409, { message: "Este jogo já está no Premium." });
  const [hash, networkHash] = await Promise.all([voterHash(c), ipHash(c)]);
  const day = voteDay();
  const result = await c.env.merlin_db.prepare(`
    INSERT INTO community_game_votes (app_id, voter_hash, vote_day, ip_hash)
    SELECT ?, ?, ?, ?
    WHERE (SELECT COUNT(*) FROM community_game_votes WHERE voter_hash = ? AND vote_day = ?) < ?
      AND (SELECT COUNT(*) FROM community_game_votes WHERE ip_hash = ? AND vote_day = ? AND voter_hash = ?) < ?
      AND COALESCE((SELECT voter_hash FROM community_vote_ip_claims WHERE ip_hash = ? AND vote_day = ?), ?) = ?
    ON CONFLICT (voter_hash, vote_day, app_id) DO NOTHING
  `).bind(appid, hash, day, networkHash, hash, day, DAILY_LIMIT,
    networkHash, day, hash, IP_DAILY_LIMIT, networkHash, day, hash, hash).run();
  if (!result.meta.changes) {
    const [previous, used, networkVotes, networkOwner] = await Promise.all([
      c.env.merlin_db.prepare("SELECT 1 AS found FROM community_game_votes WHERE voter_hash = ? AND vote_day = ? AND app_id = ?")
        .bind(hash, day, appid).first<{ found: number }>(),
      c.env.merlin_db.prepare("SELECT COUNT(*) AS value FROM community_game_votes WHERE voter_hash = ? AND vote_day = ?")
        .bind(hash, day).first<{ value: number }>(),
      c.env.merlin_db.prepare("SELECT COUNT(*) AS value FROM community_game_votes WHERE ip_hash = ? AND vote_day = ? AND voter_hash = ?")
        .bind(networkHash, day, hash).first<{ value: number }>(),
      c.env.merlin_db.prepare("SELECT voter_hash FROM community_vote_ip_claims WHERE ip_hash = ? AND vote_day = ?")
        .bind(networkHash, day).first<NetworkOwner>(),
    ]);
    if (previous) throw new HTTPException(409, { message: "Você já votou neste jogo hoje." });
    if ((used?.value || 0) >= DAILY_LIMIT) {
      throw new HTTPException(409, { message: "Você já usou seus 3 votos de hoje. Remova um voto para escolher outro jogo." });
    }
    if (networkOwner && networkOwner.voter_hash !== hash) {
      throw new HTTPException(429, { message: "Outra sessão já votou por esta rede hoje." });
    }
    if ((networkVotes?.value || 0) >= IP_DAILY_LIMIT) {
      throw new HTTPException(429, { message: "Esta rede atingiu o limite de 3 votos de hoje. Remova um voto para escolher outro jogo." });
    }
    throw new HTTPException(409, { message: "Não foi possível registrar o voto. Atualize a página e tente novamente." });
  }
  const [count, used, networkVotes] = await Promise.all([
    c.env.merlin_db.prepare("SELECT COUNT(*) AS value FROM community_game_votes WHERE app_id = ?").bind(appid).first<{ value: number }>(),
    c.env.merlin_db.prepare("SELECT COUNT(*) AS value FROM community_game_votes WHERE voter_hash = ? AND vote_day = ?").bind(hash, day).first<{ value: number }>(),
    c.env.merlin_db.prepare("SELECT COUNT(*) AS value FROM community_game_votes WHERE ip_hash = ? AND vote_day = ? AND voter_hash = ?")
      .bind(networkHash, day, hash).first<{ value: number }>(),
  ]);
  c.header("Cache-Control", "no-store");
  return c.json({ appid, votes: count?.value || 0, voted: true,
    remainingToday: Math.max(0, DAILY_LIMIT - (used?.value || 0)),
    ipRemainingToday: Math.max(0, IP_DAILY_LIMIT - (networkVotes?.value || 0)),
    ipLocked: false,
  }, 201);
}

export async function removeCommunityVote(c: AppContext) {
  assertVoteRequest(c);
  const body = await c.req.json().catch(() => null) as { appid?: unknown } | null;
  const appid = String(body?.appid || "");
  if (!allowedAppIds.has(appid)) throw new HTTPException(400, { message: "Jogo inválido." });
  const [hash, networkHash] = await Promise.all([voterHash(c), ipHash(c)]);
  const day = voteDay();
  const result = await c.env.merlin_db.prepare(`
    DELETE FROM community_game_votes
    WHERE voter_hash = ? AND vote_day = ? AND app_id = ?
  `).bind(hash, day, appid).run();
  if (!result.meta.changes) {
    throw new HTTPException(409, { message: "Este voto não está mais na sua sessão hoje. Atualize a página." });
  }
  const [count, used, networkVotes, networkOwner] = await Promise.all([
    c.env.merlin_db.prepare("SELECT COUNT(*) AS value FROM community_game_votes WHERE app_id = ?")
      .bind(appid).first<{ value: number }>(),
    c.env.merlin_db.prepare("SELECT COUNT(*) AS value FROM community_game_votes WHERE voter_hash = ? AND vote_day = ?")
      .bind(hash, day).first<{ value: number }>(),
    c.env.merlin_db.prepare("SELECT COUNT(*) AS value FROM community_game_votes WHERE ip_hash = ? AND vote_day = ? AND voter_hash = ?")
      .bind(networkHash, day, hash).first<{ value: number }>(),
    c.env.merlin_db.prepare("SELECT voter_hash FROM community_vote_ip_claims WHERE ip_hash = ? AND vote_day = ?")
      .bind(networkHash, day).first<NetworkOwner>(),
  ]);
  const ipLocked = Boolean(networkOwner && networkOwner.voter_hash !== hash);
  c.header("Cache-Control", "no-store");
  return c.json({ appid, votes: count?.value || 0, voted: false,
    remainingToday: Math.max(0, DAILY_LIMIT - (used?.value || 0)),
    ipRemainingToday: ipLocked ? 0 : Math.max(0, IP_DAILY_LIMIT - (networkVotes?.value || 0)),
    ipLocked,
  });
}
