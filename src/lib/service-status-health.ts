export const CHECKS = [
  { source: 'hubcap', url: 'https://hubcapmanifest.com/api/v1/health' },
  { source: 'ryuu', url: 'https://generator.ryuu.lol/api/health' },
  { source: 'depotbox', url: 'https://depotbox.org/api/stats' },
] as const;
export async function checkSource(source: typeof CHECKS[number], timeoutMs = 10000, fetcher: typeof fetch = fetch) {
  const start = Date.now(); const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(source.url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) { await response.body?.cancel(); return { source: source.source, result: 'http_error', checkedAt: new Date().toISOString(), responseMs: Date.now() - start }; }
    let data: unknown;
    try { data = await response.json(); } catch { return { source: source.source, result: 'invalid', checkedAt: new Date().toISOString(), responseMs: Date.now() - start }; }
    const payload = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null;
    if (!payload) return { source: source.source, result: 'invalid', checkedAt: new Date().toISOString(), responseMs: Date.now() - start };
    // Only the Ryuu fields are used by the existing Launcher. The other schemas
    // have not been verified and cannot be treated as proof of availability.
    const result = source.source === 'ryuu' && typeof payload.status === 'string' && typeof payload.downloads_available === 'boolean'
      ? (payload.status === 'ok' && payload.downloads_available ? 'healthy' : 'negative') : 'unknown';
    return { source: source.source, result, checkedAt: new Date().toISOString(), responseMs: Date.now() - start };
  } catch {
    return { source: source.source, result: controller.signal.aborted ? 'timeout' : 'network_error', checkedAt: new Date().toISOString(), responseMs: Date.now() - start };
  } finally { clearTimeout(timer); }
}
