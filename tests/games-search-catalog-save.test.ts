import { afterEach, describe, expect, it, vi } from 'vitest';
import { GamesSearchRoute } from '../src/endpoints/games-search';
import { GameSearchRequest, type AppContext } from '../src/types';

vi.mock('../src/lib/launcher-auth', () => ({ requireLauncherSearchLicense: vi.fn(async () => ({ id: 1 })) }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function harness(batch = vi.fn(async () => [])) {
  const pending: Promise<unknown>[] = [];
  const statements: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    prepare(sql: string) { return { bind(...args: unknown[]) {
      const stmt = { sql, args }; statements.push(stmt);
      return { ...stmt, all: async () => ({ results: [] }) };
    } }; }, batch,
  };
  const c = { env: { merlin_db: db, DEPOTBOX_API_KEY: 'synthetic' },
    executionCtx: { waitUntil(promise: Promise<unknown>) { pending.push(promise); } },
    json: (body: unknown, status: number) => ({ body, status }) } as unknown as AppContext;
  return { c, batch, pending, statements };
}

describe('Launcher search and central game catalog', () => {
  it('returns a verified fallback result and saves it in the background', async () => {
    const fetch = vi.fn(async (url: string | URL) => {
      if (String(url).startsWith('https://depotbox.org/')) return Response.json({ success: true, games: [{ appid: '987654321', name: 'Synthetic game' }] });
      if (String(url).startsWith('https://store.steampowered.com/')) return Response.json({ '987654321': { success: true, data: { type: 'game', name: 'Synthetic game', header_image: 'https://example.test/cover.jpg' } } });
      throw new Error('Unexpected external request');
    });
    vi.stubGlobal('fetch', fetch);
    const h = harness(); const route = new GamesSearchRoute();
    vi.spyOn(route, 'getValidatedData').mockResolvedValue({ body: GameSearchRequest.parse({ searchTerm: 'synthetic-save-test', limit: 4 }) } as never);
    const result = await route.handle(h.c);
    expect(result).toMatchObject({ status: 200, body: { success: true, source: 'depotbox', items: [{ appId: '987654321', name: 'Synthetic game' }] } });
    expect(h.pending).toHaveLength(1);
    await Promise.all(h.pending);
    expect(h.batch).toHaveBeenCalledOnce();
    const written = h.statements.find(statement => statement.sql.includes('INSERT INTO games_catalog'));
    expect(written?.args).toEqual(['987654321', 'Synthetic game', 'https://example.test/cover.jpg', 'steam_header_image', 'depotbox', expect.any(String)]);
  });

  it('does not write an empty or failed provider result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })));
    const h = harness(); const route = new GamesSearchRoute();
    vi.spyOn(route, 'getValidatedData').mockResolvedValue({ body: GameSearchRequest.parse({ searchTerm: 'synthetic-limit-test' }) } as never);
    const result = await route.handle(h.c);
    expect(result).toMatchObject({ status: 200, body: { success: true, items: [] } });
    expect(h.pending).toHaveLength(0);
    expect(h.batch).not.toHaveBeenCalled();
  });

  it('does not send unsupported multi-ID basic queries to Steam', async () => {
    const fetch = vi.fn(async (url: string | URL) => {
      if (String(url).startsWith('https://depotbox.org/')) return Response.json({ success: true, games: [
        { appid: '876540001', name: 'Synthetic one' }, { appid: '876540002', name: 'Synthetic two' },
      ] });
      throw new Error('Unexpected Steam or other request');
    });
    vi.stubGlobal('fetch', fetch);
    const h = harness(); const route = new GamesSearchRoute();
    vi.spyOn(route, 'getValidatedData').mockResolvedValue({ body: GameSearchRequest.parse({ searchTerm: 'synthetic-multiple' }) } as never);
    const result = await route.handle(h.c);
    expect(result).toMatchObject({ status: 200, body: { success: true, items: [{ appId: '876540001' }, { appId: '876540002' }] } });
    expect(fetch).toHaveBeenCalledTimes(1);
    await Promise.all(h.pending);
  });
});
