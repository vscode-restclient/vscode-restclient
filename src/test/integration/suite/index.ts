import * as path from 'path';
import Mocha from 'mocha';
import { globSync } from 'glob';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', timeout: 30000 });
  const root = path.resolve(__dirname);
  // HK_SOLO=send runs only that suite: to isolate a failure without waiting for all of them.
  const only = process.env.HK_SOLO;
  const files = globSync('**/*.test.js', { cwd: root }).sort().filter((f) => !only || f.includes(only));
  // A filter that matches nothing must not come back green with zero tests run.
  if (files.length === 0) {
    return Promise.reject(new Error(only ? `HK_SOLO=${only} matches no test file.` : 'No test files found.'));
  }
  for (const f of files) {
    mocha.addFile(path.resolve(root, f));
  }
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures > 0 ? reject(new Error(`${failures} tests failed.`)) : resolve()));
  });
}
