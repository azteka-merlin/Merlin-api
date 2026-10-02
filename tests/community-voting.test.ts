import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import votingGames from "../src/data/community-voting-games.json";
import { getCommunityVoting, postCommunityVote, removeCommunityVote } from "../src/lib/community-voting";
import type { AppBindings } from "../src/types";

function votingApp() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE premium_games (app_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1)");
  sqlite.exec(readFileSync(new URL("../migrations/0070_community_voting.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../migrations/0071_community_voting_ip.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../migrations/0072_community_vote_ip_claims.sql", import.meta.url), "utf8"));
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      return {
        bind(...values: unknown[]) { args = values; return this; },
        async all() { return { results: sqlite.prepare(sql).all(...args as []) }; },
        async first() { return sqlite.prepare(sql).get(...args as []) || null; },
        async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args as []).changes) } }; },
      };
    },
  };
  const env = { merlin_db: db, SESSION_HASH_SECRET: "test-secret", ENVIRONMENT: "production" } as unknown as AppBindings;
  const app = new Hono<{ Bindings: AppBindings }>();
  app.get("/games", getCommunityVoting);
  app.post("/votes", postCommunityVote);
  app.post("/votes/remove", removeCommunityVote);
  const request = (path: string, init: RequestInit, ip: string, cookie?: string) => app.request(`https://example.test${path}`, {
    ...init,
    headers: { "cf-connecting-ip": ip, ...(cookie ? { cookie } : {}), ...init.headers },
  }, env);
  const session = async (ip: string) => {
    const response = await request("/games", {}, ip);
    expect(response.status).toBe(200);
    return response.headers.get("set-cookie")!.split(";")[0];
  };
  const vote = (ip: string, cookie: string, appid: string) => request("/votes", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appid }),
  }, ip, cookie);
  const remove = (ip: string, cookie: string, appid: string) => request("/votes/remove", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appid }),
  }, ip, cookie);
  return { sqlite, request, session, vote, remove };
}

