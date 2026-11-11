import { describe, expect, test } from 'vitest';
import { readOverrides, upsertOverride, deleteOverride, getRequiredManifestOverride } from '../src/lib/overrides';

describe('concurrent override updates', () => {
  test('FC 27 mode saved in staging does not change production', async () => {
    const objects = new Map<string, { value: string; version: number }>();
    const bucket = {
      async get(key: string) {
        const object = objects.get(key);
        return object ? {
          etag: String(object.version),
          text: async () => object.value,
          arrayBuffer: async () => Uint8Array.from(Buffer.from(object.value, 'binary')).buffer,
        } : null;
      },
      async put(key: string, value: string, options: { onlyIf: { etagMatches?: string; etagDoesNotMatch?: string } }) {
        const previous = objects.get(key);
        if (options.onlyIf.etagMatches !== undefined && options.onlyIf.etagMatches !== String(previous?.version)) return null;
        if (options.onlyIf.etagDoesNotMatch === '*' && previous) return null;
        const version = (previous?.version || 0) + 1;
        objects.set(key, { value, version });
        return { etag: String(version) };
      },
    } as unknown as R2Bucket;
    const production = { MERLIN_FILES: bucket, ENVIRONMENT: 'production' };
    const staging = { MERLIN_FILES: bucket, ENVIRONMENT: 'staging' };
    const base = {
      name: 'FC 27',
      fixOverride: { enabled: true, file: '4407750/fixes/fc27.zip' },
      manifestOverride: { enabled: true, file: '4407750/manifests/pack.zip' },
    };
    objects.set('4407750/manifests/pack.zip', { value: 'PK\x03\x04manifest', version: 1 });
    await upsertOverride(production, '4407750', base);
    await upsertOverride(staging, '4407750', { ...base, specialCorrectionEnabled: false });
    expect((await readOverrides(staging))['4407750']?.specialCorrectionEnabled).toBe(false);
    expect((await readOverrides(production))['4407750']?.specialCorrectionEnabled).toBeUndefined();
    expect((await getRequiredManifestOverride(staging, '4407750'))?.file).toBe('4407750/manifests/pack.zip');
    await upsertOverride(staging, '4407750', { ...base, specialCorrectionEnabled: true });
    expect((await getRequiredManifestOverride(staging, '4407750'))?.file).toBe('4407750/manifests/pack.zip');
  });
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
