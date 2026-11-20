import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { expect, it, vi } from "vitest";
import { signAccessToken } from "../src/lib/auth";
import { listCloudGames, restoreCloudGame } from "../src/lib/cloud-sync";
import type { AppBindings } from "../src/types";

const activeLicense = {
  id: 1, license_key: "synthetic-key", name: "Synthetic license", hwid: "test-device",
  expires_at: "2099-01-01T00:00:00Z", status: "active", plan_tier: "ouro",
};

async function fixture() {
  const secret = "test-only-cloud-sync";
  const token = await signAccessToken({
    sub: 1, hwid: "test-device", type: "access", jti: "test-token",
    exp: Math.floor(Date.now() / 1000) + 60,
  }, secret);
  const lookup = vi.fn().mockResolvedValue(activeLicense);
  const list = vi.fn().mockResolvedValue({ objects: [], delimitedPrefixes: [], truncated: false });
  const get = vi.fn();
  const put = vi.fn();
  const env = {
    JWT_SECRET: secret, ENVIRONMENT: "staging",
    merlin_db: { prepare: () => ({ bind: () => ({ first: lookup }) }) },
    MERLIN_FILES: { list, get, put },
  } as unknown as AppBindings;
  const app = new Hono<{ Bindings: AppBindings }>();
  app.get("/games", listCloudGames);
  app.post("/restore", restoreCloudGame);
  app.onError((error, c) => {
    if (!(error instanceof HTTPException)) return c.json({ error: "Unexpected failure" }, 500);
    const code = (error as HTTPException & { code?: string }).code;
    return c.json({ code }, error.status);
  });
  const send = (path: string, method = "GET") => app.request(path, {
    method, headers: { Authorization: "Bearer " + token },
  }, env);
  return { lookup, list, get, put, send };
}

it("recovers from a transient D1 failure before listing cloud saves", async () => {
  const { lookup, list, send } = await fixture();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    lookup.mockRejectedValueOnce(new Error("D1_ERROR", { cause: new Error("Network connection lost. Request 123456.") }));
    const response = await send("/games?accountId=123456");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, games: [] });
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[cloud-sync:license-lookup-failed]", {
      reason: "connection_lost", attempt: 1, willRetry: true,
      d1Message: "D1_ERROR", d1Cause: "Network connection lost. Request [redacted].",
    });
  } finally {
    warn.mockRestore();
  }
});

it("returns an explicit temporary error before a restore can read or write a save", async () => {
  const { lookup, get, put, send } = await fixture();
  lookup.mockRejectedValue(new Error("D1_ERROR: Cannot resolve D1 DB due to transient issue on remote node."));
  const response = await send("/restore", "POST");
  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBe("3");
  expect(await response.json()).toEqual({ code: "cloud_license_unavailable" });
  expect(lookup).toHaveBeenCalledTimes(2);
  expect(get).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();
});

it("fails closed without retrying overload, a revoked license or a SQL error", async () => {
  const { lookup, list, send } = await fixture();
  lookup.mockRejectedValueOnce(new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long."));
  lookup.mockResolvedValueOnce({ ...activeLicense, status: "revoked" });
  lookup.mockRejectedValueOnce(new Error("D1_ERROR: no such column: plan_tier"));
  expect((await send("/games?accountId=123456")).status).toBe(503);
  expect((await send("/games?accountId=123456")).status).toBe(401);
  expect((await send("/games?accountId=123456")).status).toBe(500);
  expect(lookup).toHaveBeenCalledTimes(3);
  expect(list).not.toHaveBeenCalled();
});
