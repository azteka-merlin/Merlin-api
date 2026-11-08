import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHECKS, checkSource } from '../src/lib/service-status-health';

const ryuu = CHECKS.find(item => item.source === 'ryuu')!;
afterEach(() => vi.useRealTimers());

describe('source health classification', () => {
  it('recognizes Ryuu health and negative signals without trusting other schemas', async () => {
    const response = (body: unknown) => vi.fn(async () => Response.json(body)) as unknown as typeof fetch;
    expect((await checkSource(ryuu, 10000, response({ status: 'ok', downloads_available: true }))).result).toBe('healthy');
    expect((await checkSource(ryuu, 10000, response({ status: 'ok', downloads_available: false }))).result).toBe('negative');
    expect((await checkSource(CHECKS[2], 10000, response({ status: 'ok', downloads_available: true }))).result).toBe('unknown');
  });

  it('separates HTTP errors, invalid responses and network errors', async () => {
    expect((await checkSource(ryuu, 10000, vi.fn(async () => new Response('', { status: 503 })) as unknown as typeof fetch)).result).toBe('http_error');
    expect((await checkSource(ryuu, 10000, vi.fn(async () => new Response('not json')) as unknown as typeof fetch)).result).toBe('invalid');
    expect((await checkSource(ryuu, 10000, vi.fn(async () => { throw Error('network'); }) as unknown as typeof fetch)).result).toBe('network_error');
  });

  it('aborts a slow request at the configured timeout', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const fetcher = vi.fn((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
    })) as unknown as typeof fetch;
    const pending = checkSource(ryuu, 10000, fetcher);
    await vi.advanceTimersByTimeAsync(9999);
    expect(aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(aborted).toBe(true);
    expect((await pending).result).toBe('timeout');
  });
});
