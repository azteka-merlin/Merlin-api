import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

describe('service status routes', () => {
  it('keeps the public feature disabled by default and allows Launcher snapshots', async () => {
    const res = await worker.fetch(new Request('https://api.example/api/service-status'), {} as any);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toEqual({ enabled: false });
  });
  it('does not accept unauthenticated direct-source reports', async () => {
    const fetch = vi.fn();
    const coordinator = { idFromName: () => 'global', get: () => ({ fetch }) };
    const res = await worker.fetch(new Request('https://api.example/api/service-status/evidence', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), { STATUS_V1: '1', STATUS_COORDINATOR: coordinator } as any);
    expect(res.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('limits public websocket attempts before accessing the coordinator', async () => {
    const fetch = vi.fn();
    const coordinator = { idFromName: () => 'global', get: () => ({ fetch }) };
    const limit = vi.fn(async () => ({ success: false }));
    const res = await worker.fetch(new Request('https://api.example/api/service-status/ws', { headers: { Upgrade: 'websocket', 'cf-connecting-ip': '192.0.2.1' } }), { STATUS_V1: '1', STATUS_COORDINATOR: coordinator, MANIFESTS_RATE_LIMITER: { limit } } as any);
    expect(res.status).toBe(429);
    expect(fetch).not.toHaveBeenCalled();
    expect(limit).toHaveBeenCalledWith({ key: 'status-ws:192.0.2.1' });
  });
  it('does not expose administrative diagnostics without a session', async () => {
    const res = await worker.fetch(new Request('https://admin.example/panel-api/service-status'), { ADMIN_APP_HOST: 'admin.example', SESSION_HASH_SECRET: 'test', merlin_db: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } } as any);
    expect(res.status).toBe(401);
  });
  it('rejects unauthenticated Ryuu source changes before touching the coordinator', async () => {
    const fetch = vi.fn();
    const coordinator = { idFromName: () => 'global', get: () => ({ fetch }) };
    const res = await worker.fetch(new Request('https://admin.example/panel-api/service-status/corrections-source', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }),
    }), { ADMIN_APP_HOST: 'admin.example', STATUS_V1: '1', STATUS_COORDINATOR: coordinator, SESSION_HASH_SECRET: 'test', merlin_db: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } } as any);
    expect(res.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
});