describe("community voting session and IP limits", () => {
  test("removes only the current session's vote and frees a choice", async () => {
    const { sqlite, request, session, vote, remove } = votingApp();
    const ip = "203.0.113.7";
    const cookie = await session(ip);
    const otherCookie = await session(ip);
    const ids = votingGames.slice(0, 5).map((game) => game.appid);

    for (const id of ids.slice(0, 3)) expect((await vote(ip, cookie, id)).status).toBe(201);
    expect((await vote(ip, cookie, ids[3])).status).toBe(409);
    expect((await remove(ip, otherCookie, ids[0])).status).toBe(409);
    expect((await remove(ip, cookie, ids[0])).status).toBe(200);
    expect((await remove(ip, cookie, ids[0])).status).toBe(409);

    const afterRemoval = await (await request("/games", {}, ip, cookie)).json() as { remainingToday: number };
    expect(afterRemoval.remainingToday).toBe(1);
    expect((await vote(ip, cookie, ids[3])).status).toBe(201);

    const state = await (await request("/games", {}, ip, cookie)).json() as {
      games: Array<{ appid: string; voted: boolean; votes: number }>;
      remainingToday: number;
    };
    expect(state.remainingToday).toBe(0);
    expect(state.games.find((game) => game.appid === ids[0])).toMatchObject({ voted: false, votes: 0 });
    expect(state.games.find((game) => game.appid === ids[3])).toMatchObject({ voted: true, votes: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM community_game_votes").get()).toMatchObject({ count: 3 });
    sqlite.close();
  });

  test("keeps the IP bound after removing the last vote, including a repeat vote", async () => {
    const { sqlite, request, session, vote, remove } = votingApp();
    const ip = "203.0.113.8";
    const ids = votingGames.slice(0, 5).map((game) => game.appid);
    const firstSession = await session(ip);
    const anonymousSession = await session(ip);

    expect((await vote(ip, firstSession, ids[0])).status).toBe(201);
    const anonymousState = await (await request("/games", {}, ip, anonymousSession)).json() as {
      ipLocked: boolean; ipRemainingToday: number; remainingToday: number;
    };
    expect(anonymousState).toMatchObject({ ipLocked: true, ipRemainingToday: 0, remainingToday: 3 });
    expect((await vote(ip, anonymousSession, ids[1])).status).toBe(429);
    expect((await remove(ip, firstSession, ids[0])).status).toBe(200);
    expect((await vote(ip, anonymousSession, ids[1])).status).toBe(429);
    expect((await vote(ip, firstSession, ids[0])).status).toBe(201);
    expect((await vote(ip, firstSession, ids[1])).status).toBe(201);
    expect((await vote(ip, firstSession, ids[2])).status).toBe(201);
    expect((await remove(ip, firstSession, ids[0])).status).toBe(200);
    expect((await vote(ip, firstSession, ids[3])).status).toBe(201);
    expect((await vote(ip, anonymousSession, ids[4])).status).toBe(429);
    expect((await vote("203.0.113.9", anonymousSession, ids[4])).status).toBe(201);
    const hashes = sqlite.prepare("SELECT DISTINCT ip_hash FROM community_game_votes").all() as Array<{ ip_hash: string }>;
    expect(hashes).toHaveLength(2);
    expect(hashes.every((row) => /^[a-f0-9]{64}$/.test(row.ip_hash))).toBe(true);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM community_vote_ip_claims").get()).toMatchObject({ count: 2 });
    sqlite.close();
  });

  test("removing a vote frees the owner even with legacy votes from another session on the IP", async () => {
    const { sqlite, request, session, vote, remove } = votingApp();
    const ip = "203.0.113.10";
    const cookie = await session(ip);
    const ids = votingGames.slice(0, 5).map((game) => game.appid);
    expect((await vote(ip, cookie, ids[0])).status).toBe(201);

    const network = sqlite.prepare("SELECT ip_hash, vote_day FROM community_game_votes LIMIT 1")
      .get() as { ip_hash: string; vote_day: string };
    sqlite.exec("DROP TRIGGER trg_community_vote_ip_claim");
    for (const id of ids.slice(1, 4)) {
      sqlite.prepare("INSERT INTO community_game_votes (app_id, voter_hash, vote_day, ip_hash) VALUES (?, ?, ?, ?)")
        .run(id, "f".repeat(64), network.vote_day, network.ip_hash);
    }
    sqlite.exec(readFileSync(new URL("../migrations/0072_community_vote_ip_claims.sql", import.meta.url), "utf8"));

    expect((await remove(ip, cookie, ids[0])).status).toBe(200);
    const state = await (await request("/games", {}, ip, cookie)).json() as {
      remainingToday: number; ipRemainingToday: number; ipLocked: boolean;
    };
    expect(state).toMatchObject({ remainingToday: 3, ipRemainingToday: 3, ipLocked: false });
    expect((await vote(ip, cookie, ids[4])).status).toBe(201);
    sqlite.close();
  });

  test("groups different IPv6 addresses in the same /64 network", async () => {
    const { sqlite, request, session, vote } = votingApp();
    const firstIp = "2001:db8:abcd:1000:1111:2222:3333:4444";
    const sameNetworkIp = "2001:0db8:abcd:1000::1234";
    const otherNetworkIp = "2001:db8:abcd:1001::1";
    const firstSession = await session(firstIp);
    const secondSession = await session(sameNetworkIp);
    const thirdSession = await session(otherNetworkIp);
    const ids = votingGames.slice(0, 3).map((game) => game.appid);

    expect((await vote(firstIp, firstSession, ids[0])).status).toBe(201);
    const blocked = await (await request("/games", {}, sameNetworkIp, secondSession)).json() as {
      ipLocked: boolean; ipRemainingToday: number;
    };
    expect(blocked).toMatchObject({ ipLocked: true, ipRemainingToday: 0 });
    expect((await vote(sameNetworkIp, secondSession, ids[1])).status).toBe(429);
    expect((await vote(otherNetworkIp, thirdSession, ids[2])).status).toBe(201);
    sqlite.close();
  });

});
