import { cp, copyFile, mkdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
// caxaの展開先はidentifier単位で再利用されるため、バージョンを含める。
const identifier = `stellar-v${pkg.version}`;
const stagingName = '.stellar-build-stage';
const staging = path.join(root, stagingName);
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
try {
  for (const dir of ['server', 'public']) await cp(path.join(root, dir), path.join(staging, dir), { recursive: true });
  await mkdir(path.join(staging, '.opencode', 'agents'), { recursive: true });
  await copyFile(path.join(root, '.opencode', 'agents', 'study.md'), path.join(staging, '.opencode', 'agents', 'study.md'));
  await copyFile(path.join(root, 'package.json'), path.join(staging, 'package.json'));
  const args = [
    '-y', 'caxa@3.0.1', '--input', stagingName,
    '--output', 'dist/Stellar/Stellar.Server.exe',
    '--identifier', identifier,
    '--', '{{caxa}}/node_modules/.bin/node', '{{caxa}}/server/index.js'
  ];
  const result = spawnSync('npx', args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) process.exitCode = result.status || 1;
} finally {
  await rm(staging, { recursive: true, force: true });
}
