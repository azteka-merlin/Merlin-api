import { DurableObject } from 'cloudflare:workers';

export type StatusFeature = 'corrections' | 'add_games';
export type StatusSource = 'ryuu' | 'ryuu_catalog' | 'hubcap' | 'depotbox' | 'r2' | 'other';
export type StatusIncident = { id: string; feature: StatusFeature; impact: 'limited'; messageKey: 'corrections_limited' | 'corrections_catalog_limited' | 'add_games_limited'; startedAt: string; lastEvidenceAt: number; source: StatusSource; affectedSubjects?: string[]; recoveredSubjects?: string[] };
type Observation = { at: number; subject: string; operation: string; trusted?: boolean };
type Diagnostic = { source: string; result: string; checkedAt: string; responseMs: number; lastValidAt?: string };
type CatalogState = { baselineCount: number; baselineRemoteCount?: number; baselineAt: number; failures: number[]; recovery: number; counterRecovery?: number; healthProbeAt?: number; lastHealth?: { result: string; at: number }; latest?: { available: boolean; itemCount: number; remoteCount: number; overrideCount: number; at: number; skipped?: boolean }; confirmedFailures?: number; pendingConfirmation?: number; paused?: boolean; pausedAt?: number; pausedBy?: 'automatic' | 'admin' };
type Stored = { revision: number; incidents: StatusIncident[]; failures: Record<string, Observation[]>; recovery: Record<string, number>; history: Array<{ revision: number; feature: StatusFeature; action: string; at: string }>; catalog?: CatalogState };
const correctionIncidentStillRelevantWithOverrides = (item: StatusIncident) => item.feature !== 'corrections' || item.source !== 'ryuu' && item.source !== 'ryuu_catalog';
function recordRyuuSuccess(catalog: CatalogState) {
  if (catalog.paused || !(catalog.confirmedFailures || catalog.pendingConfirmation)) return false;
  catalog.counterRecovery = (catalog.counterRecovery || 0) + 1;
  if (catalog.counterRecovery < 4) return false;
  catalog.confirmedFailures = 0; catalog.pendingConfirmation = 0; catalog.counterRecovery = 0;
  catalog.healthProbeAt = undefined; catalog.lastHealth = undefined; catalog.failures = [];
  return true;
}
type MonitorEnv = { STATUS_V1?: string; STATUS_HEALTH_TIMEOUT_MS?: string; STATUS_HEALTH_INTERVAL_MS?: string; STATUS_PROBES_ENABLED?: string };
const INITIAL: Stored = { revision: 0, incidents: [], failures: {}, recovery: {}, history: [] };
import { CHECKS, checkSource } from './service-status-health';
function seconds(value: string | undefined, fallback: number, min: number, max: number) {
  const n = Number(value); return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}
