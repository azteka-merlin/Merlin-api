import { describe, expect, test } from 'vitest';
import { readOverrides, upsertOverride, deleteOverride } from '../src/lib/overrides';

describe('concurrent override updates', () => {
  test('preserves independent changes when writes start from the same version', async () => {
    let data: string | null = null;
    let version = 0;
    const bucket = {
      async get() {
        const snapshot = data;
        const etag = String(version);
        return snapshot === null ? null : { etag, text: async () => snapshot };
      },
      async put(_key: string, value: string, options: { onlyIf: { etagMatches?: string; etagDoesNotMatch?: string } }) {
        const condition = options.onlyIf;
        if (condition.etagMatches !== undefined && condition.etagMatches !== String(version)) return null;
        if (condition.etagDoesNotMatch === '*' && data !== null) return null;
        data = value;
        version++;
        return { etag: String(version) };
      },
    } as unknown as R2Bucket;
    const env = { MERLIN_FILES: bucket };
    await Promise.all([
      upsertOverride(env, '10', { name: 'Primeiro', hidden: true }),
      upsertOverride(env, '20', { name: 'Segundo', hidden: true }),
    ]);
    expect(Object.keys(await readOverrides(env)).sort()).toEqual(['10', '20']);
    await Promise.all([deleteOverride(env, '10'), upsertOverride(env, '30', { name: 'Terceiro', hidden: true })]);
    expect(Object.keys(await readOverrides(env)).sort()).toEqual(['20', '30']);
  });
});
