import type { AppContext } from '../types';
import { CHECKS, checkSource } from './service-status-health';

// An observation must never delay, replace or fail the user's original request.
// Only a game identifier is sent; no license, user or network identifiers are included.
function observe(c: AppContext, feature: 'corrections' | 'add_games', source: 'ryuu' | 'depotbox' | 'r2' | 'other', appId: string, result: 'failure' | 'success') {
  if (c.env.STATUS_V1 !== '1' || !c.env.STATUS_COORDINATOR) return;
  try {
    const executionCtx = c.executionCtx;
    const namespace = c.env.STATUS_COORDINATOR;
    const request = namespace.get(namespace.idFromName('global')).fetch('https://status.internal/evidence', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ feature, source, result, subject: appId, operation: crypto.randomUUID() }),
    }).catch(() => undefined);
    executionCtx.waitUntil(request);
  } catch {
    // Contexts without waitUntil must retain the original download behavior.
  }
}

export function observeCorrectionFailure(c: AppContext, source: 'ryuu' | 'depotbox' | 'r2', appId: string) {
  observe(c, 'corrections', source, appId, 'failure');
}

async function confirmRyuuHealth(stub: { fetch: (request: RequestInfo | URL, init?: RequestInit) => Promise<Response> }, response: Response) {
  if (!response.ok) return;
  const decision = await response.json() as { probeHealth?: boolean; observedAt?: number };
  if (!decision.probeHealth) return;
  const ryuu = CHECKS.find(item => item.source === 'ryuu')!;
  const health = await checkSource(ryuu, 5_000);
  await stub.fetch('https://status.internal/corrections-catalog-health', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ result: health.result, observedAt: decision.observedAt }),
  });
}

// A Ryuu manifest timeout is evidence even when a later cascade source succeeds.
// The global health lease and its five-second check run only in waitUntil.
export function observeRyuuManifestTimeout(c: AppContext) {
  if (c.env.STATUS_V1 !== '1' || !c.env.STATUS_COORDINATOR) return;
  try {
    const namespace = c.env.STATUS_COORDINATOR;
    const stub = namespace.get(namespace.idFromName('global'));
    const request = stub.fetch('https://status.internal/ryuu-manifest-timeout', { method: 'POST' })
      .then(response => confirmRyuuHealth(stub, response)).catch(() => undefined);
    c.executionCtx.waitUntil(request);
  } catch { /* Status must never delay or fail an activation. */ }
}

export function observeRyuuManifestSuccess(c: AppContext) {
  if (c.env.STATUS_V1 !== '1' || !c.env.STATUS_COORDINATOR) return;
  try {
    const namespace = c.env.STATUS_COORDINATOR;
    const request = namespace.get(namespace.idFromName('global'))
      .fetch('https://status.internal/ryuu-manifest-success', { method: 'POST' }).catch(() => undefined);
    c.executionCtx.waitUntil(request);
  } catch { /* Status must never delay or fail an activation. */ }
}

// Only aggregate availability and item count are sent; the catalog payload,
// license and user data are not copied into status history.
export function observeCorrectionsCatalog(c: AppContext, available: boolean, itemCount: number, remoteCount: number, overrideCount: number, skipped = false) {
  if (c.env.STATUS_V1 !== '1' || !c.env.STATUS_COORDINATOR) return;
  try {
    const executionCtx = c.executionCtx;
    const namespace = c.env.STATUS_COORDINATOR;
    const stub = namespace.get(namespace.idFromName('global'));
    const request = stub.fetch('https://status.internal/corrections-catalog', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ available, itemCount, remoteCount, overrideCount, skipped }),
    }).then(async response => {
      // Overrides can keep the catalog available while Ryuu is paused. Keep
      // probing Ryuu health in that case, without blocking the catalog.
      if ((available && !skipped) || !response.ok) return;
      await confirmRyuuHealth(stub, response);
    }).catch(() => undefined);
    executionCtx.waitUntil(request);
  } catch { /* Status must never affect the catalog response. */ }
}

export function observeManifestFailure(c: AppContext, appId: string) {
  observe(c, 'add_games', 'other', appId, 'failure');
}

export function observeManifestStream(c: AppContext, body: ReadableStream<Uint8Array>, appId: string, fromRyuu = false): ReadableStream<Uint8Array> {
  if (c.env.STATUS_V1 !== '1' || !c.env.STATUS_COORDINATOR) return body;
  const reader = body.getReader();
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          if (!cancelled) {
            observe(c, 'add_games', 'other', appId, 'success');
            if (fromRyuu) observeRyuuManifestSuccess(c);
          }
        }
        else controller.enqueue(chunk.value);
      } catch (error) { if (!cancelled) controller.error(error); }
    },
    cancel(reason) { cancelled = true; return reader.cancel(reason); },
  });
}

// Observe upstream stream errors only. Client cancellation is forwarded and is
// deliberately not counted as a supplier failure.
export function observeCorrectionStream(c: AppContext, body: ReadableStream<Uint8Array>, appId: string): ReadableStream<Uint8Array> {
  if (c.env.STATUS_V1 !== '1' || !c.env.STATUS_COORDINATOR) return body;
  const reader = body.getReader();
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) controller.close(); else controller.enqueue(chunk.value);
      } catch (error) {
        if (!cancelled) { observeCorrectionFailure(c, 'ryuu', appId); controller.error(error); }
      }
    },
    cancel(reason) { cancelled = true; return reader.cancel(reason); },
  });
}
