import { describe, expect, test } from "vitest";
import { isDenuvoMetadata, sortCorrectionCatalog } from "../src/endpoints/fixes-catalog";

const fix = { href: "https://example.test/fix.zip", filename: "fix.zip" };

describe("corrections catalog ordering", () => {
  test("only classifies explicit Denuvo metadata as Denuvo", () => {
    expect(isDenuvoMetadata({ denuvo: 1 })).toBe(true);
    expect(isDenuvoMetadata({ denuvo: 0 })).toBe(false);
    expect(isDenuvoMetadata(null)).toBe(false);
  });

  test("prioritizes all DRM, then voted games by vote count with release date as a tiebreaker", () => {
    const ordered = sortCorrectionCatalog([
      { appid: "1", name: "Older DRM", releaseDate: "2025-12-01", manualAddedAt: null, hasDrm: true, fixes: [{ ...fix, score: 99 }] },
      { appid: "2", name: "Current voted game", releaseDate: "2026-08-01", manualAddedAt: null, hasDrm: false, fixes: [{ ...fix, score: 10, upvotes: 10 }] },
      { appid: "3", name: "Current DRM", releaseDate: "2026-07-01", manualAddedAt: null, hasDrm: true, fixes: [{ ...fix, score: 1 }] },
      { appid: "4", name: "Manual addition", releaseDate: null, manualAddedAt: "2026-09-17", hasDrm: false, fixes: [{ ...fix, score: 0 }] },
      { appid: "5", name: "Higher voted old regular", releaseDate: "2025-10-01", manualAddedAt: null, hasDrm: false, fixes: [{ ...fix, score: 500, upvotes: 500 }] },
      { appid: "6", name: "Older equally voted regular", releaseDate: "2025-12-31", manualAddedAt: null, hasDrm: false, fixes: [{ ...fix, score: 10, upvotes: 10 }] },
      { appid: "7", name: "Current game without votes", releaseDate: "2026-09-01", manualAddedAt: null, hasDrm: false, fixes: [{ ...fix, score: 0 }] },
    ]);

    expect(ordered.map((item) => item.appid)).toEqual(["3", "1", "5", "2", "6", "7", "4"]);
  });
});
