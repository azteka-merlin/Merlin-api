import { describe, expect, test } from "vitest";
import { sortCorrectionCatalog } from "../src/endpoints/fixes-catalog";

const fix = { href: "https://example.test/fix.zip", filename: "fix.zip" };

describe("corrections catalog ordering", () => {
  test("prioritizes newest release, then DRM, then community rating", () => {
    const ordered = sortCorrectionCatalog([
      { appid: "1", name: "Older with DRM", releaseDate: "2026-01-01", hasDrm: true, fixes: [{ ...fix, score: 99, upvotes: 99 }] },
      { appid: "2", name: "Newest no DRM", releaseDate: "2026-02-01", hasDrm: false, fixes: [{ ...fix, score: 0 }] },
      { appid: "3", name: "Newest DRM low score", releaseDate: "2026-02-01", hasDrm: true, fixes: [{ ...fix, score: 1 }] },
      { appid: "4", name: "Newest DRM high score", releaseDate: "2026-02-01", hasDrm: true, fixes: [{ ...fix, score: 5 }] },
      { appid: "5", name: "No release date", releaseDate: null, hasDrm: true, fixes: [{ ...fix, score: 500 }] },
    ]);

    expect(ordered.map((item) => item.appid)).toEqual(["4", "3", "2", "1", "5"]);
  });
});
