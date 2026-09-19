import { describe, expect, test } from "vitest";
import { needsSteamDenuvoResolution } from "../src/lib/catalog-enrichment";

describe("catalog enrichment DRM lookup", () => {
  test("uses Steam only when Denuvo is absent from D1", () => {
    expect(needsSteamDenuvoResolution({ denuvo: 1 })).toBe(false);
    expect(needsSteamDenuvoResolution({ denuvo: 0 })).toBe(false);
    expect(needsSteamDenuvoResolution({ denuvo: null })).toBe(true);
    expect(needsSteamDenuvoResolution(undefined)).toBe(true);
  });
});
