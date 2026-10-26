import { call, h, toast, attempt, confirmButton } from './api.js';
import { autoCloseDaysFrom, autoCloseDuration } from '../lib/core.js';

const $ = (id) => document.getElementById(id);

async function load() {
  const { state } = await call('getState');
  const s = state.settings;
  $('workspaceTab').checked = s.workspaceTab;
  $('lazyRestore').checked = s.lazyRestore;
  $('autoDiscardMinutes').value = s.autoDiscardMinutes;
  $('routeBookmarks').checked = s.routeBookmarks;
  $('bookmarkRootName').value = s.bookmarkRootName;
  $('autoCloseEnabled').checked = s.autoClose.enabled;
  const dur = autoCloseDuration(s.autoClose.days);
  $('autoCloseValue').value = dur.value;
  $('autoCloseUnit').value = dur.unit;
  setExclude(s.autoCloseExclude);

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

$('workspaceTab').addEventListener('change', (e) => save({ workspaceTab: e.target.checked }));
$('lazyRestore').addEventListener('change', (e) => save({ lazyRestore: e.target.checked }));
$('autoDiscardMinutes').addEventListener('change', (e) => save({ autoDiscardMinutes: Number(e.target.value) || 0 }));
$('routeBookmarks').addEventListener('change', (e) => save({ routeBookmarks: e.target.checked }));
$('bookmarkRootName').addEventListener('change', (e) => save({ bookmarkRootName: e.target.value.trim() || 'Workspaces' }));
$('autoCloseEnabled').addEventListener('change', (e) => save({ autoClose: { enabled: e.target.checked } }));
function saveAutoCloseDuration() {
  const days = autoCloseDaysFrom($('autoCloseValue').value, $('autoCloseUnit').value);
  if (days === null) {
    toast('期間は 15 分以上で入力してください', true);
    attempt(load);
    return;
  }
  save({ autoClose: { days } });
}
$('autoCloseValue').addEventListener('change', saveAutoCloseDuration);
$('autoCloseUnit').addEventListener('change', saveAutoCloseDuration);

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

// ---- 自動クローズの除外 URL（issue #20） ----

let excludePatterns = [];

function renderExclude() {
  const list = $('excludeList');
  if (!excludePatterns.length) {
    list.replaceChildren(h('div', { class: 'exclude-empty' }, '除外する URL はまだありません。'));
    return;
  }
  list.replaceChildren(...excludePatterns.map((p) => {
    const input = h('input', { type: 'text', value: p, autocomplete: 'off', title: '書き換えて Enter（または別の場所をクリック）で更新' });
    input.addEventListener('change', () => {
      const v = input.value.trim();
      if (!v) { input.value = p; return; }
      if (v === p) return;
      // 配列ごと置き換える（同じものが既にあれば 1 つにまとまる）
      saveExclude(excludePatterns.map((x) => (x === p ? v : x)), '更新しました');
    });
    return h('div', { class: 'exclude-row' },
      input,
      h('button', {
        type: 'button', class: 'icon', title: 'この除外を削除',
        onclick: () => attempt(async () => {
          const res = await call('removeAutoCloseExclude', { pattern: p });
          setExclude(res.patterns);
          toast('削除しました');
        }),
      }, '×'));
  }));
}

function setExclude(list) {
  excludePatterns = Array.isArray(list) ? list : [];
  renderExclude();
}

function saveExclude(next, msg) {
  attempt(async () => {
    const s = await call('updateSettings', { patch: { autoCloseExclude: next } });
    setExclude(s.autoCloseExclude);
    toast(msg);
  });
}

$('excludeAdd').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('excludePattern').value.trim();
  if (!v) return;
  attempt(async () => {
    const res = await call('addAutoCloseExclude', { pattern: v });
    $('excludePattern').value = '';
    setExclude(res.patterns);
    toast(res.added ? `追加しました: ${res.pattern}` : '既に登録されています');
  });
});

// 管理パネルから追加されたものを反映する（編集中の行があるときは、その操作が終わってから）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.state) return;
  const next = changes.state.newValue?.settings?.autoCloseExclude;
  if (!Array.isArray(next) || JSON.stringify(next) === JSON.stringify(excludePatterns)) return;
  if ($('excludeList').contains(document.activeElement)) return;
  setExclude(next);
});

// 自動クローズで閉じたタブの履歴（管理パネルを開かなくても一括削除できるように）
const clearClosedBtn = confirmButton('閉じたタブの履歴を削除', '本当に削除？', () => attempt(async () => {
  await call('clearClosedTabs');
  toast('閉じたタブの履歴を削除しました');
}), { title: '自動クローズで閉じたタブの履歴をすべて削除（管理パネルの「閉じたタブ」と同じ）' });
$('clearClosedSlot').append(clearClosedBtn);

function showClosedCount(list) {
  const n = Array.isArray(list) ? list.length : 0;
  clearClosedBtn.disabled = !n;
  $('closedCount').textContent = `自動クローズで閉じたタブの履歴: ${n} 件`;
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.closedTabs) showClosedCount(changes.closedTabs.newValue);
});

attempt(load);
attempt(async () => showClosedCount(await call('listClosedTabs')));
