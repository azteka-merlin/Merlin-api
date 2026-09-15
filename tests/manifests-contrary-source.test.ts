import { describe, expect, test } from "vitest";
import { createSources } from "../src/endpoints/manifests";

describe("ContraryCDN manifest source", () => {
  test("adds an authenticated fallback after the configurable primary sources", () => {
    const sources = createSources("271590", {
      CONTRARY_CDN_API_KEY: "test-contrary-key",
      DEPOTBOX_API_KEY: "test-depotbox-key",
      RYU_API_URL: "https://generator.example.test/manifest",
      RYUU_AUTH_CODE: "test-ryuu-code",
      HUBCAP_TOKEN: "test-hubcap-token",
    }, "depotbox");

    expect(sources.map((source) => source.name)).toEqual([
      "depotbox",
      "ryu",
      "contrarycdn",
      "hubcap",
      "skyflare",
      "github-1",
      "github-2",
      "github-3",
    ]);

    const contrary = sources.find((source) => source.name === "contrarycdn");
    expect(contrary).toMatchObject({
      url: "https://contrarycdnapi.duckdns.org/api/v1/contrary/manifest/271590",
      maxAttempts: 1,
      timeoutMs: 300_000,
    });
    expect(new Headers(contrary?.init.headers).get("authorization")).toBe("Bearer test-contrary-key");
  });

  test("does not add the source when the secret is unavailable", () => {
    const sources = createSources("271590", {}, "depotbox");
    expect(sources.some((source) => source.name === "contrarycdn")).toBe(false);
  });
});
