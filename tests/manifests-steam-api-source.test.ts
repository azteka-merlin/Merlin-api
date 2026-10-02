import { afterEach, describe, expect, test, vi } from "vitest";
import { createSources, fetchSource } from "../src/endpoints/manifests";

afterEach(() => vi.restoreAllMocks());

describe("Steam API manifest source", () => {
  test("adds the authenticated ZIP source after DepotBox and Ryuu by default", () => {
    const sources = createSources("271590", {
      STEAM_API_KEY: "test-steam-api-key",
      DEPOTBOX_API_KEY: "test-depotbox-key",
      RYU_API_URL: "https://generator.example.test/manifest",
      RYUU_AUTH_CODE: "test-ryuu-code",
      HUBCAP_TOKEN: "test-hubcap-token",
    }, "depotbox");

    expect(sources.map((source) => source.name)).toEqual([
      "depotbox",
      "ryu",
      "steam-api",
      "hubcap",
      "skyflare",
      "github-1",
      "github-2",
      "github-3",
    ]);

    const steamApi = sources.find((source) => source.name === "steam-api");
    expect(steamApi).toMatchObject({
      url: "https://api.steamtools.app/api/manifest/271590",
      maxAttempts: 1,
      timeoutMs: 10_000,
    });
    expect(new Headers(steamApi?.init.headers).get("x-api-key")).toBe("test-steam-api-key");
  });

  test("skips the source when its secret is unavailable", () => {
    const sources = createSources("271590", {}, "depotbox");
    expect(sources.some((source) => source.name === "steam-api")).toBe(false);
  });

  test("puts Steam API first when selected in settings", () => {
    const sources = createSources("271590", {
      STEAM_API_KEY: "test-steam-api-key",
      DEPOTBOX_API_KEY: "test-depotbox-key",
      RYU_API_URL: "https://generator.example.test/manifest",
      RYUU_AUTH_CODE: "test-ryuu-code",
    }, "steam-api");

    expect(sources.slice(0, 3).map((source) => source.name)).toEqual(["steam-api", "depotbox", "ryu"]);
  });

  test("skips the ZIP when generation reports zero depots", async () => {
    const source = createSources("5254710", { STEAM_API_KEY: "test-steam-api-key" }, "steam-api")[0]!;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, depots: {} }), { status: 200 }),
    );

    const result = await fetchSource(source, "5254710");

    expect(result.response).toBeNull();
    expect(result.outcome.kind).toBe("no_depots");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.steamtools.app/api/generate");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ appid: "5254710" }),
    });
  });

  test("downloads the ZIP when generation reports depots", async () => {
    const source = createSources("500", { STEAM_API_KEY: "test-steam-api-key" }, "steam-api")[0]!;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, depots: { "501": "key" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]), { status: 200 }));

    const result = await fetchSource(source, "500");

    expect(result.response).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.steamtools.app/api/manifest/500");
  });
});
