import { afterEach, describe, expect, test, vi } from "vitest";
import { getHomeContentImage } from "../src/lib/home-content";
import type { AppContext } from "../src/types";

afterEach(() => vi.restoreAllMocks());

function context(cached: unknown = null) {
  const row = {
    id: 7,
    app_id: "2591280",
    image_mode: "steam",
    image_key: null,
    image_url: "https://cdn.akamai.steamstatic.com/steam/apps/2591280/header.jpg",
    updated_at: "2026-09-28T03:42:44.102Z",
  };
  const get = vi.fn().mockResolvedValue(cached);
  const put = vi.fn().mockResolvedValue(undefined);
  const c = {
    env: {
      merlin_db: { prepare: () => ({ bind: () => ({ first: async () => row }) }) },
      MERLIN_FILES: { get, put },
    },
  } as unknown as AppContext;
  return { c, get, put };
}

describe("home image delivery", () => {
  test("uses a second Steam CDN and saves a successful image in R2", async () => {
    const { c, put } = context();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
        headers: { "Content-Type": "image/jpeg" },
      }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    const result = await getHomeContentImage(c, "7");

    expect(result.kind).toBe("remote");
    if (result.kind === "remote") expect(new Uint8Array(await result.response.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/2591280/header.jpg");
    expect(put).toHaveBeenCalledWith("home/remote-cache/7", expect.any(ArrayBuffer), {
      httpMetadata: { contentType: "image/jpeg" },
      customMetadata: { revision: "2026-09-28T03:42:44.102Z" },
    });
  });

  test("serves a cached image without contacting the Steam CDN", async () => {
    const object = { customMetadata: { revision: "2026-09-28T03:42:44.102Z" }, body: new ReadableStream() };
    const { c } = context(object);
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const result = await getHomeContentImage(c, 7);

    expect(result).toEqual({ kind: "r2", object });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