export class MerlinStatus extends DurableObject<MonitorEnv> {
  private diagnostics: Record<string, Diagnostic> = {};
  private async getDiagnostics() {
    if (!Object.keys(this.diagnostics).length) this.diagnostics = await this.ctx.storage.get<Record<string, Diagnostic>>('diagnostics') || {};
    return this.diagnostics;
  }
  private async load(): Promise<Stored> {
    const state = await this.ctx.storage.get<Stored>('state') || structuredClone(INITIAL);
    if (state.catalog?.paused) {
      const remaining = state.incidents.filter(correctionIncidentStillRelevantWithOverrides);
      if (remaining.length !== state.incidents.length) {
        state.incidents = remaining;
        state.revision++;
        state.history.push({ revision: state.revision, feature: 'corrections', action: 'mitigated_by_overrides', at: new Date().toISOString() });
        state.history = state.history.slice(-100);
        await this.ctx.storage.put('state', state);
        this.broadcast(state);
      }
    }
    return state;
  }
  private publicSnapshot(state: Stored) {
    const incidents = state.catalog?.paused ? state.incidents.filter(correctionIncidentStillRelevantWithOverrides) : state.incidents;
    return { schemaVersion: 1, revision: state.revision, incidents: incidents.map(({ source: _source, lastEvidenceAt: _lastEvidenceAt, affectedSubjects: _affected, recoveredSubjects: _recovered, ...item }) => item), correctionsSource: { ryuuEnabled: !state.catalog?.paused } };
  }
  private broadcast(state: Stored) {
    const payload = JSON.stringify(this.publicSnapshot(state));
    for (const socket of this.ctx.getWebSockets()) { try { socket.send(payload); } catch { /* disconnected client reconciles on reconnect */ } }
  }
  private async schedule(force = false) {
    if (this.env.STATUS_PROBES_ENABLED !== '1' && !force) return;
    if (await this.ctx.storage.getAlarm() === null) {
      await this.ctx.storage.setAlarm(Date.now() + seconds(this.env.STATUS_HEALTH_INTERVAL_MS, 120000, 60000, 3600000));
    }
  }
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Upgrade required', { status: 426 });
      await this.schedule();
      const pair = new WebSocketPair(); this.ctx.acceptWebSocket(pair[1]);
      pair[1].send(JSON.stringify(this.publicSnapshot(await this.load())));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === '/snapshot') { await this.schedule(); return Response.json(this.publicSnapshot(await this.load()), { headers: { 'Cache-Control': 'no-store' } }); }
    if (url.pathname === '/admin') {
      const state = await this.load();
      const suspiciousGames = new Set((state.failures['add_games:other'] || []).filter(item => Date.now() - item.at < 45000).map(item => item.subject)).size;
      const suspiciousCorrections = new Set((state.failures['corrections:ryuu'] || []).filter(item => Date.now() - item.at < 45000).map(item => item.subject)).size;
      return Response.json({ ...this.publicSnapshot(state), diagnostics: await this.getDiagnostics(), suspiciousGames, suspiciousCorrections, catalogSuspicions: (state.catalog?.failures || []).filter(at => Date.now() - at < 45000).length, catalog: state.catalog ? { latest: state.catalog.latest || null, baselineRemoteCount: state.catalog.baselineRemoteCount || 0, lastHealth: state.catalog.lastHealth || null, confirmedFailures: state.catalog.confirmedFailures || 0, counterRecovery: state.catalog.counterRecovery || 0, threshold: 10, pausedAt: state.catalog.pausedAt || null, pausedBy: state.catalog.pausedBy || null } : null, history: state.history.slice(-100) });
    }
    if (url.pathname === '/corrections-source' && request.method === 'GET') {
      const catalog = (await this.load()).catalog;
      return Response.json({ enabled: !catalog?.paused, confirmedFailures: catalog?.confirmedFailures || 0, threshold: 10, pausedAt: catalog?.pausedAt || null, pausedBy: catalog?.pausedBy || null, lastHealth: catalog?.lastHealth || null });
    }
    if (url.pathname === '/corrections-source' && request.method === 'POST') {
      const event = await request.json() as { enabled?: unknown };
      if (typeof event.enabled !== 'boolean') return new Response('invalid', { status: 400 });
      return this.ctx.blockConcurrencyWhile(async () => {
        const state = await this.load(), now = Date.now();
        const catalog = state.catalog || { baselineCount: 0, baselineAt: 0, failures: [], recovery: 0 };
        const enabled = !catalog.paused;
        if (enabled !== event.enabled) {
          catalog.paused = !event.enabled;
          catalog.pausedAt = event.enabled ? undefined : now;
          catalog.pausedBy = event.enabled ? undefined : 'admin';
          catalog.confirmedFailures = 0; catalog.pendingConfirmation = 0; catalog.counterRecovery = 0; catalog.healthProbeAt = undefined; catalog.lastHealth = undefined;
          catalog.failures = [];
          state.catalog = catalog;
          state.revision++;
          state.history.push({ revision: state.revision, feature: 'corrections', action: event.enabled ? 'ryuu_reenabled_admin' : 'ryuu_paused_admin', at: new Date(now).toISOString() });
          if (!event.enabled) {
            const remaining = state.incidents.filter(correctionIncidentStillRelevantWithOverrides);
            if (remaining.length !== state.incidents.length) {
              state.incidents = remaining;
              state.revision++;
              state.history.push({ revision: state.revision, feature: 'corrections', action: 'mitigated_by_overrides', at: new Date(now).toISOString() });
            }
          }
          state.history = state.history.slice(-100);
          await this.ctx.storage.put('state', state);
          this.broadcast(state);
        }
        return Response.json({ enabled: !catalog.paused, confirmedFailures: catalog.confirmedFailures || 0, threshold: 10, pausedAt: catalog.pausedAt || null, pausedBy: catalog.pausedBy || null, lastHealth: catalog.lastHealth || null });
      });
    }
    if (url.pathname === '/corrections-catalog' && request.method === 'POST') {
      if (this.env.STATUS_V1 !== '1') return Response.json({ ok: true });
      const event = await request.json() as { available?: unknown; itemCount?: unknown; remoteCount?: unknown; overrideCount?: unknown; skipped?: unknown };
      if (typeof event.available !== 'boolean' || (event.skipped !== undefined && typeof event.skipped !== 'boolean') || ![event.itemCount, event.remoteCount, event.overrideCount].every(value => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1000000)) return new Response('invalid', { status: 400 });
      return this.ctx.blockConcurrencyWhile(async () => {
        const state = await this.load(), now = Date.now(), count = event.itemCount as number;
        const remoteCount = event.remoteCount as number, overrideCount = event.overrideCount as number;
        const catalog = state.catalog || { baselineCount: 0, baselineAt: 0, failures: [], recovery: 0 };
        const skipped = event.skipped === true || catalog.paused === true;
        const incident = state.incidents.find(item => item.feature === 'corrections' && item.source === 'ryuu_catalog');
        let dirty = false, changed = false;
        const catalogAvailable = event.available === true && (remoteCount > 0 || !catalog.baselineRemoteCount || now - catalog.baselineAt >= 3600000);
        if (skipped) {
          if (incident && now - incident.lastEvidenceAt >= 300000) { incident.lastEvidenceAt = now; dirty = true; }
          if (!catalog.latest || now - catalog.latest.at >= 300000 || !catalog.latest.skipped) dirty = true;
        } else if (catalogAvailable) {
          if (remoteCount > 0 && (catalog.confirmedFailures || catalog.pendingConfirmation)) {
            const recovered = recordRyuuSuccess(catalog); dirty = true;
            if (recovered) {
              state.revision++; state.history.push({ revision: state.revision, feature: 'corrections', action: 'ryuu_failure_counter_recovered', at: new Date(now).toISOString() }); changed = true;
            }
          }
          if (catalog.failures.length) { catalog.failures = []; dirty = true; }
          if (incident) {
            const restored = remoteCount > 0;
            catalog.recovery = restored ? catalog.recovery + 1 : 0; dirty = true;
            if (catalog.recovery >= 2) {
              state.incidents = state.incidents.filter(item => item !== incident);
              state.revision++; state.history.push({ revision: state.revision, feature: 'corrections', action: 'recovered_observed', at: new Date(now).toISOString() });
              catalog.recovery = 0; changed = true;
            }
          }
          if (!incident && remoteCount > 0 && (catalog.baselineCount !== count || catalog.baselineRemoteCount !== remoteCount || now - catalog.baselineAt >= 300000)) {
            catalog.baselineCount = count; catalog.baselineRemoteCount = remoteCount; catalog.baselineAt = now; dirty = true;
          }
        } else {
          catalog.counterRecovery = 0;
          if (!event.available) {
            const healthIsRecent = catalog.lastHealth && now - catalog.lastHealth.at < 30000;
            const healthIsOff = healthIsRecent && ['negative', 'timeout', 'http_error', 'network_error'].includes(catalog.lastHealth!.result);
            if (healthIsOff) catalog.confirmedFailures = (catalog.confirmedFailures || 0) + 1;
            else if (!healthIsRecent) catalog.pendingConfirmation = (catalog.pendingConfirmation || 0) + 1;
            else catalog.pendingConfirmation = 0;
          }
          catalog.failures = catalog.failures.filter(at => now - at < 45000);
          catalog.failures.push(now); catalog.failures = catalog.failures.slice(-10); catalog.recovery = 0; dirty = true;
          if (incident) incident.lastEvidenceAt = now;
          const baselineIsFresh = catalog.baselineCount > 0 && now - catalog.baselineAt < 3600000;
          const limitedOrUnknown = !baselineIsFresh || count < catalog.baselineCount || remoteCount === 0 && (catalog.baselineRemoteCount || 0) > 0;
          if (!incident && !state.incidents.some(item => item.feature === 'corrections') && catalog.failures.length >= 2 && count > 0 && limitedOrUnknown) {
            state.incidents.push({ id: crypto.randomUUID(), feature: 'corrections', impact: 'limited', messageKey: 'corrections_catalog_limited', startedAt: new Date(now).toISOString(), lastEvidenceAt: now, source: 'ryuu_catalog' });
            state.revision++; state.history.push({ revision: state.revision, feature: 'corrections', action: 'opened', at: new Date(now).toISOString() }); changed = true;
          }
          await this.schedule(true);
        }
        if (!skipped && (catalog.confirmedFailures || 0) >= 10 && !catalog.paused) {
          catalog.paused = true; catalog.pausedAt = now; catalog.pausedBy = 'automatic';
          state.revision++; state.history.push({ revision: state.revision, feature: 'corrections', action: 'ryuu_paused_automatic', at: new Date(now).toISOString() });
          const remaining = state.incidents.filter(correctionIncidentStillRelevantWithOverrides);
          if (remaining.length !== state.incidents.length) {
            state.incidents = remaining;
            state.revision++;
            state.history.push({ revision: state.revision, feature: 'corrections', action: 'mitigated_by_overrides', at: new Date(now).toISOString() });
          }
          changed = true; dirty = true;
        }
        const probeHealth = (skipped || !event.available) && (!catalog.healthProbeAt || now - catalog.healthProbeAt >= 30000);
        if (probeHealth) { catalog.healthProbeAt = now; dirty = true; }
        if (dirty) {
          catalog.latest = { available: catalogAvailable, itemCount: count, remoteCount, overrideCount, at: now, skipped };
          state.catalog = catalog; state.history = state.history.slice(-100); await this.ctx.storage.put('state', state);
        }
        if (changed) this.broadcast(state);
        return Response.json({ ok: true, probeHealth, observedAt: now });
      });
    }
    if (url.pathname === '/ryuu-manifest-success' && request.method === 'POST') {
      if (this.env.STATUS_V1 !== '1') return Response.json({ ok: true });
      return this.ctx.blockConcurrencyWhile(async () => {
        const state = await this.load(), catalog = state.catalog;
        if (!catalog || catalog.paused || !(catalog.confirmedFailures || catalog.pendingConfirmation)) return Response.json({ ok: true });
        const recovered = recordRyuuSuccess(catalog);
        if (recovered) {
          state.revision++; state.history.push({ revision: state.revision, feature: 'corrections', action: 'ryuu_failure_counter_recovered', at: new Date().toISOString() });
          state.history = state.history.slice(-100);
        }
        await this.ctx.storage.put('state', state);
        if (recovered) this.broadcast(state);
        return Response.json({ ok: true });
      });
    }
    if (url.pathname === '/ryuu-manifest-timeout' && request.method === 'POST') {
      if (this.env.STATUS_V1 !== '1') return Response.json({ ok: true });
      return this.ctx.blockConcurrencyWhile(async () => {
        const state = await this.load(), now = Date.now();
        const catalog = state.catalog || { baselineCount: 0, baselineAt: 0, failures: [], recovery: 0 };
        if (catalog.paused) return Response.json({ ok: true, probeHealth: false });
        catalog.counterRecovery = 0;
        const healthIsRecent = catalog.lastHealth && now - catalog.lastHealth.at < 30000;
        const healthIsOff = healthIsRecent && ['negative', 'timeout', 'http_error', 'network_error'].includes(catalog.lastHealth!.result);
        if (healthIsOff) catalog.confirmedFailures = (catalog.confirmedFailures || 0) + 1;
        else if (!healthIsRecent) catalog.pendingConfirmation = (catalog.pendingConfirmation || 0) + 1;
        else catalog.pendingConfirmation = 0;
        const probeHealth = !catalog.healthProbeAt || now - catalog.healthProbeAt >= 30000;
        if (probeHealth) catalog.healthProbeAt = now;
        let changed = false;
        if ((catalog.confirmedFailures || 0) >= 10) {
          catalog.paused = true; catalog.pausedAt = now; catalog.pausedBy = 'automatic';
          state.revision++; state.history.push({ revision: state.revision, feature: 'corrections', action: 'ryuu_paused_automatic', at: new Date(now).toISOString() });
          const remaining = state.incidents.filter(correctionIncidentStillRelevantWithOverrides);
          if (remaining.length !== state.incidents.length) {
            state.incidents = remaining;
            state.revision++;
            state.history.push({ revision: state.revision, feature: 'corrections', action: 'mitigated_by_overrides', at: new Date(now).toISOString() });
          }
          changed = true;
        }
        state.catalog = catalog; state.history = state.history.slice(-100);
        await this.ctx.storage.put('state', state);
        if (changed) this.broadcast(state);
        return Response.json({ ok: true, probeHealth: probeHealth && !catalog.paused, observedAt: now });
      });
    }
    if (url.pathname === '/corrections-catalog-health' && request.method === 'POST') {
      if (this.env.STATUS_V1 !== '1') return Response.json({ ok: true });
      const event = await request.json() as { result?: unknown; observedAt?: unknown };
      if (typeof event.result !== 'string' || !Number.isSafeInteger(event.observedAt)) return new Response('invalid', { status: 400 });
      return this.ctx.blockConcurrencyWhile(async () => {
        const state = await this.load(), catalog = state.catalog;
        if (!catalog || catalog.healthProbeAt !== event.observedAt) return Response.json({ ok: true });
        catalog.lastHealth = { result: event.result as string, at: Date.now() };
        const unhealthy = ['negative', 'timeout', 'http_error', 'network_error'].includes(event.result as string);
        if (!catalog.paused) {
          if (unhealthy && catalog.pendingConfirmation) catalog.confirmedFailures = (catalog.confirmedFailures || 0) + catalog.pendingConfirmation;
          catalog.pendingConfirmation = 0;
        }
        let changed = false;
        if (!catalog.paused && (catalog.confirmedFailures || 0) >= 10) {
          const now = Date.now();
          catalog.paused = true; catalog.pausedAt = now; catalog.pausedBy = 'automatic';
          state.revision++; state.history.push({ revision: state.revision, feature: 'corrections', action: 'ryuu_paused_automatic', at: new Date(now).toISOString() });
          const remaining = state.incidents.filter(correctionIncidentStillRelevantWithOverrides);
          if (remaining.length !== state.incidents.length) {
            state.incidents = remaining;
            state.revision++;
            state.history.push({ revision: state.revision, feature: 'corrections', action: 'mitigated_by_overrides', at: new Date(now).toISOString() });
          }
          changed = true;
        }
        if (unhealthy && !catalog.paused && !catalog.latest?.skipped && catalog.latest && !catalog.latest.available && catalog.latest.itemCount > 0 && !state.incidents.some(item => item.feature === 'corrections')) {
          const now = Date.now();
          state.incidents.push({ id: crypto.randomUUID(), feature: 'corrections', impact: 'limited', messageKey: 'corrections_catalog_limited', startedAt: new Date(now).toISOString(), lastEvidenceAt: now, source: 'ryuu_catalog' });
          state.revision++; state.history.push({ revision: state.revision, feature: 'corrections', action: 'opened', at: new Date(now).toISOString() });
          state.history = state.history.slice(-100);
          changed = true;
        }
        state.history = state.history.slice(-100);
        await this.ctx.storage.put('state', state);
        if (changed) this.broadcast(state);
        return Response.json({ ok: true });
      });
    }
    if (url.pathname === '/evidence' && request.method === 'POST') {
      if (this.env.STATUS_V1 !== '1') return Response.json({ ok: true });
      const evidence = await request.json() as { feature?: string; source?: string; result?: string; subject?: string; operation?: string; trusted?: boolean };
      if (!['corrections','add_games'].includes(String(evidence.feature)) || !['ryuu','hubcap','depotbox','r2','other'].includes(String(evidence.source)) || !['failure','success'].includes(String(evidence.result))) return new Response('invalid', { status: 400 });
      if (typeof evidence.subject !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(evidence.subject) || typeof evidence.operation !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(evidence.operation)) return new Response('invalid', { status: 400 });
      return this.ctx.blockConcurrencyWhile(async () => {
      const feature = evidence.feature as StatusFeature, source = evidence.source as StatusSource;
      const state = await this.load(); const now = Date.now(); const key = `${feature}:${source}`;
      await this.schedule(true);
      state.failures[key] = (state.failures[key] || []).filter(item => now - item.at < 45000);
      let changed = false;
      if (evidence.result === 'failure') {
        if (state.failures[key].some(item => item.operation === evidence.operation)) return Response.json({ ok: true });
        state.failures[key].push({ at: now, subject: evidence.subject!, operation: evidence.operation!, trusted: evidence.trusted !== false });
        state.failures[key] = state.failures[key].slice(-100);
        if (evidence.trusted !== false) state.recovery[source] = 0;
        for (const incident of state.incidents) if (evidence.trusted !== false && incident.feature === feature && incident.source === source) {
          incident.lastEvidenceAt = now;
          if (feature === 'add_games') incident.recoveredSubjects = [];
        }
        if (feature === 'add_games' && source === 'other' && !state.incidents.some(item => item.feature === 'add_games')) {
          const affected = [...new Set(state.failures[key].map(item => item.subject))];
          if (affected.length >= 3) {
            state.incidents.push({ id: crypto.randomUUID(), feature, impact: 'limited', messageKey: 'add_games_limited', startedAt: new Date(now).toISOString(), lastEvidenceAt: now, source, affectedSubjects: affected.slice(0, 20), recoveredSubjects: [] });
            state.revision++; state.history.push({ revision: state.revision, feature, action: 'opened', at: new Date(now).toISOString() }); changed = true;
          }
        }
        // A single correction file is not proof of a global incident. Only a
        // corroborated Ryuu service signal can qualify this limited V1 state.
        const diag = (await this.getDiagnostics()).ryuu;
        const fresh = diag && now - Date.parse(diag.checkedAt) < 300000;
        if (feature === 'corrections' && source === 'ryuu' && !state.catalog?.paused && new Set(state.failures[key].filter(item => item.trusted).map(item => item.subject)).size >= 3 && fresh && ['negative','timeout','http_error','network_error'].includes(diag.result) && !state.incidents.some(x => x.feature === feature)) {
          state.incidents.push({ id: crypto.randomUUID(), feature, impact: 'limited', messageKey: 'corrections_limited', startedAt: new Date(now).toISOString(), lastEvidenceAt: now, source });
          state.revision++; state.history.push({ revision: state.revision, feature, action: 'opened', at: new Date(now).toISOString() }); changed = true;
        }
      } else if (feature === 'add_games' && source === 'other') {
        const incident = state.incidents.find(item => item.feature === 'add_games' && item.source === 'other');
        if (incident && incident.affectedSubjects?.includes(evidence.subject!)) {
          incident.recoveredSubjects ||= [];
          if (incident.recoveredSubjects.includes(evidence.subject!)) return Response.json({ ok: true });
          incident.recoveredSubjects.push(evidence.subject!);
          if (incident.recoveredSubjects.length >= 2) {
            state.incidents = state.incidents.filter(item => item !== incident);
            state.revision++; state.history.push({ revision: state.revision, feature, action: 'recovered_observed', at: new Date(now).toISOString() }); changed = true;
          }
        } else return Response.json({ ok: true });
      } else { return Response.json({ ok: true }); }
      state.history = state.history.slice(-100); await this.ctx.storage.put('state', state);
      if (changed) this.broadcast(state);
      return Response.json({ ok: true });
      });
    }
    return new Response('Not found', { status: 404 });
  }
  async alarm() {
    if (this.env.STATUS_V1 !== '1') return;
    const timeout = seconds(this.env.STATUS_HEALTH_TIMEOUT_MS, 10000, 100, 10000);
    const results = this.env.STATUS_PROBES_ENABLED === '1' ? await Promise.all(CHECKS.map(item => checkSource(item, timeout))) : [];
    let pending = false;
    await this.ctx.blockConcurrencyWhile(async () => {
    const previous = await this.getDiagnostics();
    const persist = results.some(result => previous[result.source]?.result !== result.result || Date.now() - Date.parse(previous[result.source]?.checkedAt || '') > 600000);
    for (const result of results) this.diagnostics[result.source] = {
      ...result,
      lastValidAt: ['healthy', 'negative', 'unknown'].includes(result.result) ? result.checkedAt : previous[result.source]?.lastValidAt,
    };
    if (persist) await this.ctx.storage.put('diagnostics', this.diagnostics);
    const state = await this.load(); const ryuu = results.find(x => x.source === 'ryuu');
    let pruned = false;
    for (const [key, observations] of Object.entries(state.failures)) {
      const recent = observations.filter(item => Date.now() - item.at < 45000);
      if (recent.length !== observations.length) pruned = true;
      if (recent.length) state.failures[key] = recent; else delete state.failures[key];
    }
    if (state.catalog?.failures.length) {
      const recent = state.catalog.failures.filter(at => Date.now() - at < 45000);
      if (recent.length !== state.catalog.failures.length) { state.catalog.failures = recent; pruned = true; }
    }
    const hasRyuuIncident = state.incidents.some(x => x.source === 'ryuu');
    if (hasRyuuIncident) {
      state.recovery.ryuu = ryuu?.result === 'healthy' ? (state.recovery.ryuu || 0) + 1 : 0;
      if (state.recovery.ryuu >= 2) {
        const removed = state.incidents.filter(x => x.source === 'ryuu');
        state.incidents = state.incidents.filter(x => x.source !== 'ryuu');
        for (const incident of removed) { state.revision++; state.history.push({ revision: state.revision, feature: incident.feature, action: 'recovered_probable', at: new Date().toISOString() }); }
        state.recovery.ryuu = 0; state.history = state.history.slice(-100); await this.ctx.storage.put('state', state); this.broadcast(state);
      } else {
        // Lack of recent real failures is not proof of recovery. Expire only to
        // an explicit unknown state, so the public badge is not permanent.
        const expired = state.incidents.filter(x => x.source === 'ryuu' && Date.now() - x.lastEvidenceAt >= 900000);
        if (expired.length) {
          state.incidents = state.incidents.filter(x => !expired.includes(x));
          for (const incident of expired) { state.revision++; state.history.push({ revision: state.revision, feature: incident.feature, action: 'expired_unknown', at: new Date().toISOString() }); }
          state.history = state.history.slice(-100);
        }
        await this.ctx.storage.put('state', state);
        if (expired.length) this.broadcast(state);
      }
    } else if (pruned) await this.ctx.storage.put('state', state);
    const expiredOther = state.incidents.filter(x => x.source !== 'ryuu' && !(state.catalog?.paused && x.source === 'ryuu_catalog') && Date.now() - x.lastEvidenceAt >= 900000);
    if (expiredOther.length) {
      state.incidents = state.incidents.filter(x => !expiredOther.includes(x));
      for (const incident of expiredOther) { state.revision++; state.history.push({ revision: state.revision, feature: incident.feature, action: 'expired_unknown', at: new Date().toISOString() }); }
      state.history = state.history.slice(-100); await this.ctx.storage.put('state', state); this.broadcast(state);
    }
    pending = state.incidents.some(item => !(state.catalog?.paused && item.source === 'ryuu_catalog')) || Object.values(state.failures).some(items => items.length > 0) || Boolean(state.catalog?.failures.length);
    });
    if (this.env.STATUS_PROBES_ENABLED === '1' || pending) await this.ctx.storage.setAlarm(Date.now() + seconds(this.env.STATUS_HEALTH_INTERVAL_MS, 120000, 60000, 3600000));
  }
  webSocketMessage() { /* public clients are read-only */ }
  webSocketClose(ws: WebSocket, code: number, reason: string) { try { ws.close(code, reason); } catch {} }
}
