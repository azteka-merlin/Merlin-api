import { afterEach, describe, expect, test, vi } from "vitest";
import { createSources, fetchSource, fetchHubcapSource } from "../src/endpoints/manifests";

afterEach(() => vi.restoreAllMocks());
describe("Hubcap manifests", () => {
  test("downloads the Hubcap ZIP once with bearer authentication", async () => {
    const source = createSources("400", { HBCP_KEY: "secret" }, "hubcap")[0]!;
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]);
    const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(zip));
    const result = await fetchSource(source, "400");
    expect(new Uint8Array(await result.response!.arrayBuffer())).toEqual(zip);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0]![0]).toBe("https://hubcapmanifest.com/api/v1/manifest/400");
    expect(new Headers(mock.mock.calls[0]![1]?.headers).get("Authorization")).toBe("Bearer secret");
  });
  test("skips Hubcap without a token", () => {
    expect(createSources("400", {}, "hubcap").some(s => s.name === "hubcap")).toBe(false);
  });
  test("opens the circuit if quota runs out between the usage check and the download", async () => {
    const rows = new Map<string, number>();
    const db = { prepare: (sql: string) => ({ bind: (key: string, retry?: number) => ({
      first: async () => rows.has(key) ? { retry_after: rows.get(key) } : null,
      run: async () => { if (sql.startsWith("DELETE")) rows.delete(key); else rows.set(key, retry!); },
    }) }) } as unknown as D1Database;
    const source = createSources("400", { HBCP_KEY: "secret" }, "hubcap")[0]!;
    const mock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ daily_usage: 999, daily_limit: 1000, can_make_requests: true }))
      .mockResolvedValueOnce(new Response("quota", { status: 429 }))
      .mockResolvedValueOnce(Response.json({ daily_usage: 1000, daily_limit: 1000, can_make_requests: false }));
    expect((await fetchHubcapSource(source, "400", db, "secret")).response).toBeNull();
    expect((await fetchHubcapSource(source, "400", db, "secret")).response).toBeNull();
    expect(mock).toHaveBeenCalledTimes(3);
    expect(rows.size).toBe(1);
  });

  test("continues to Ryuu in the same request when Hubcap usage is exhausted", async () => {
    const db = { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({}) }) }) } as unknown as D1Database;
    const sources = createSources("400", { HBCP_KEY: "secret", RYU_API_URL: "https://ryuu.example/download", RYUU_AUTH_CODE: "ryuu-key" }, "hubcap");
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]);
    const mock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ daily_usage: 1000, daily_limit: 1000, can_make_requests: false }))
      .mockResolvedValueOnce(new Response(zip));
    const hubcap = await fetchHubcapSource(sources[0]!, "400", db, "secret");
    expect(hubcap.response).toBeNull();
    const ryuu = await fetchSource(sources[1]!, "400");
    expect(ryuu.response).not.toBeNull();
    expect(sources[1]!.name).toBe("ryu");
    expect(mock).toHaveBeenCalledTimes(2);
  });

});
