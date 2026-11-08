import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Durable Object provides a snapshot and does not infer an incident without health evidence', async () => {
  const bundled = await build({
    stdin: {
      contents: `import { MerlinStatus as BaseStatus } from './src/lib/service-status.ts';
        let checks = 0;
        globalThis.fetch = async () => { checks++; return Response.json({ status: 'ok', downloads_available: true }); };
        export class MerlinStatus extends BaseStatus {
          async fetch(request) {
            const url = new URL(request.url);
            if (url.pathname === '/__diagnostic') {
              await this.ctx.storage.put('diagnostics', { ryuu: { source: 'ryuu', result: 'negative', checkedAt: new Date().toISOString(), responseMs: 5 } });
              this.diagnostics = {}; return new Response('ok');
            }
            if (url.pathname === '/__alarm') { await this.alarm(); return new Response('ok'); }
            if (url.pathname === '/__seed' && request.method === 'POST') { await this.ctx.storage.put('state', await request.json()); return new Response('ok'); }
            return super.fetch(request);
          }
        }
        export default { fetch(request, env) {
          if (new URL(request.url).pathname === '/__checks') return Response.json({ checks });
          return env.STATUS.get(env.STATUS.idFromName('global')).fetch(request);
        } };`,
      resolveDir: process.cwd(), sourcefile: 'test-worker.ts', loader: 'ts',
    },
    bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'],
  });
  const options = {
    modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-06-20',
    durableObjects: { STATUS: { className: 'MerlinStatus', useSQLite: true } },
    bindings: { STATUS_V1: '1', STATUS_PROBES_ENABLED: '1' },
    durableObjectsPersist: mkdtempSync(join(tmpdir(), 'merlin-status-test-')),
  };
  let mf = new Miniflare(options);
  try {
    const snapshot = await (await mf.dispatchFetch('http://localhost/snapshot')).json();
    assert.deepEqual(snapshot, { schemaVersion: 1, revision: 0, incidents: [], correctionsSource: { ryuuEnabled: true } });
    const response = await mf.dispatchFetch('http://localhost/ws', { headers: { Upgrade: 'websocket' } });
    assert.equal(response.status, 101);
    const socket = response.webSocket;
    const first = new Promise(resolve => socket.addEventListener('message', event => resolve(JSON.parse(event.data)), { once: true }));
    socket.accept();
    assert.deepEqual(await first, snapshot);
    for (const [subject, operation] of [['a','1'], ['a','1'], ['b','2'], ['c','3']]) {
      const r = await mf.dispatchFetch('http://localhost/evidence', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ feature: 'corrections', source: 'ryuu', result: 'failure', subject, operation }),
      });
      assert.equal(r.status, 200);
    }
    assert.deepEqual(await (await mf.dispatchFetch('http://localhost/snapshot')).json(), snapshot);
    await mf.dispatchFetch('http://localhost/__seed', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: 0, incidents: [], failures: {}, recovery: {}, history: [] }) });
    await mf.dispatchFetch('http://localhost/__diagnostic');
    for (const [subject, operation] of [['a','untrusted1'], ['b','untrusted2'], ['c','untrusted3']]) {
      await mf.dispatchFetch('http://localhost/evidence', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ feature: 'corrections', source: 'ryuu', result: 'failure', subject, operation, trusted: false }),
      });
    }
    assert.equal((await (await mf.dispatchFetch('http://localhost/snapshot')).json()).incidents.length, 0);
    for (const [subject, operation] of [['a','4'], ['b','5'], ['c','6']]) {
      await mf.dispatchFetch('http://localhost/evidence', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ feature: 'corrections', source: 'ryuu', result: 'failure', subject, operation }),
      });
    }
    const incident = await (await mf.dispatchFetch('http://localhost/snapshot')).json();
    assert.equal(incident.incidents.length, 1);
    assert.equal(incident.revision, 1);
    assert.equal('source' in incident.incidents[0], false);
    await mf.dispatchFetch('http://localhost/__alarm');
    assert.equal((await (await mf.dispatchFetch('http://localhost/snapshot')).json()).incidents.length, 1);
    await mf.dispatchFetch('http://localhost/evidence', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ feature: 'corrections', source: 'ryuu', result: 'failure', subject: 'a', operation: '7' }),
    });
    await mf.dispatchFetch('http://localhost/__alarm');
    assert.equal((await (await mf.dispatchFetch('http://localhost/snapshot')).json()).incidents.length, 1);
    await mf.dispatchFetch('http://localhost/__alarm');
    const recovered = await (await mf.dispatchFetch('http://localhost/snapshot')).json();
    assert.equal(recovered.incidents.length, 0);
    assert.equal(recovered.revision, 2);
    const sendGame = (result, subject, operation) => mf.dispatchFetch('http://localhost/evidence', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ feature: 'add_games', source: 'other', result, subject, operation }),
    });
    for (const [subject, operation] of [['x','a'], ['x','a'], ['y','b']]) await sendGame('failure', subject, operation);
    assert.equal((await (await mf.dispatchFetch('http://localhost/snapshot')).json()).incidents.length, 0);
    await sendGame('failure', 'z', 'c');
    let games = await (await mf.dispatchFetch('http://localhost/snapshot')).json();
    assert.equal(games.incidents[0].messageKey, 'add_games_limited');
    assert.equal('affectedSubjects' in games.incidents[0], false);
    await sendGame('success', 'x', 'd');
    assert.equal((await (await mf.dispatchFetch('http://localhost/snapshot')).json()).incidents.length, 1);
    await sendGame('success', 'other', 'e');
    games = await (await mf.dispatchFetch('http://localhost/snapshot')).json();
    assert.equal(games.incidents.length, 1);
    await sendGame('success', 'x', 'f');
    await sendGame('success', 'x', 'g');
    assert.equal((await (await mf.dispatchFetch('http://localhost/snapshot')).json()).incidents.length, 1);
    await sendGame('success', 'y', 'h');
    games = await (await mf.dispatchFetch('http://localhost/snapshot')).json();
    assert.equal(games.incidents.length, 0);
    const now = Date.now();
    await mf.dispatchFetch('http://localhost/__seed', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        revision: 2, failures: {}, recovery: {}, history: [], incidents: [
          { id: 'ryuu', feature: 'corrections', impact: 'limited', messageKey: 'corrections_limited', source: 'ryuu', startedAt: new Date(now - 1000000).toISOString(), lastEvidenceAt: now - 1000000 },
          { id: 'r2', feature: 'add_games', impact: 'limited', messageKey: 'add_games_limited', source: 'r2', startedAt: new Date(now).toISOString(), lastEvidenceAt: now },
        ],
      }),
    });
    await mf.dispatchFetch('http://localhost/__alarm');
    const unknown = await (await mf.dispatchFetch('http://localhost/admin')).json();
    assert.deepEqual(unknown.incidents.map(item => item.id), ['r2']);
    assert.equal(unknown.history.at(-1).action, 'expired_unknown');
    socket.close(1000, 'done');
    await mf.dispose();
    mf = new Miniflare(options);
    const restored = await (await mf.dispatchFetch('http://localhost/admin')).json();
    assert.equal(restored.revision, unknown.revision);
    assert.deepEqual(restored.incidents, unknown.incidents);
    assert.equal(restored.history.at(-1).action, 'expired_unknown');
    await mf.dispose();
    mf = new Miniflare({ ...options, durableObjectsPersist: mkdtempSync(join(tmpdir(), 'merlin-status-no-probes-')), bindings: { STATUS_V1: '1', STATUS_PROBES_ENABLED: '0' } });
    for (const [result, subject, operation] of [['failure','a','1'], ['failure','b','2'], ['failure','c','3'], ['success','d','4']]) {
      await mf.dispatchFetch('http://localhost/evidence', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ feature: 'add_games', source: 'other', result, subject, operation }) });
    }
    assert.equal((await (await mf.dispatchFetch('http://localhost/snapshot')).json()).incidents.length, 1);
    await mf.dispatchFetch('http://localhost/__alarm');
    assert.equal((await (await mf.dispatchFetch('http://localhost/__checks')).json()).checks, 0);
    const catalogEvent = (available, itemCount, remoteCount, overrideCount) => mf.dispatchFetch('http://localhost/corrections-catalog', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ available, itemCount, remoteCount, overrideCount }),
    });
    const firstCatalogFailure = await (await catalogEvent(false, 3, 0, 3)).json();
    assert.equal(firstCatalogFailure.probeHealth, true);
    assert.equal((await (await mf.dispatchFetch('http://localhost/snapshot')).json()).incidents.length, 1); // Add games only.
    await mf.dispatchFetch('http://localhost/corrections-catalog-health', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result: 'timeout', observedAt: firstCatalogFailure.observedAt }),
    });
    const catalogAdmin = await (await mf.dispatchFetch('http://localhost/admin')).json();
    assert.equal(catalogAdmin.incidents.find(item => item.messageKey === 'corrections_catalog_limited')?.feature, 'corrections');
    assert.equal(catalogAdmin.incidents.length, 2);
    assert.equal(catalogAdmin.catalog.latest.remoteCount, 0);
    assert.equal(catalogAdmin.catalog.latest.overrideCount, 3);
    assert.equal(catalogAdmin.catalog.lastHealth.result, 'timeout');
    const secondCatalogFailure = await (await catalogEvent(false, 3, 0, 3)).json();
    assert.equal(secondCatalogFailure.probeHealth, false);
    await catalogEvent(true, 12, 10, 2);
    await catalogEvent(true, 12, 10, 2);
    assert.equal((await (await mf.dispatchFetch('http://localhost/snapshot')).json()).incidents.some(item => item.feature === 'corrections'), false);
    await mf.dispatchFetch('http://localhost/corrections-catalog-health', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result: 'timeout', observedAt: firstCatalogFailure.observedAt }),
    });
    assert.equal((await (await mf.dispatchFetch('http://localhost/snapshot')).json()).incidents.some(item => item.feature === 'corrections'), false);
    // Reset the previous outage before exercising a fresh ten-failure streak.
    for (const enabled of [false, true]) await mf.dispatchFetch('http://localhost/corrections-source', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }),
    });
    const countedFirst = await (await catalogEvent(false, 3, 0, 3)).json();
    assert.equal(countedFirst.probeHealth, true);
    await mf.dispatchFetch('http://localhost/corrections-catalog-health', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result: 'negative', observedAt: countedFirst.observedAt }),
    });
    for (let i = 1; i < 10; i++) await catalogEvent(false, 3, 0, 3);
    const paused = await (await mf.dispatchFetch('http://localhost/corrections-source')).json();
    assert.equal(paused.enabled, false);
    assert.equal(paused.confirmedFailures, 10);
    assert.equal(paused.pausedBy, 'automatic');
    assert.equal((await (await mf.dispatchFetch('http://localhost/snapshot')).json()).incidents.some(item => item.feature === 'corrections'), false);
    await mf.dispatchFetch('http://localhost/corrections-catalog', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ available: false, itemCount: 3, remoteCount: 0, overrideCount: 3, skipped: true }),
    });
    assert.equal((await (await mf.dispatchFetch('http://localhost/corrections-source')).json()).confirmedFailures, 10);
    await mf.dispatchFetch('http://localhost/corrections-source', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }),
    });
    const resumed = await (await mf.dispatchFetch('http://localhost/corrections-source')).json();
    assert.equal(resumed.enabled, true);
    assert.equal(resumed.confirmedFailures, 0);
    const activationTimeout = await (await mf.dispatchFetch('http://localhost/ryuu-manifest-timeout', { method: 'POST' })).json();
    assert.equal(activationTimeout.probeHealth, true);
    assert.equal((await (await mf.dispatchFetch('http://localhost/corrections-source')).json()).confirmedFailures, 0);
    await mf.dispatchFetch('http://localhost/corrections-catalog-health', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result: 'timeout', observedAt: activationTimeout.observedAt }),
    });
    for (let i = 0; i < 4; i++) await mf.dispatchFetch('http://localhost/ryuu-manifest-timeout', { method: 'POST' });
    await catalogEvent(true, 12, 10, 2);
    assert.equal((await (await mf.dispatchFetch('http://localhost/corrections-source')).json()).confirmedFailures, 5);
    for (let i = 0; i < 4; i++) await mf.dispatchFetch('http://localhost/ryuu-manifest-timeout', { method: 'POST' });
    assert.equal((await (await mf.dispatchFetch('http://localhost/corrections-source')).json()).confirmedFailures, 9);
    await catalogEvent(false, 3, 0, 3);
    const mixedPaused = await (await mf.dispatchFetch('http://localhost/corrections-source')).json();
    assert.equal(mixedPaused.enabled, false);
    assert.equal(mixedPaused.confirmedFailures, 10);
    assert.equal((await (await mf.dispatchFetch('http://localhost/snapshot')).json()).incidents.some(item => item.feature === 'corrections'), false);
    await mf.dispatchFetch('http://localhost/corrections-source', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }),
    });
    const healthyProbe = await (await mf.dispatchFetch('http://localhost/ryuu-manifest-timeout', { method: 'POST' })).json();
    await mf.dispatchFetch('http://localhost/corrections-catalog-health', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result: 'healthy', observedAt: healthyProbe.observedAt }),
    });
    assert.equal((await (await mf.dispatchFetch('http://localhost/corrections-source')).json()).confirmedFailures, 0);
    await mf.dispatchFetch('http://localhost/__seed', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revision: 0, incidents: [], failures: {}, recovery: {}, history: [], catalog: {
        baselineCount: 12, baselineRemoteCount: 10, baselineAt: Date.now(), failures: [], recovery: 0,
        confirmedFailures: 6, pendingConfirmation: 0, healthProbeAt: 123,
      } }),
    });
    await mf.dispatchFetch('http://localhost/corrections-catalog-health', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result: 'healthy', observedAt: 123 }),
    });
    assert.equal((await (await mf.dispatchFetch('http://localhost/corrections-source')).json()).confirmedFailures, 6);
    await catalogEvent(true, 12, 10, 2);
    await mf.dispatchFetch('http://localhost/ryuu-manifest-success', { method: 'POST' });
    assert.equal((await (await mf.dispatchFetch('http://localhost/admin')).json()).catalog.counterRecovery, 2);
    await mf.dispatchFetch('http://localhost/ryuu-manifest-timeout', { method: 'POST' });
    assert.equal((await (await mf.dispatchFetch('http://localhost/admin')).json()).catalog.counterRecovery, 0);
    for (let i = 0; i < 3; i++) await catalogEvent(true, 12, 10, 2);
    assert.equal((await (await mf.dispatchFetch('http://localhost/corrections-source')).json()).confirmedFailures, 6);
    assert.equal((await (await mf.dispatchFetch('http://localhost/admin')).json()).catalog.counterRecovery, 3);
    await mf.dispatchFetch('http://localhost/ryuu-manifest-success', { method: 'POST' });
    assert.equal((await (await mf.dispatchFetch('http://localhost/corrections-source')).json()).confirmedFailures, 0);
    assert.equal((await (await mf.dispatchFetch('http://localhost/admin')).json()).catalog.counterRecovery, 0);
  } finally { await mf.dispose(); }
});
