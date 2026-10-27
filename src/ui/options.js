import { call, h, toast, attempt, confirmButton } from './api.js';
import { autoCloseDaysFrom, autoCloseDuration } from '../lib/core.js';
import { createWorkspaceManager, createSessionManager, createClosedTabsView } from './manage.js';

const $ = (id) => document.getElementById(id);

// ---- 項目ごとのページ分け（issue #23）: 左のサイドメニューで節を切り替える。URL の #autoclose などで直接その節を開ける ----

const SECTIONS = [...document.querySelectorAll('section.sec')].map((s) => s.dataset.section);

function showSection(key) {
  const k = SECTIONS.includes(key) ? key : SECTIONS[0];
  for (const s of document.querySelectorAll('section.sec')) s.classList.toggle('on', s.dataset.section === k);
  for (const a of document.querySelectorAll('.sidenav a')) a.classList.toggle('on', a.getAttribute('href') === `#${k}`);
}

showSection(location.hash.slice(1));
window.addEventListener('hashchange', () => showSection(location.hash.slice(1)));

// ---- 管理: ワークスペース / セッション / 閉じたタブ（manage.js。issue #23 / #25） ----

let data = { state: null, bindings: {} };
let windowId = null; // このタブのウィンドウ（「ここ」バッジ・閉じたタブを開き直す先）
const ctx = { getData: () => data, getWindowId: () => windowId };
const wsManager = createWorkspaceManager($('wsManager'), ctx);
const sessionManager = createSessionManager($('sessionManager'), ctx);
const closedView = createClosedTabsView($('closedView'), ctx);

async function loadData() {
  data = await call('getState');
  wsManager.render();
  await sessionManager.render();
}

function showClosedCount(list) {
  const n = Array.isArray(list) ? list.length : 0;
  const badge = $('navClosedCount');
  badge.hidden = !n;
  badge.textContent = String(n);
  closedView.render(list);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === 'local' && changes.state) || (area === 'session' && changes.bindings)) attempt(loadData);
  if (area === 'local' && changes.closedTabs) showClosedCount(changes.closedTabs.newValue);
});

async function load() {
  const { state } = await call('getState');
  const s = state.settings;
  $('workspaceTab').checked = s.workspaceTab;
  $('switchMode').value = s.switchMode || 'switch';
  $('lazyRestore').checked = s.lazyRestore;
  $('autoDiscardMinutes').value = s.autoDiscardMinutes;
  $('routeBookmarks').checked = s.routeBookmarks;
  $('bookmarkRootName').value = s.bookmarkRootName;
  $('autoCloseEnabled').checked = s.autoClose.enabled;
  const dur = autoCloseDuration(s.autoClose.days);
  $('autoCloseValue').value = dur.value;
  $('autoCloseUnit').value = dur.unit;
  setExclude(s.autoCloseExclude);
  await renderCookie(state);

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
$('switchMode').addEventListener('change', (e) => save({ switchMode: e.target.value }));
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

// ---- セッションごとの Cookie の分離（issue #12） ----

const clearCookieBtn = confirmButton('退避した Cookie を削除', '本当に削除？', () => attempt(async () => {
  await call('clearCookieJars');
  toast('退避した Cookie を削除しました');
  await renderCookie();
}), { title: '各セッション用に退避した Cookie をすべて削除（今 Chrome に入っている Cookie は消しません）' });
$('clearCookieSlot').append(clearCookieBtn);

function hostsText(info) {
  if (!info || !info.count) return '';
  const names = info.hosts.map((x) => x.host).join(', ');
  return info.hosts.length < info.count ? `${names}, …` : names;
}

/** 権限・退避 Cookie の状態を描く。state を省略すると取り直す */
async function renderCookie(state) {
  if (!state) ({ state } = await call('getState'));
  const st = await call('getCookieStatus');
  const active = st.permitted;
  const multi = state.sessionOrder.length > 1;
  // 表の見出しだけ。権限の許可ボタンは上の「セッション」の一覧に出す

  const rows = state.sessionOrder.map((id) => {
    const now = active && id === st.cookieSessionId;
    const jar = st.jars[id];
    const info = now ? st.live : jar;
    let where;
    if (now) where = '今 Chrome に入っている';
    else if (jar) where = `退避済み（${new Date(jar.savedAt).toLocaleString()}）`;
    else where = '退避した Cookie なし';
    return h('tr', { class: now ? 'now' : '' },
      h('td', {}, state.sessions[id].name),
      h('td', {}, where),
      h('td', {}, info ? `${info.count} 件` : '—', info?.count ? h('div', { class: 'hosts' }, hostsText(info)) : null));
  });
  const jarCount = Object.keys(st.jars).length;
  let head;
  if (active) head = `今 Chrome に入っている Cookie はセッション「${state.sessions[st.cookieSessionId]?.name || '不明'}」のものとして扱っています。`;
  else if (multi) head = '権限が許可されていないため、今はセッション間で Cookie が分かれていません。上の「権限を許可する」で許可してください。';
  else head = 'セッションは 1 つです。上の一覧で追加すると権限の確認が出て、許可すると分かれます。';
  $('cookieStatus').replaceChildren(
    h('div', {}, head),
    h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'セッション'), h('th', {}, 'Cookie の場所'), h('th', {}, '件数・主なサイト'))),
      h('tbody', {}, rows)),
  );
  clearCookieBtn.disabled = !jarCount;
}

