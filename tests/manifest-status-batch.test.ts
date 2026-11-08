import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), overrides: vi.fn(), policy: vi.fn() }));
vi.mock('../src/lib/launcher-auth', async importOriginal => ({ ...await importOriginal(), requireLauncherLicense: mocks.auth }));
vi.mock('../src/lib/overrides', async importOriginal => ({ ...await importOriginal(), readOverrides: mocks.overrides }));
vi.mock('../src/lib/launcher-update-policy-settings', async importOriginal => ({ ...await importOriginal(), getLauncherUpdatePolicySettings: mocks.policy }));
import worker from '../src/index';

beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue({ id: 1 }); mocks.overrides.mockResolvedValue({ '2': { manifestOverride: { enabled: true } } }); mocks.policy.mockResolvedValue({ automaticUpdatesEnabled: true }); });
function request(body: unknown) { return new Request('https://localhost/api/manifests/status-batch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }

describe('manifest policy batch', () => {
  it('authenticates and reads policy and overrides once for several games', async () => {
    const response = await worker.fetch(request({ appIds: ['1', '2', '1'] }), {} as any);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, items: [{ appId: '1', requiresVersionPin: false }, { appId: '2', requiresVersionPin: true }] });
    expect(mocks.auth).toHaveBeenCalledOnce(); expect(mocks.overrides).toHaveBeenCalledOnce(); expect(mocks.policy).toHaveBeenCalledOnce();
  });
  it('respects globally disabled automatic updates', async () => {
    mocks.policy.mockResolvedValue({ automaticUpdatesEnabled: false });
    const response = await worker.fetch(request({ appIds: ['1', '2'] }), {} as any);
    expect((await response.json() as any).items.every((item: any) => item.requiresVersionPin)).toBe(true);
  });
  it('rejects invalid or excessive IDs before reading policy', async () => {
    const response = await worker.fetch(request({ appIds: ['123', 'oops'] }), {} as any);
    expect(response.status).toBe(400); expect(mocks.overrides).not.toHaveBeenCalled();
  });
});
