// 配布用 zip を作る: dist/seiton-v<version>.zip（ルートに manifest.json、src/ と icons/ のみ）
// 使い方: node scripts/build-zip.js [--check-tag <tag>]
import { readFileSync, mkdirSync, rmSync, cpSync, statSync, mkdtempSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const die = (msg) => { console.error('NG', msg); process.exit(1); };

const { version } = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
if (!version) die('manifest.json に version がありません');

const args = process.argv.slice(2);
const i = args.indexOf('--check-tag');
if (i !== -1) {
  const tag = args[i + 1];
  if (!tag) die('--check-tag にはタグ名が必要です');
  if (tag !== `v${version}`) die(`タグ ${tag} と manifest.json の version (v${version}) が一致しません`);
  console.log(`OK タグ ${tag} は manifest.json の version と一致`);
}

const has = (cmd, a) => spawnSync(cmd, a, { stdio: 'ignore' }).status === 0;
const isBsdtar = () => /bsdtar/.test(spawnSync('tar', ['--version'], { encoding: 'utf8' }).stdout ?? '');
const run = (cmd, a, cwd) => {
  const r = spawnSync(cmd, a, { cwd, stdio: 'inherit' });
  if (r.status !== 0) die(`${cmd} が失敗しました`);
};

const dist = join(root, 'dist');
const out = join(dist, `seiton-v${version}.zip`);
mkdirSync(dist, { recursive: true });
rmSync(out, { force: true });

// 配布に必要なものだけを一時ディレクトリに集めてから zip 化する
const stage = mkdtempSync(join(tmpdir(), 'seiton-zip-'));
try {
  for (const p of ['manifest.json', 'src', 'icons']) cpSync(join(root, p), join(stage, p), { recursive: true });
  if (has('zip', ['-v'])) {
    run('zip', ['-r', '-X', '-q', out, '.'], stage);
  } else if (process.platform === 'win32' && isBsdtar()) {
    // Windows 10+ 標準の bsdtar。PowerShell 5.1 の Compress-Archive はパス区切りが "\" になるため優先する
    run('tar', ['-a', '-c', '-f', out, 'manifest.json', 'src', 'icons'], stage);
  } else if (process.platform === 'win32' && has('powershell', ['-NoProfile', '-Command', 'exit 0'])) {
    run('powershell', ['-NoProfile', '-Command',
      `Compress-Archive -Path (Join-Path '${stage}' '*') -DestinationPath '${out}' -Force`]);
  } else {
    die('zip コマンドも PowerShell (Compress-Archive) も見つかりません');
  }
} finally {
  rmSync(stage, { recursive: true, force: true });
}

console.log(`zip: ${out}`);
console.log(`size: ${statSync(out).size} bytes`);
