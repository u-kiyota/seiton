import { call, h, toast, attempt, confirmButton } from './api.js';
import { autoCloseDaysFrom, autoCloseDuration } from '../lib/core.js';

const $ = (id) => document.getElementById(id);

// ---- 設定項目ごとのページ分け（issue #23）: 左のナビで節を切り替える。URL の #autoclose などで直接その節を開ける ----

const SECTIONS = [...document.querySelectorAll('section.sec')].map((s) => s.dataset.section);

function showSection(key) {
  const k = SECTIONS.includes(key) ? key : SECTIONS[0];
  for (const s of document.querySelectorAll('section.sec')) s.classList.toggle('on', s.dataset.section === k);
  for (const a of document.querySelectorAll('.sidenav a')) a.classList.toggle('on', a.getAttribute('href') === `#${k}`);
}

showSection(location.hash.slice(1));
window.addEventListener('hashchange', () => showSection(location.hash.slice(1)));

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

// ---- セッションごとの Cookie の分離（issue #12） ----

// manifest の optional_permissions / optional_host_permissions と一致させる（lib/cookies.js の COOKIE_PERMISSION と同じ）
const COOKIE_PERMISSION = { permissions: ['cookies'], origins: ['<all_urls>'] };
let cookieBusy = false;

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

/** 設定・権限・退避 Cookie の状態を描く。state を省略すると取り直す */
async function renderCookie(state) {
  if (!state) ({ state } = await call('getState'));
  const st = await call('getCookieStatus');
  const active = st.enabled && st.permitted;
  $('cookieIsolation').checked = active;
  // ON にするときに「今の Cookie はどのセッションのものか」を選ぶ（既定: 最後に使ったワークスペースのセッション）
  const last = state.workspaces[state.lastFocusedWorkspaceId]?.sessionId;
  const preset = st.cookieSessionId && state.sessions[st.cookieSessionId] ? st.cookieSessionId : (state.sessions[last] ? last : state.sessionOrder[0]);
  $('cookieSession').replaceChildren(...state.sessionOrder.map((id) =>
    h('option', { value: id, selected: id === preset }, state.sessions[id].name)));
  $('cookieEnableField').hidden = active;

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
  const head = active
    ? `ON: 今 Chrome に入っている Cookie はセッション「${state.sessions[st.cookieSessionId]?.name || '不明'}」のものとして扱っています。`
    : (st.enabled && !st.permitted
      ? 'OFF: 権限が許可されていないため働いていません。チェックを入れ直して権限を許可してください。'
      : (jarCount ? 'OFF（退避した Cookie が残っています。ON にすると続きから使えます）' : 'OFF'));
  $('cookieStatus').replaceChildren(
    h('div', {}, head),
    h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'セッション'), h('th', {}, 'Cookie の場所'), h('th', {}, '件数・主なサイト'))),
      h('tbody', {}, rows)),
  );
  clearCookieBtn.disabled = !jarCount;
}

$('cookieIsolation').addEventListener('change', async (e) => {
  if (cookieBusy) return;
  cookieBusy = true;
  const on = e.target.checked;
  try {
    if (on) {
      // 権限の要求はユーザー操作の直後に（await を挟むと操作扱いにならないことがある）
      let granted = false;
      try {
        granted = await chrome.permissions.request(COOKIE_PERMISSION);
      } catch (err) {
        toast(err?.message || String(err), true);
      }
      if (!granted) {
        e.target.checked = false;
        toast('権限が許可されなかったため ON にできません', true);
        return;
      }
      const res = await attempt(() => call('setCookieIsolation', { enabled: true, sessionId: $('cookieSession').value }));
      if (res) {
        const { state } = await call('getState');
        toast(`ON にしました。今の Cookie はセッション「${state.sessions[res.cookieSessionId]?.name || ''}」のものです`);
      }
    } else {
      const res = await attempt(() => call('setCookieIsolation', { enabled: false }));
      if (res) toast('OFF にしました（退避した Cookie は残しています）');
    }
  } finally {
    cookieBusy = false;
    await attempt(() => renderCookie());
  }
});

// ワークスペースの切替で「今の Cookie のセッション」が変わったら表示を更新する
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || cookieBusy) return;
  if (changes.cookieSessionId || changes.cookieJars) attempt(() => renderCookie());
});

attempt(load);
attempt(async () => showClosedCount(await call('listClosedTabs')));
