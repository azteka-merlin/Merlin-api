import { afterEach, describe, expect, test, vi } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { getPicsDepotIds, validateZipDepots } from "../src/lib/manifest-depot-validation";

afterEach(() => vi.restoreAllMocks());

function zipWithLua(appId: string, lua: string) {
  return new Response(zipSync({ [`nested/${appId}.lua`]: strToU8(lua) }), { status: 200 });
}

describe("PICS depot validation", () => {
  test("skips Absolute Sol when the Lua only sets the main depot manifest", async () => {
    const zip = zipWithLua("5062140", [
      "addappid(5062140, 1)",
      "addappid(228989, 1, \"key\")",
      "addappid(228990, 1, \"key\")",
      "setManifestid(5062141, \"6844835323524314032\", 0)",
    ].join("\n"));
    const result = await validateZipDepots(zip, "5062140", ["228989", "228990", "5062141"]);
    expect(result.missingDepotIds).toEqual(["5062141"]);
  });

  test("accepts all required addappid calls and ignores extras", async () => {
    const zip = zipWithLua("500", "addappid(500, 1)\naddappid(501, 1)\naddappid(502, 1)\naddappid(999999, 1)");
    const result = await validateZipDepots(zip, "500", ["501", "502"]);
    expect(result.missingDepotIds).toEqual([]);
    expect((await result.response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  test("cannot count commented addappid calls", async () => {
    const zip = zipWithLua("500", "addappid(500, 1)\n-- addappid(501, 1)\nsetManifestid(501, \"123\", 0)");
    const result = await validateZipDepots(zip, "500", ["501"]);
    expect(result.missingDepotIds).toEqual(["501"]);
  });

  test("keeps original ZIP when inspection cannot determine depot IDs", async () => {
    const bytes = zipSync({ "other.lua": strToU8("addappid(500)") });
    const result = await validateZipDepots(new Response(bytes), "500", ["501"]);
    expect(result.missingDepotIds).toBeNull();
    expect(new Uint8Array(await result.response.arrayBuffer())).toEqual(bytes);
  });

  test("PICS lookup rejects unavailable metadata", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: false }), { status: 503 }));
    await expect(getPicsDepotIds({ MERLIN_WORKER_URL: "https://worker.example.test", MERLIN_WORKER_TOKEN: "token" }, "500"))
      .rejects.toThrow("HTTP 503");
  });
});
