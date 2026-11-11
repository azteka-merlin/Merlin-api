import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveLibraryGameMetadata, GamesSearchRoute } from "../src/endpoints/games-search";
import { GameSearchRequest, type AppContext } from "../src/types";
import { requireLauncherSearchLicense } from "../src/lib/launcher-auth";

vi.mock("../src/lib/launcher-auth", () => ({ requireLauncherSearchLicense: vi.fn(async () => ({ id: 1 })) }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

function context(row: unknown, fail = false) {
  return { req: {url:'https://api-merlin.com/api/games/search'}, env: { HBCP_KEY:'test-key',merlin_db: { prepare: (sql:string) => sql.includes('game_image_source_settings') ? {first:async()=>({hubcap_enabled:1,ryuu_enabled:0})} : ({ bind: () => ({ first: async () => {
    if (fail) throw new Error("database offline");
    return sql.includes('game_image_metadata_cache')?null:row;
  }, all:async()=>({results:[]}),run:async()=>({success:true}) }) }) ,batch:async()=>[] } } } as unknown as AppContext;
}

describe("Library metadata without Ryuu", () => {
  test("uses cached names and photos without making external requests", async () => {
    const request = vi.fn(() => { throw new Error("External providers must not be probed"); });
    vi.stubGlobal("fetch", request);
    const items = await resolveLibraryGameMetadata(context({ app_id: "10", name: "Cached game",
      cover_url: "https://generator.ryuu.lol/files/images/10.jpg", cover_source: "header_image" }), "10");
    expect(items).toEqual([{ appId: "10", name: "Cached game",
      coverUrl: "https://generator.ryuu.lol/files/images/10.jpg", coverSource: "header_image" }]);
    expect(request).not.toHaveBeenCalled();
  });

  test("stored photo metadata cannot cause an external lookup", async () => {
    const request = vi.fn(); vi.stubGlobal("fetch", request);
    const items = await resolveLibraryGameMetadata(context({ app_id: "20", name: "Game",
      cover_url: "https://example.test/cover.jpg", cover_source: "custom" }), "20");
    expect(items[0].coverUrl).toBe("https://example.test/cover.jpg");
    expect(request).not.toHaveBeenCalled();
  });

  test("missing metadata returns empty without using Hubcap, Ryuu or Steam", async () => {
    const request = vi.fn(() => { throw new Error('External metadata must not be requested'); });
    vi.stubGlobal("fetch", request);
    const items = await resolveLibraryGameMetadata(context(null), "30");
    expect(items).toEqual([]); expect(request).not.toHaveBeenCalled();
  });

  test("a database outage produces an empty metadata result without probing providers", async () => {
    const request = vi.fn(async (input: string) => {
      expect(new URL(input).hostname).toBe("hubcapmanifest.com");
      throw new Error("offline");
    });
    vi.stubGlobal("fetch", request);
    expect(await resolveLibraryGameMetadata(context(null, true), "40")).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  test("rejects non-AppID metadata queries and keeps metadata mode opt-in", async () => {
    await expect(resolveLibraryGameMetadata(context(null), "some title")).rejects.toMatchObject({ status: 400 });
    expect(GameSearchRequest.parse({ searchTerm: "some title" }).metadataOnly).toBe(false);
    expect(GameSearchRequest.parse({ searchTerm: "10", metadataOnly: true }).metadataOnly).toBe(true);
  });

  test("the real search handler selects metadata mode after authenticating", async () => {
    const route = new GamesSearchRoute();
    vi.spyOn(route, "getValidatedData").mockResolvedValue({ body: { searchTerm: "10", metadataOnly: true, limit: 4 } } as never);
    const c = context({ app_id: "10", name: "Game", cover_url: null, cover_source: null });
    c.json = ((body: unknown, status: number) => ({ body, status })) as never;
    const result = await route.handle(c);
    expect(requireLauncherSearchLicense).toHaveBeenCalledWith(c);
    expect(result).toMatchObject({ status: 200, body: { success: true, source: "catalog", items: [{ appId: "10" }] } });
  });

  test("metadata mode does not bypass license authentication", async () => {
    const route = new GamesSearchRoute();
    vi.spyOn(route, "getValidatedData").mockResolvedValue({ body: { searchTerm: "10", metadataOnly: true } } as never);
    vi.mocked(requireLauncherSearchLicense).mockRejectedValueOnce(new Error("unauthorized"));
    await expect(route.handle(context(null))).rejects.toThrow("unauthorized");
  });

  test("normal searches keep the existing response and do not select library mode", async () => {
    const route = new GamesSearchRoute();
    vi.spyOn(route, "getValidatedData").mockResolvedValue({ body: GameSearchRequest.parse({ searchTerm: "unknown title" }) } as never);
    const c = { env: { merlin_db: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) } },
      json: (body: unknown, status: number) => ({ body, status }) } as unknown as AppContext;
    expect(await route.handle(c)).toMatchObject({ status: 200, body: { success: true, source: "depotbox", items: [] } });
  });
});
