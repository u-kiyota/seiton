import { uiText, setText, setTranslatedAttribute, replaceChildren, languageOnlyChange, getLanguage, localizedValue, commandLabel, translateText } from './i18n.js';
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
  renderFileAccess();
}

/**
 * ローカルファイル（file://）のタブの扱い（issue #55）。「ファイルの URL へのアクセス」は chrome://extensions でしか切り替えられず、
 * 許可が無いと file:// は開き直せないので、保存せず切替でも閉じない
 */
function renderFileAccess() {
  const ok = !!data.fileAccess;
  setText($('fileAccessState'), ok ? uiText("（アクセス許可あり）") : uiText("（アクセス許可なし）"));
  replaceChildren($('fileAccessDesc'),
    ok
      ? uiText("拡張に「ファイルの URL へのアクセス」が許可されているので、ローカルファイルのタブも他のタブと同じようにワークスペースに保存し、切替で閉じて開き直します。")
      : uiText("拡張に「ファイルの URL へのアクセス」が許可されていないため、ローカルファイルのタブは開き直せません。そのためワークスペースには保存せず、切替でも閉じずにそのウィンドウに残します（別のワークスペースのタブと並びます）。他のタブと同じように保存・復元したいときは、下のボタンで開く拡張の詳細ページで「ファイルの URL へのアクセスを許可する」を ON にしてください。この拡張がファイルの内容を読んだり送ったりすることはありません。"),
  );
}

$('openExtensionDetails').addEventListener('click', () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }));
// 許可の切替は storage の変化を伴わないので、このタブに戻ってきたときに取り直す（一覧は描き直さない: 編集中の行を壊さないため）
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  attempt(async () => {
    const { fileAccess } = await call('getState');
    if (fileAccess === data.fileAccess) return;
    data.fileAccess = fileAccess;
    renderFileAccess();
  });
});

function showClosedCount(list) {
  const n = Array.isArray(list) ? list.length : 0;
  const badge = $('navClosedCount');
  badge.hidden = !n;
  setText(badge, String(n));
  closedView.render(list);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === 'local' && changes.state && !languageOnlyChange(changes.state)) || (area === 'session' && changes.bindings)) attempt(loadData);
  if (area === 'local' && changes.closedTabs) showClosedCount(changes.closedTabs.newValue);
});

async function load() {
  const { state } = await call('getState');
  const s = state.settings;
  $('language').value = s.language || 'auto';
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
  replaceChildren($('commands'), ...commands.map((c) => h('li', {},
    h('code', {}, c.shortcut || uiText("未設定")), ' ',
    commandLabel(c))));
}

function save(patch) {
  attempt(async () => {
    await call('updateSettings', { patch });
    toast(uiText("保存しました"));
  });
}

$('language').addEventListener('change', (e) => save({ language: e.target.value }));
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
    toast(uiText("期間は 15 分以上で入力してください"), true);
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
  if (!data.workspaces || !data.sessions) throw new Error(uiText("seiton のエクスポートファイルではありません"));
  await call('importData', { data });
  toast(uiText("インポートしました"));
  await load();
}));

// ---- 自動クローズの除外 URL（issue #20） ----

let excludePatterns = [];

