import type { AppContext } from '../types';

// A coordinator failure must not silently disable an otherwise working source.
export async function ryuuCorrectionsEnabled(c: AppContext): Promise<boolean> {
  if (c.env.STATUS_V1 !== '1' || !c.env.STATUS_COORDINATOR) return true;
  try {
    const namespace = c.env.STATUS_COORDINATOR;
    const response = await namespace.get(namespace.idFromName('global')).fetch('https://status.internal/corrections-source');
    if (!response.ok) return true;
    const state = await response.json() as { enabled?: unknown };
    return state.enabled !== false;
  } catch (error) {
    console.warn('[fixes] Ryuu source control unavailable', error instanceof Error ? error.message : 'unknown');
    return true;
  }
}