// ワークスペースの切替で「今の Cookie のセッション」が変わったら表示を更新する
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.cookieSessionId || changes.cookieJars || changes.state) attempt(() => renderCookie());
});

// ---- 同期（issue #4） ----

const clearSyncBtn = confirmButton('同期データを削除', '本当に削除？', () => attempt(async () => {
  const st = await call('clearSyncData');
  toast('同期ストレージを空にして、同期を OFF にしました');
  renderSync(st);
}), { title: '同期ストレージ（chrome.storage.sync）を空にして、この端末の同期を OFF にする（各端末のローカルの内容は消えません）' });
$('clearSyncSlot').append(clearSyncBtn);

function kb(n) {
  return `${(n / 1024).toFixed(1)} KB`;
}

/** 同期の状態を描く。st を省略すると取り直す */
async function renderSync(st) {
  if (!st) st = await call('getSyncStatus');
  $('syncEnabled').checked = st.enabled;
  $('syncEnabled').disabled = !st.available;
  $('syncNow').disabled = !st.enabled || !st.available;
  const nodes = [];
  if (!st.available) {
    nodes.push(h('div', { class: 'err' }, 'このブラウザでは同期ストレージ（chrome.storage.sync）が使えません。'));
  } else if (!st.enabled) {
    nodes.push(h('div', { class: 'muted' }, '同期は OFF です。', st.bytesInUse ? ` 同期ストレージには ${kb(st.bytesInUse)} のデータがあります（他の端末が書いたもの、または以前の同期）。ON にすると取り込みます。` : ''));
  } else {
    const when = st.lastSyncAt ? new Date(st.lastSyncAt).toLocaleString() : 'まだ同期していません';
    nodes.push(h('div', {}, h('strong', {}, '最後の同期: '), when, st.applied ? '（他の端末の変更を取り込みました）' : ''));
    const used = st.bytes ?? st.bytesInUse ?? 0;
    const ratio = Math.min(1, used / st.quota);
    nodes.push(h('div', {},
      `使用量 ${kb(used)} / ${kb(st.quota)}（${Math.round(ratio * 100)}%）`,
      st.items ? `・${st.items} 項目 / ${st.maxItems}` : ''));
    nodes.push(h('div', { class: `meter${ratio > 0.85 ? ' warn' : ''}` }, h('div', { style: { width: `${Math.round(ratio * 100)}%` } })));
    if (st.omitted?.length) {
      nodes.push(h('div', { class: 'omitted' },
        `容量に収めるため、次のワークスペースはタブを同期していません（名前・色・セッションは同期しています）: `,
        st.omitted.map((w) => w.name || w.id).join('、')));
    }
    if (st.unreadable?.length) {
      nodes.push(h('div', { class: 'omitted' }, `読み取れなかったワークスペースが ${st.unreadable.length} 件あります（他の端末が書き込み中の可能性。次の同期で解消します）`));
    }
  }
  if (st.error) nodes.push(h('div', { class: 'err' }, `エラー: ${st.error}`));
  $('syncStatus').replaceChildren(...nodes);
  const badge = $('navSyncBadge');
  badge.hidden = !(st.enabled && (st.error || st.omitted?.length));
  badge.textContent = st.error ? '!' : String(st.omitted?.length || '');
}

$('syncEnabled').addEventListener('change', (e) => attempt(async () => {
  const enabled = e.target.checked;
  $('syncEnabled').disabled = true;
  try {
    const st = await call('setSyncEnabled', { enabled });
    toast(enabled ? (st.error ? `同期を ON にしましたが失敗しました: ${st.error}` : '同期を ON にして、初回の同期を行いました') : '同期を OFF にしました', !!(enabled && st.error));
    renderSync(st);
  } finally {
    $('syncEnabled').disabled = false;
  }
}));
$('syncNow').addEventListener('click', () => attempt(async () => {
  $('syncNow').disabled = true;
  try {
    const st = await call('syncNow');
    toast(st.error ? `同期に失敗しました: ${st.error}` : '同期しました', !!st.error);
    renderSync(st);
  } finally {
    $('syncNow').disabled = false;
  }
}));

// サービスワーカーが同期を終えたら（状態が更新されたら）表示を更新する
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.syncStatus || changes.state)) attempt(() => renderSync());
});

attempt(load);
attempt(() => renderSync());
attempt(async () => {
  windowId = (await chrome.windows.getCurrent()).id;
  await loadData();
});
attempt(async () => showClosedCount(await call('listClosedTabs')));