function renderExclude() {
  const list = $('excludeList');
  if (!excludePatterns.length) {
    replaceChildren(list, h('div', { class: 'exclude-empty' }, uiText("除外する URL はまだありません。")));
    return;
  }
  replaceChildren(list, ...excludePatterns.map((p) => {
    const input = h('input', { type: 'text', value: p, autocomplete: 'off', title: uiText("書き換えて Enter（または別の場所をクリック）で更新") });
    input.addEventListener('change', () => {
      const v = input.value.trim();
      if (!v) { input.value = p; return; }
      if (v === p) return;
      // 配列ごと置き換える（同じものが既にあれば 1 つにまとまる）
      saveExclude(excludePatterns.map((x) => (x === p ? v : x)), uiText("更新しました"));
    });
    return h('div', { class: 'exclude-row' },
      input,
      h('button', {
        type: 'button', class: 'icon', title: uiText("この除外を削除"),
        onclick: () => attempt(async () => {
          const res = await call('removeAutoCloseExclude', { pattern: p });
          setExclude(res.patterns);
          toast(uiText("削除しました"));
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
    toast(res.added ? uiText("追加しました: {p0}", {p0: (res.pattern)}) : uiText("既に登録されています"));
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

const clearCookieBtn = confirmButton(uiText("退避した Cookie を削除"), uiText("本当に削除？"), () => attempt(async () => {
  await call('clearCookieJars');
  toast(uiText("退避した Cookie を削除しました"));
  await renderCookie();
}), { title: uiText("各セッション用に退避した Cookie をすべて削除（今 Chrome に入っている Cookie は消しません）") });
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
    if (now) where = uiText("今 Chrome に入っている");
    else if (jar) where = uiText("退避済み（{p0}）", {p0: (localizedValue(() => new Date(jar.savedAt).toLocaleString(getLanguage())))});
    else where = uiText("退避した Cookie なし");
    return h('tr', { class: now ? 'now' : '' },
      h('td', {}, state.sessions[id].name),
      h('td', {}, where),
      h('td', {}, info ? uiText("{p0} 件", {p0: (info.count)}) : '—', info?.count ? h('div', { class: 'hosts' }, hostsText(info)) : null));
  });
  const jarCount = Object.keys(st.jars).length;
  let head;
  if (active) head = uiText("今 Chrome に入っている Cookie はセッション「{p0}」のものとして扱っています。", {p0: (state.sessions[st.cookieSessionId]?.name || uiText("不明"))});
  else if (multi) head = uiText("権限が許可されていないため、今はセッション間で Cookie が分かれていません。上の「権限を許可する」で許可してください。");
  else head = uiText("セッションは 1 つです。上の一覧で追加すると権限の確認が出て、許可すると分かれます。");
  replaceChildren($('cookieStatus'),
    h('div', {}, head),
    h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, uiText("セッション")), h('th', {}, uiText("Cookie の場所")), h('th', {}, uiText("件数・主なサイト")))),
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

const clearSyncBtn = confirmButton(uiText("同期データを削除"), uiText("本当に削除？"), () => attempt(async () => {
  const st = await call('clearSyncData');
  toast(uiText("同期ストレージを空にして、同期を OFF にしました"));
  renderSync(st);
}), { title: uiText("同期ストレージ（chrome.storage.sync）を空にして、この端末の同期を OFF にする（各端末のローカルの内容は消えません）") });
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
    nodes.push(h('div', { class: 'err' }, uiText("このブラウザでは同期ストレージ（chrome.storage.sync）が使えません。")));
  } else if (!st.enabled) {
    nodes.push(h('div', { class: 'muted' }, uiText("同期は OFF です。"), st.bytesInUse ? uiText(" 同期ストレージには {p0} のデータがあります（他の端末が書いたもの、または以前の同期）。ON にすると取り込みます。", {p0: (kb(st.bytesInUse))}) : ''));
  } else {
    const when = st.lastSyncAt ? new Date(st.lastSyncAt).toLocaleString() : uiText("まだ同期していません");
    nodes.push(h('div', {}, h('strong', {}, uiText("最後の同期: ")), when, st.applied ? uiText("（他の端末の変更を取り込みました）") : ''));
    const used = st.bytes ?? st.bytesInUse ?? 0;
    const ratio = Math.min(1, used / st.quota);
    nodes.push(h('div', {},
      uiText("使用量 {p0} / {p1}（{p2}%）", {p0: (kb(used)), p1: (kb(st.quota)), p2: (Math.round(ratio * 100))}),
      st.items ? uiText("・{p0} 項目 / {p1}", {p0: (st.items), p1: (st.maxItems)}) : ''));
    nodes.push(h('div', { class: `meter${ratio > 0.85 ? ' warn' : ''}` }, h('div', { style: { width: `${Math.round(ratio * 100)}%` } })));
    if (st.omitted?.length) {
      nodes.push(h('div', { class: 'omitted' },
        uiText("容量に収めるため、次のワークスペースはタブを同期していません（名前・色・セッションは同期しています）: "),
        st.omitted.map((w) => w.name || w.id).join('、')));
    }
    if (st.unreadable?.length) {
      nodes.push(h('div', { class: 'omitted' }, uiText("読み取れなかったワークスペースが {p0} 件あります（他の端末が書き込み中の可能性。次の同期で解消します）", {p0: (st.unreadable.length)})));
    }
  }
  if (st.error) nodes.push(h('div', { class: 'err' }, uiText("エラー: {p0}", {p0: (localizedValue(() => translateText(st.error)))})));
  replaceChildren($('syncStatus'), ...nodes);
  const badge = $('navSyncBadge');
  badge.hidden = !(st.enabled && (st.error || st.omitted?.length));
  setText(badge, st.error ? '!' : String(st.omitted?.length || ''));
}

$('syncEnabled').addEventListener('change', (e) => attempt(async () => {
  const enabled = e.target.checked;
  $('syncEnabled').disabled = true;
  try {
    const st = await call('setSyncEnabled', { enabled });
    toast(enabled ? (st.error ? uiText("同期を ON にしましたが失敗しました: {p0}", {p0: (localizedValue(() => translateText(st.error)))}) : uiText("同期を ON にして、初回の同期を行いました")) : uiText("同期を OFF にしました"), !!(enabled && st.error));
    renderSync(st);
  } finally {
    $('syncEnabled').disabled = false;
  }
}));
$('syncNow').addEventListener('click', () => attempt(async () => {
  $('syncNow').disabled = true;
  try {
    const st = await call('syncNow');
    toast(st.error ? uiText("同期に失敗しました: {p0}", {p0: (localizedValue(() => translateText(st.error)))}) : uiText("同期しました"), !!st.error);
    renderSync(st);
  } finally {
    $('syncNow').disabled = false;
  }
}));

// サービスワーカーが同期を終えたら（状態が更新されたら）表示を更新する
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.syncStatus || changes.state)) attempt(() => renderSync());
});

