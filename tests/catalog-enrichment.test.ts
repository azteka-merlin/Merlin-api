import { describe, expect, test } from "vitest";
import { needsSteamDenuvoResolution, steamRawReleaseDate, steamReleaseDate } from "../src/lib/catalog-enrichment";

describe("catalog enrichment DRM lookup", () => {
  test("uses Steam only when Denuvo is absent from D1", () => {
    expect(needsSteamDenuvoResolution({ denuvo: 1 })).toBe(false);
    expect(needsSteamDenuvoResolution({ denuvo: 0 })).toBe(false);
    expect(needsSteamDenuvoResolution({ denuvo: null })).toBe(true);
    expect(needsSteamDenuvoResolution(undefined)).toBe(true);
  });

  test("keeps official scheduled release dates while the game is coming soon", () => {
    expect(steamReleaseDate("24 Sep, 2026", true)).toBe("2026-09-24");
    expect(steamRawReleaseDate(1790258400, 1)).toBe("2026-09-24");
  });
});
