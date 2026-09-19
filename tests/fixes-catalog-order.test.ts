import { describe, expect, test } from "vitest";
import { sortCorrectionCatalog } from "../src/endpoints/fixes-catalog";

const fix = { href: "https://example.test/fix.zip", filename: "fix.zip" };

describe("corrections catalog ordering", () => {
  test("prioritizes current-year releases and manual additions, then older DRM, then the rest by votes", () => {
    const ordered = sortCorrectionCatalog([
      { appid: "1", name: "Older DRM", releaseDate: "2025-12-01", manualAddedAt: null, hasDrm: true, fixes: [{ ...fix, score: 99 }] },
      { appid: "2", name: "Current release", releaseDate: "2026-08-01", manualAddedAt: null, hasDrm: false, fixes: [{ ...fix, score: 10 }] },
      { appid: "3", name: "Current DRM", releaseDate: "2026-07-01", manualAddedAt: null, hasDrm: true, fixes: [{ ...fix, score: 1 }] },
      { appid: "4", name: "Manual addition", releaseDate: null, manualAddedAt: "2026-09-17", hasDrm: false, fixes: [{ ...fix, score: 0 }] },
      { appid: "5", name: "Higher voted old regular", releaseDate: "2025-10-01", manualAddedAt: null, hasDrm: false, fixes: [{ ...fix, score: 500, upvotes: 500 }] },
      { appid: "6", name: "Newer low-voted old regular", releaseDate: "2025-12-31", manualAddedAt: null, hasDrm: false, fixes: [{ ...fix, score: 1, upvotes: 1 }] },
    ]);

    expect(ordered.map((item) => item.appid)).toEqual(["3", "2", "4", "1", "5", "6"]);
  });
});
