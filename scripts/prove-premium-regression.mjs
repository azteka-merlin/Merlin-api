import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

// Validate the test itself: it must pass with the fix and detect each original
// bug independently. Transform only Vitest's in-memory module, never source files.
const root = fileURLToPath(new URL('../', import.meta.url));
const temporaryRoot = join(root, 'tmp');
mkdirSync(temporaryRoot, { recursive: true });
const directory = mkdtempSync(join(temporaryRoot, 'premium-regression-proof-'));
const executable = join(dirname(fileURLToPath(import.meta.resolve('vitest/package.json'))), 'vitest.mjs');
const title = 'completes a normal Premium activation \\(operationId=undefined\\)';
const cases = [
  { name: 'fixed', from: null, to: null, expected: 'passed' },
  {
    name: 'old-reservation-guard',
    from: 'if (Number(insertResult.meta.changes||0)<1)',
    to: 'if (Number(insertResult.meta.changes||0)!==1)',
    expected: 'failed', error: 'A vaga foi ocupada ou já existe uma ativação em andamento.',
  },
  {
    name: 'old-completion-guard',
    from: 'if (Number(completion.meta.changes || 0) < 1)',
    to: 'if (Number(completion.meta.changes || 0) !== 1)',
    expected: 'failed', error: 'Premium activation reservation is not available',
  },
];

try {
  for (const item of cases) {
    const config = join(directory, `${item.name}.config.mjs`);
    const report = join(directory, `${item.name}.report.json`);
    const mutation = item.from ? `plugins: [...(base.plugins || []), {
      name: 'premium-regression-proof', enforce: 'pre',
      transform(code, id) {
        if (!id.replaceAll('\\\\', '/').split('?')[0].endsWith('/src/lib/premium-games.ts')) return;
        const from = ${JSON.stringify(item.from)};
        if (!code.includes(from)) throw new Error('The documented guard changed; update the proof explicitly.');
        return {code: code.replace(from, ${JSON.stringify(item.to)}), map: null};
      }
    }],` : '';
    writeFileSync(config, `import base from ${JSON.stringify(pathToFileURL(join(root, 'vitest.config.mjs')).href)};
      export default {...base, ${mutation} test: {...base.test, include:['src/lib/premium-d1-runtime.test.ts']}};`);
    const result = spawnSync(process.execPath, [executable, 'run', '--config', config,
      '--reporter=json', '--outputFile', report, '-t', title], {
      cwd: root, encoding: 'utf8', timeout: 90000, windowsHide: true,
    });
    if (result.error) throw result.error;
    const data = JSON.parse(readFileSync(report, 'utf8'));
    const assertions = (data.testResults || []).flatMap(file => file.assertionResults || []);
    const selected = assertions.filter(test => test.fullName.includes('operationId=undefined'));
    const expectedExit = item.expected === 'passed' ? 0 : 1;
    if (selected.length !== 1 || selected[0].status !== item.expected || result.status !== expectedExit) {
      throw new Error(`${item.name}: regression proof did not reach the expected activation result.`);
    }
    if (item.error && !selected[0].failureMessages.some(message => message.includes(item.error))) {
      throw new Error(`${item.name}: test failed for a different reason, not the documented false conflict.`);
    }
    console.log(`PASS ${item.name}: ${item.expected === 'passed' ? 'native D1 activation returns 200' : 'the regression test rejects the original false 409'}`);
  }
} finally {
  // directory is created by mkdtemp inside this project's tmp folder.
  rmSync(directory, { recursive: true, force: true });
}
