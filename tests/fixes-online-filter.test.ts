import { describe, expect, test } from "vitest";
import { firstEligibleCorrection, normalizeRemoteEntries } from "../src/endpoints/fixes-catalog";
import { firstEligibleRyuuFix } from "../src/endpoints/fixes-download";

const online = { href: "https://generator.ryuu.lol/fixes/online.zip", filename: "online.zip", badges: ["Tested", " Online "] };
const regular = { href: "https://generator.ryuu.lol/fixes/regular.zip", filename: "regular.zip", size: "5 MB", badges: ["Tested"] };

describe("Online corrections exclusion", () => {
  test("removes Online-only games from the catalog, including mixed-case labels", () => {
    expect(normalizeRemoteEntries([
      { appid: "10", name: "Online only", fixes: [online] },
      { appid: "20", name: "Mixed case", fixes: [{ ...online, badges: ["oNLiNe"] }] },
      { appid: "30", name: "Regular", fixes: [regular] },
    ]).map(entry => entry.appid)).toEqual(["30"]);
  });

  test("keeps the next eligible correction for games with multiple files", () => {
    const entries = normalizeRemoteEntries([{ appid: "10", name: "Mixed files", fixes: [online, regular] }]);
    expect(entries[0].fixes).toEqual([{ href: regular.href, filename: regular.filename, size: regular.size }]);
    // The proxy must serve the same file selected by the catalog.
    expect(firstEligibleRyuuFix([online, regular])).toEqual({ href: regular.href, filename: regular.filename });
  });

  test("does not select an Online archive for a stale catalog download", () => {
    expect(firstEligibleRyuuFix([online])).toBeNull();
    expect(firstEligibleRyuuFix([{ ...online, badges: ["ONLINE"] }])).toBeNull();
  });

  test("preserves Hypervisor exclusion and corrections without labels", () => {
    const unlabelled = { href: regular.href, filename: regular.filename };
    expect(firstEligibleCorrection([{ ...regular, badges: ["Hypervisor"] }])).toBeNull();
    expect(firstEligibleRyuuFix([{ ...regular, badges: ["Hypervisor"] }])).toBeNull();
    expect(firstEligibleCorrection([unlabelled])).toEqual({ ...unlabelled, size: undefined });
    expect(firstEligibleRyuuFix([unlabelled])).toEqual(unlabelled);
  });
});
