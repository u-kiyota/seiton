import { call, h, toast, attempt } from './api.js';

const $ = (id) => document.getElementById(id);

async function load() {
  const { state } = await call('getState');
  const s = state.settings;
  $('lazyRestore').checked = s.lazyRestore;
  $('autoDiscardMinutes').value = s.autoDiscardMinutes;
  $('routeBookmarks').checked = s.routeBookmarks;
  $('bookmarkRootName').value = s.bookmarkRootName;
  $('autoCloseEnabled').checked = s.autoClose.enabled;
  $('autoCloseDays').value = s.autoClose.days;

  const commands = await chrome.commands.getAll();
  $('commands').replaceChildren(...commands.map((c) => h('li', {},
    h('code', {}, c.shortcut || '未設定'), ' ',
    c.name === '_execute_action' ? 'クイックパレットを開く' : c.description)));
}

function save(patch) {
  attempt(async () => {
    await call('updateSettings', { patch });
    toast('保存しました');
  });
}

$('lazyRestore').addEventListener('change', (e) => save({ lazyRestore: e.target.checked }));
$('autoDiscardMinutes').addEventListener('change', (e) => save({ autoDiscardMinutes: Number(e.target.value) || 0 }));
$('routeBookmarks').addEventListener('change', (e) => save({ routeBookmarks: e.target.checked }));
$('bookmarkRootName').addEventListener('change', (e) => save({ bookmarkRootName: e.target.value.trim() || 'Workspaces' }));
$('autoCloseEnabled').addEventListener('change', (e) => save({ autoClose: { enabled: e.target.checked } }));
$('autoCloseDays').addEventListener('change', (e) => {
  const days = Number(e.target.value);
  if (e.target.value === '' || !Number.isFinite(days) || days < 0.01) {
    toast('日数は 0.01 以上の数値で入力してください', true);
    attempt(load);
    return;
  }
  save({ autoClose: { days } });
});

$('openGuide').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/guide.html') }));
$('openShortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
$('openPerf').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://settings/performance' });
});

$('export').addEventListener('click', () => attempt(async () => {
  const { state } = await call('getState');
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `seiton-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  URL.revokeObjectURL(a.href);
}));
$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', (e) => attempt(async () => {
  const file = e.target.files[0];
  if (!file) return;
  const data = JSON.parse(await file.text());
  if (!data.workspaces || !data.sessions) throw new Error('seiton のエクスポートファイルではありません');
  await call('importData', { data });
  toast('インポートしました');
  await load();
}));

attempt(load);
