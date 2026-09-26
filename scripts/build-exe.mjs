import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// identifierにバージョンを含める。caxaはidentifierごとに展開先を決めるため、
// 同じidentifierのまま更新すると古い展開済みコードが使われ続けてしまう。
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const identifier = `study-app-v${pkg.version}`;
const args = [
  '-y', 'caxa@3.0.1',
  '--input', '.',
  '--output', 'dist/StudyApp/StudyApp.Server.exe',
  '--identifier', identifier,
  '--exclude', 'data/**',
  '--exclude', '.git/**',
  '--exclude', '**/node_modules/**',
  '--exclude', 'test/**',
  '--exclude', 'dist/**',
  '--exclude', 'window/*/bin/**',
  '--exclude', 'window/*/obj/**',
  '--', '{{caxa}}/node_modules/.bin/node', '{{caxa}}/server/index.js'
];
const result = spawnSync('npx', args, { stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(result.status ?? 1);
