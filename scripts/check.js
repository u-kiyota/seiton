// 静的チェック: manifest の妥当性・参照ファイルの存在・JS 構文・import 名の解決
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
let errors = 0;
const fail = (msg) => { console.error('NG', msg); errors++; };

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const refs = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_page,
  'src/ui/sidepanel.html',
  'src/ui/guide.html',
  'src/ui/wstab.html', // ワークスペースタブ（lib/wstab.js が開く）
];
for (const r of refs) if (!existsSync(join(root, r))) fail(`manifest が参照するファイルがありません: ${r}`);
const iconRefs = [
  ...Object.values(manifest.icons ?? {}),
  ...(typeof manifest.action?.default_icon === 'string'
    ? [manifest.action.default_icon]
    : Object.values(manifest.action?.default_icon ?? {})),
];
for (const r of iconRefs) if (!existsSync(join(root, r))) fail(`manifest が参照するファイルがありません: ${r}`);
const suggested = Object.values(manifest.commands).filter((c) => c.suggested_key).length;
if (suggested > 4) fail(`suggested_key は 4 個までです（${suggested} 個）`);

// HTML から参照される script / css
for (const html of refs.filter((r) => r.endsWith('.html'))) {
  const src = readFileSync(join(root, html), 'utf8');
  for (const [, ref] of src.matchAll(/(?:src|href)="([^"#:]+\.(?:js|css|png))"/g)) {
    if (!existsSync(join(root, dirname(html), ref))) fail(`${html} が参照する ${ref} がありません`);
  }
}

const jsFiles = [];
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) jsFiles.push(p);
  }
};
walk(join(root, 'src'));

const exportsOf = (file) => {
  const src = readFileSync(file, 'utf8');
  const names = new Set();
  for (const [, n] of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)/g)) names.add(n);
  for (const [, list] of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of list.split(',')) names.add(part.trim().split(/\s+as\s+/).pop());
  }
  return names;
};

for (const file of jsFiles) {
  const rel = relative(root, file);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    fail(`${rel}: 構文エラー\n${e.stderr}`);
    continue;
  }
  const src = readFileSync(file, 'utf8');
  for (const [, names, spec] of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
    const target = join(dirname(file), spec);
    if (!existsSync(target)) { fail(`${rel}: ${spec} が見つかりません`); continue; }
    const exp = exportsOf(target);
    for (const n of names.split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
      if (!exp.has(n)) fail(`${rel}: ${spec} に export ${n} がありません`);
    }
  }
}

console.log(errors ? `\n${errors} 件の問題` : `OK (${jsFiles.length} files)`);
process.exit(errors ? 1 : 0);
