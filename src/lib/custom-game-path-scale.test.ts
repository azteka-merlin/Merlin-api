import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { validateSortedFolderPaths } from "./custom-games";

describe("large synthetic folder paths", () => {
  for (const count of [277_000, 500_000]) {
    it(`validates ${count} paths without false collisions`, () => {
      const paths = Array.from({ length: count }, (_, i) =>
        `game/romfs/content/level_${String(Math.floor(i / 1000)).padStart(4, "0")}/asset_${String(i).padStart(6, "0")}.bin`);
      const before = process.memoryUsage();
      const start = performance.now();
      validateSortedFolderPaths(paths, { duplicate: "duplicate", conflict: "conflict" });
      const after = process.memoryUsage();
      console.info(JSON.stringify({ count, elapsedMs: Math.round(performance.now() - start),
        heapBeforeBytes: before.heapUsed, heapAfterBytes: after.heapUsed, rssAfterBytes: after.rss,
        runtime: "node-vitest" }));
      expect(paths.length).toBe(count);
    }, 60_000);
  }
});
