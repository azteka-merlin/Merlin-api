import { describe, expect, test } from "vitest";
import { createSources } from "../src/endpoints/manifests";

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
});
