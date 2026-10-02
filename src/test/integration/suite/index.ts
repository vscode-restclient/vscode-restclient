import * as path from 'path';
import Mocha from 'mocha';
import { globSync } from 'glob';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', timeout: 30000 });
  const root = path.resolve(__dirname);
  // HK_SOLO=enviar corre solo esa suite: para aislar un fallo sin esperar a todas.
  const solo = process.env.HK_SOLO;
  for (const f of globSync('**/*.test.js', { cwd: root }).sort()) {
    if (!solo || f.includes(solo)) mocha.addFile(path.resolve(root, f));
  }
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures > 0 ? reject(new Error(`${failures} pruebas fallaron.`)) : resolve()));
  });
}
