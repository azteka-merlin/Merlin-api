import { describe, expect, it, vi } from 'vitest';
import { observeCorrectionFailure, observeCorrectionStream, observeCorrectionsCatalog, observeManifestStream, observeRyuuManifestTimeout } from '../src/lib/service-status-evidence';
import type { AppContext } from '../src/types';

vi.mock('../src/lib/service-status-health', () => ({
  CHECKS: [{ source: 'ryuu' }],
  checkSource: vi.fn(async () => ({ source: 'ryuu', result: 'negative' })),
}));

describe('correction observations', () => {
  it('continues checking Ryuu health when overrides keep a paused catalog available', async () => {
    const fetch = vi.fn(async (url: string) => url.endsWith('/corrections-catalog')
      ? Response.json({ probeHealth: true, observedAt: 123 }) : Response.json({ ok: true }));
    const pending: Promise<unknown>[] = [];
    const c = { env: { STATUS_V1: '1', STATUS_COORDINATOR: { idFromName: () => 'global', get: () => ({ fetch }) } }, executionCtx: { waitUntil(promise: Promise<unknown>) { pending.push(promise); } } } as unknown as AppContext;
    observeCorrectionsCatalog(c, true, 3, 0, 3, true);
    await Promise.all(pending);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toBe('https://status.internal/corrections-catalog-health');
  });

  it('reports a Ryuu activation timeout and confirms health outside the activation response', async () => {
    const fetch = vi.fn(async (url: string) => url.endsWith('/ryuu-manifest-timeout')
      ? Response.json({ probeHealth: true, observedAt: 456 }) : Response.json({ ok: true }));
    const pending: Promise<unknown>[] = [];
    const c = { env: { STATUS_V1: '1', STATUS_COORDINATOR: { idFromName: () => 'global', get: () => ({ fetch }) } }, executionCtx: { waitUntil(promise: Promise<unknown>) { pending.push(promise); } } } as unknown as AppContext;
    observeRyuuManifestTimeout(c);
    expect(pending).toHaveLength(1);
    expect(fetch.mock.calls[0][0]).toBe('https://status.internal/ryuu-manifest-timeout');
    await Promise.all(pending);
    expect(fetch.mock.calls[1][0]).toBe('https://status.internal/corrections-catalog-health');
  });
  it('is entirely inactive unless enabled and bound', () => {
    const fetch = vi.fn();
    const c = { env: { STATUS_V1: '0', STATUS_COORDINATOR: { get: () => ({ fetch }) } } } as unknown as AppContext;
    observeCorrectionFailure(c, 'ryuu', '123');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends only the minimal observation asynchronously', async () => {
    const fetch = vi.fn(async () => new Response('ok'));
    const waitUntil = vi.fn();
    const c = { env: { STATUS_V1: '1', STATUS_COORDINATOR: { idFromName: () => 'global', get: () => ({ fetch }) } }, executionCtx: { waitUntil } } as unknown as AppContext;
    observeCorrectionFailure(c, 'ryuu', '123');
    expect(waitUntil).toHaveBeenCalledOnce();
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body).toEqual({ feature: 'corrections', source: 'ryuu', result: 'failure', subject: '123', operation: expect.any(String) });
  });

  it('preserves stream bytes and reports an upstream failure, but not cancellation', async () => {
    const fetch = vi.fn(async () => new Response('ok'));
    const c = { env: { STATUS_V1: '1', STATUS_COORDINATOR: { idFromName: () => 'global', get: () => ({ fetch }) } }, executionCtx: { waitUntil() {} } } as unknown as AppContext;
    const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); } });
    expect([...new Uint8Array(await new Response(observeCorrectionStream(c, source, '123')).arrayBuffer())]).toEqual([1, 2, 3]);
    const broken = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error('upstream')); } });
    await expect(new Response(observeCorrectionStream(c, broken, '123')).arrayBuffer()).rejects.toThrow('upstream');
    expect(fetch).toHaveBeenCalledOnce();
    const cancel = vi.fn();
    const cancelled = new ReadableStream<Uint8Array>({ cancel });
    await observeCorrectionStream(c, cancelled, '123').cancel('user');
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('only records a game success after the upstream stream completes', async () => {
    const fetch = vi.fn(async () => new Response('ok'));
    const c = { env: { STATUS_V1: '1', STATUS_COORDINATOR: { idFromName: () => 'global', get: () => ({ fetch }) } }, executionCtx: { waitUntil() {} } } as unknown as AppContext;
    const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); } });
    expect([...new Uint8Array(await new Response(observeManifestStream(c, source, '123')).arrayBuffer())]).toEqual([1, 2, 3]);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ feature: 'add_games', result: 'success', subject: '123' });
    const broken = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error('upstream')); } });
    await expect(new Response(observeManifestStream(c, broken, '456')).arrayBuffer()).rejects.toThrow('upstream');
    const cancelled = new ReadableStream<Uint8Array>({});
    await observeManifestStream(c, cancelled, '789').cancel('user');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('counts a Ryuu manifest as recovered only after its ZIP stream completes', async () => {
    const fetch = vi.fn(async () => new Response('ok'));
    const c = { env: { STATUS_V1: '1', STATUS_COORDINATOR: { idFromName: () => 'global', get: () => ({ fetch }) } }, executionCtx: { waitUntil() {} } } as unknown as AppContext;
    const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); } });
    await new Response(observeManifestStream(c, source, '123', true)).arrayBuffer();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toBe('https://status.internal/ryuu-manifest-success');
    const broken = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error('upstream')); } });
    await expect(new Response(observeManifestStream(c, broken, '456', true)).arrayBuffer()).rejects.toThrow('upstream');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