// ---- 閲覧履歴の検索（任意権限 history）: 管理パネルの検索結果からも許可できる。取り消しはここだけ ----

const HISTORY_PERMISSION = { permissions: ['history'] };

async function renderHistoryPerm() {
  let ok = false;
  try { ok = await chrome.permissions.contains(HISTORY_PERMISSION); } catch { /* 権限 API が使えない */ }
  setText($('historyPermState'), ok ? uiText("許可済み") : uiText("未許可"));
  const btn = ok
    ? h('button', { type: 'button', onclick: () => attempt(async () => {
      await chrome.permissions.remove(HISTORY_PERMISSION);
      toast(uiText("閲覧履歴を読む権限を取り消しました"));
      await renderHistoryPerm();
    }) }, uiText("権限を取り消す"))
    : h('button', { type: 'button', onclick: () => attempt(async () => {
      const granted = await chrome.permissions.request(HISTORY_PERMISSION);
      toast(granted ? uiText("閲覧履歴も検索します") : uiText("権限が許可されませんでした"), !granted);
      await renderHistoryPerm();
    }) }, uiText("権限を許可する"));
  replaceChildren($('historyPermSlot'), btn);
}
chrome.permissions.onAdded.addListener(() => attempt(renderHistoryPerm));
chrome.permissions.onRemoved.addListener(() => attempt(renderHistoryPerm));

attempt(load);
attempt(renderHistoryPerm);
attempt(() => renderSync());
attempt(async () => {
  windowId = (await chrome.windows.getCurrent()).id;
  await loadData();
});
attempt(async () => showClosedCount(await call('listClosedTabs')));
