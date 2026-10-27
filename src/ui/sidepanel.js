import {
  tabUrl, normalizeUrlForMatch, isManagerUrl, isWorkspaceTabUrl, workspacesUsingSession, matchesQuery, ICON_GROUPS, ICONS, normalizeIcon,
  TAB_DRAG_TYPE, parseTabDragData, isBookmarkableUrl, workspaceHotkey, hotkeyToIndex,
  autoCloseDaysFrom, autoCloseDuration, formatAutoCloseDuration, AUTO_CLOSE_UNIT_LABELS,
  CLOSED_TABS_MAX, closedDayLabel, formatClockTime, autoCloseExcludeMatch, excludePatternsForUrl,
  WORKSPACE_DRAG_TYPE, parseWorkspaceDragData, dropPlacement, reorderDropIndex,
} from '../lib/core.js';
import { call, h, faviconUrl, COLOR_HEX, wsIcon, toast, attempt, confirmButton } from './api.js';

const $ = (id) => document.getElementById(id);
const COLORS = Object.keys(COLOR_HEX);

// 対象ウィンドウ（パネルを呼び出した通常ウィンドウ）。切替・URL を開く先はここ。パネル自身のウィンドウではない
let windowId;
// パネル自身のポップアップウィンドウ。タブとして開かれた場合（旧版の名残など）は null で、自動では閉じない
let selfWindowId = null;
let data = { state: null, bindings: {} };
// Cookie の分離の状態（issue #12）。✎ のヒントとセッション管理の表示に使う。live（今の Cookie の件数）は重いので取らない
let cookieInfo = null;
// manifest の optional_permissions / optional_host_permissions と一致させる（lib/cookies.js の COOKIE_PERMISSION と同じ）
const COOKIE_PERMISSION = { permissions: ['cookies'], origins: ['<all_urls>'] };
let selectedId = null;
let editingId = null;
let folders = null; // 接続先フォルダ候補（編集を開いた時に読み込む）
let detail = { tabsView: null, bookmarks: undefined };
let detailSeq = 0;
let detailTimer = 0;
let bmKey = '';
let bmData;

// ---- パネルの開閉: 一時的なポップアップウィンドウとして、移動・Esc・フォーカス喪失で閉じる ----

let moving = 0; // 実行中の「移動」操作の数。完了を待ってから閉じる
let closeWhenIdle = false;
// パネルの外にフォーカスが移っても閉じない区間の数（Chrome の権限ダイアログなど）。0 に戻ったらパネルにフォーカスを戻す
let holdOpen = 0;

/** fn の間はフォーカスを失ってもパネルを閉じない（権限ダイアログがパネルの前に出るため）。終わったらパネルを前面に戻す */
async function holdPanel(fn) {
  holdOpen++;
  try {
    return await fn();
  } finally {
    holdOpen--;
    if (!holdOpen && selfWindowId != null) chrome.windows.update(selfWindowId, { focused: true }).catch(() => {});
  }
}

function closePanel() {
  if (selfWindowId == null) return;
  if (moving) { closeWhenIdle = true; return; }
  chrome.windows.remove(selfWindowId).catch(() => {});
}

/**
 * 移動を伴う操作。fn の完了（切替の await を含む）を待ってから、fn が返したウィンドウを前面にしてパネルを閉じる。
 * fn が null / undefined を返したらフォーカスは動かさない。失敗したらパネルは開いたまま（呼び出し側の attempt でエラー表示）
 */
async function moveAway(fn) {
  moving++;
  try {
    const dest = await fn();
    if (dest != null) await chrome.windows.update(dest, { focused: true }).catch(() => {});
    closeWhenIdle = true;
  } finally {
    moving--;
    if (!moving && closeWhenIdle) closePanel();
  }
}

/** URL の ?windowId= から対象ウィンドウを決める。無い・閉じられていれば最後にフォーカスした通常ウィンドウ */
async function resolveTargetWindow() {
  const raw = new URLSearchParams(location.search).get('windowId');
  const v = raw === null ? NaN : Number(raw);
  if (Number.isInteger(v)) {
    try {
      const w = await chrome.windows.get(v);
      if (w.type === 'normal') return w.id;
    } catch { /* 閉じられている */ }
  }
  return (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id;
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

function fav(url) {
  const img = h('img', { class: 'fav', src: faviconUrl(url), alt: '' });
  img.addEventListener('error', () => img.remove());
  return img;
}

function windowOf(wsId) {
  const e = Object.entries(data.bindings).find(([, w]) => w === wsId);
  return e ? Number(e[0]) : null;
}

function sessionName(id) {
  return data.state.sessions[id]?.name || '';
}

/**
 * アイコン選択 UI。既定の絵文字から選ぶか、入力欄に任意の絵文字を入れる。「なし」で色のドットに戻す。
 * onPick(icon) は選択のたびに呼ばれる（icon は '' = なし）
 */
function iconPicker(current, onPick) {
  let value = normalizeIcon(current);
  const box = h('div', { class: 'icon-picker' });
  const custom = h('input', { type: 'text', placeholder: '絵文字', title: '一覧に無い絵文字を入力', maxlength: 16, autocomplete: 'off' });
  const buttons = [];
  const sync = () => {
    for (const b of buttons) b.classList.toggle('sel', b.dataset.icon === value);
    // 入力中（IME 変換中を含む）は入力欄の内容を書き換えない
    if (document.activeElement !== custom) custom.value = ICONS.includes(value) ? '' : value;
    custom.classList.toggle('sel', !!value && !ICONS.includes(value));
  };
  const pick = (v) => { value = normalizeIcon(v); sync(); onPick(value); };
  const row = (...kids) => h('div', { class: 'icon-row' }, ...kids);
  const groups = ICON_GROUPS.map((g) => {
    const btns = g.icons.map((ic) => h('button', { type: 'button', 'data-icon': ic, title: ic, onclick: () => pick(ic) }, ic));
    buttons.push(...btns);
    return row(h('span', { class: 'icon-label' }, g.label), ...btns);
  });
  const none = h('button', { type: 'button', class: 'none', 'data-icon': '', title: 'アイコンなし（色のドットを表示）', onclick: () => pick('') }, 'なし');
  buttons.push(none);
  // IME 変換中は確定するまで反映しない（変換中の文字列を保存しないため）
  const commitCustom = () => {
    const v = normalizeIcon(custom.value);
    if (v) pick(v);
  };
  custom.addEventListener('input', (e) => { if (!e.isComposing) commitCustom(); });
  custom.addEventListener('compositionend', commitCustom);
  custom.addEventListener('blur', () => { if (!normalizeIcon(custom.value) && !ICONS.includes(value)) pick(''); sync(); });
  box.append(...groups, row(h('span', { class: 'icon-label' }, 'その他'), custom, none));
  sync();
  return box;
}

function ensureSelection() {
  const { state, bindings } = data;
  if (selectedId && state.workspaces[selectedId]) return;
  selectedId = bindings[windowId] && state.workspaces[bindings[windowId]] ? bindings[windowId] : null;
}

async function load() {
  data = await call('getState');
  try {
    cookieInfo = await call('getCookieStatus', { live: false });
  } catch { cookieInfo = null; }
  ensureSelection();
  syncBookmarkCache();
  render();
  await refreshDetail();
  // 検索結果を表示中なら最新の状態で描き直す
  if (!$('searchResults').hidden) attempt(runSearch);
}

function selectWorkspace(id) {
  if (selectedId === id) return;
  selectedId = id;
  editingId = null;
  detail = { tabsView: null, bookmarks: undefined };
  render();
  attempt(refreshDetail);
}

/** 対象ウィンドウをそのワークスペースに切り替える（別ウィンドウで開いていればそちらへ）。完了後にパネルを閉じる */
function switchHere(id) {
  if (data.bindings[windowId] === id) return undefined;
  return attempt(() => moveAway(async () => {
    const res = await call('switchWorkspace', { windowId, workspaceId: id });
    return res?.windowId ?? windowId;
  }));
}

/** 新しいウィンドウで開く（既に開いていればそのウィンドウへ）。完了後にパネルを閉じる */
function openNewWindow(id) {
  return attempt(() => moveAway(async () => (await call('openInNewWindow', { workspaceId: id }))?.windowId));
}

/** 一覧の行をクリック: 選択して、このウィンドウをそのワークスペースに切り替える（別ウィンドウで開いていればそちらへ） */
function onRowClick(id) {
  selectWorkspace(id);
  switchHere(id);
}

/** ブックマークまたは保存済みタブを 1 件だけ開く。開いているワークスペースならそのウィンドウへ */
async function openSingle(url) {
  return openUrlIn(url, selectedId);
}

/** URL を 1 件開く。wsId のワークスペースが別ウィンドウで開いていればそこで、そうでなければ対象ウィンドウで。開いたらパネルを閉じる */
async function openUrlIn(url, wsId) {
  const openWin = wsId ? windowOf(wsId) : null;
  const wid = openWin ?? windowId;
  await moveAway(async () => {
    const tabs = await chrome.tabs.query({ windowId: wid });
    const want = normalizeUrlForMatch(url);
    const existing = tabs.find((t) => normalizeUrlForMatch(tabUrl(t)) === want);
    if (existing) await chrome.tabs.update(existing.id, { active: true });
    else await chrome.tabs.create({ windowId: wid, url, active: true });
    return wid;
  });
}

async function focusTab(tab) {
  await moveAway(async () => {
    await chrome.tabs.update(tab.id, { active: true });
    return tab.windowId;
  });
}

function renderDetailHead() {
  const { state, bindings } = data;
  const box = $('detailHead');
  const parts = [];
  const ws = state.workspaces[selectedId];

  if (!bindings[windowId]) {
    parts.push(h('div', { class: 'row' },
      h('span', { class: 'muted small grow' }, 'このウィンドウは未割り当てです。今開いているタブを新しいワークスペースとして保存できます。'),
      h('button', { type: 'button', onclick: () => openCreateDialog({ keepTabs: true }) }, '今のタブをワークスペースとして保存'),
    ));
  }

  if (ws) {
    const here = bindings[windowId] === ws.id;
    const openIn = windowOf(ws.id);
    parts.push(h('div', { class: 'row' },
      wsIcon(ws, 'lg'),
      h('span', { class: 'grow ellipsis' }, h('b', {}, ws.name)),
      h('span', { class: 'ws-session', title: '使うセッション' }, sessionName(ws.sessionId)),
      here ? h('span', { class: 'badge here' }, 'このウィンドウ')
        : openIn != null ? h('span', { class: 'badge' }, '別ウィンドウ')
          : h('span', { class: 'badge' }, '未オープン'),
      here ? null : h('button', {
        class: 'primary', type: 'button',
        title: openIn != null ? '開いているウィンドウへ移動' : 'このウィンドウのタブを入れ替えて開く',
        onclick: () => switchHere(ws.id),
      }, openIn != null ? 'そのウィンドウへ' : 'このウィンドウで開く'),
      h('button', {
        class: 'icon', type: 'button', title: '新しいウィンドウで開く',
        onclick: () => openNewWindow(ws.id),
      }, '⧉'),
      h('button', {
        class: 'icon', type: 'button', title: '編集',
        onclick: () => {
          editingId = editingId === ws.id ? null : ws.id;
          render();
          if (editingId) loadFolders();
        },
      }, editingId === ws.id ? '▲' : '✎'),
      here ? h('button', {
        class: 'icon', type: 'button', title: 'ワークスペースの割り当てを外す（タブはそのまま残ります）',
        onclick: () => attempt(() => call('detachWindow', { windowId })),
      }, '切り離す') : null,
    ));
  }
  box.replaceChildren(...parts);
  // replaceChildren(null) は "null" という文字列ノードになるので、要素があるときだけ渡す
  $('editor').replaceChildren(...(ws && editingId === ws.id ? [renderEditor(ws)] : []));
}

function renderEditor(ws) {
  const { state } = data;
  const name = h('input', { type: 'text', value: ws.name, class: 'grow' });
  name.addEventListener('change', () => attempt(() => call('updateWorkspace', { id: ws.id, patch: { name: name.value } })));

  const colors = h('div', { class: 'colors' }, COLORS.map((c) => h('span', {
    class: 'dot' + (c === ws.color ? ' sel' : ''), title: c, style: { background: COLOR_HEX[c] },
    onclick: () => attempt(() => call('updateWorkspace', { id: ws.id, patch: { color: c } })),
  })));

  const icon = iconPicker(ws.icon, (v) => attempt(() => call('updateWorkspace', { id: ws.id, patch: { icon: v } })));

  const session = h('select', { class: 'grow' }, state.sessionOrder.map((id) =>
    h('option', { value: id, selected: id === ws.sessionId }, state.sessions[id].name)));
  session.addEventListener('change', () => attempt(async () => {
    const res = await call('updateWorkspace', { id: ws.id, patch: { sessionId: session.value } });
    toast(res?.cookieSession
      ? `セッション「${state.sessions[session.value].name}」を使うようにし、Cookie を入れ替えてページを読み込み直しました`
      : `セッション「${state.sessions[session.value].name}」を使うようにしました`);
  }));

  const folderSel = h('select', { class: 'grow' },
    h('option', { value: '' }, '（未接続）'),
    (folders || []).map((f) => h('option', { value: f.id, selected: f.id === ws.bookmarkFolderId }, f.path)));
  if (ws.bookmarkFolderId && !(folders || []).some((f) => f.id === ws.bookmarkFolderId)) {
    folderSel.append(h('option', { value: ws.bookmarkFolderId, selected: true }, '（読み込み中…）'));
  }
  folderSel.addEventListener('change', () => attempt(async () => {
    await call('linkFolder', { workspaceId: ws.id, folderId: folderSel.value });
    bmKey = '';
  }));

  // タブの自動クローズ: 設定に従う（null）/ 無効 / 有効（日数）
  const globalAc = state.settings.autoClose || { enabled: false, days: 7 };
  const ac = ws.autoClose || null;
  const acDaysValue = ac?.days ?? globalAc.days;
  const saveAutoClose = (autoClose) => attempt(() => call('updateWorkspace', { id: ws.id, patch: { autoClose } }));
  const acMode = h('select', { class: 'grow' },
    h('option', { value: '', selected: !ac }, `設定に従う（${globalAc.enabled ? `有効・${formatAutoCloseDuration(globalAc.days)}` : '無効'}）`),
    h('option', { value: 'off', selected: !!ac && !ac.enabled }, '無効'),
    h('option', { value: 'on', selected: !!ac?.enabled }, '有効'));
  acMode.addEventListener('change', () => saveAutoClose(acMode.value ? { enabled: acMode.value === 'on', days: acDaysValue } : null));
  // 期間は「数値 + 単位（分 / 時間 / 日）」で入力し、日数に換算して保存する（最短 15 分）
  const acDur = autoCloseDuration(acDaysValue);
  const acValue = h('input', { type: 'number', min: '1', step: '1', value: String(acDur.value), style: { width: '70px' } });
  const acUnit = h('select', {}, ...Object.entries(AUTO_CLOSE_UNIT_LABELS).map(([v, label]) =>
    h('option', { value: v, selected: v === acDur.unit }, label)));
  const onDurationChange = () => {
    const days = autoCloseDaysFrom(acValue.value, acUnit.value);
    if (days === null) {
      toast('期間は 15 分以上で入力してください', true);
      acValue.value = String(acDur.value);
      acUnit.value = acDur.unit;
      return;
    }
    saveAutoClose({ enabled: true, days });
  };
  acValue.addEventListener('change', onDurationChange);
  acUnit.addEventListener('change', onDurationChange);

  const order = state.workspaceOrder;
  const idx = order.indexOf(ws.id);

  return h('div', { class: 'ws-edit' },
    h('label', {}, h('span', {}, '名前'), name),
    h('label', {}, h('span', {}, '色'), colors),
    h('div', { class: 'row' }, h('span', { class: 'edit-label' }, 'アイコン'), icon),
    h('label', {}, h('span', {}, '使うセッション'), session),
    cookieInfo && !(cookieInfo.enabled && cookieInfo.permitted)
      ? h('div', { class: 'muted small', style: { margin: '-4px 0 4px' } }, 'Cookie の分離は OFF（セッションはラベルだけ）。ヘッダーの「セッション」から ON にできます')
      : null,
    h('label', {}, h('span', {}, 'ブックマーク'), folderSel),
    h('label', { title: '長期間使っていないタブを自動で閉じるか（設定画面の値をこのワークスペースだけ上書き）' }, h('span', {}, '自動クローズ'), acMode),
    ac?.enabled ? h('div', { class: 'row' }, h('span', { class: 'edit-label' }, '閉じるまで'), acValue, acUnit, h('span', { class: 'muted small' }, '（最後に使ってから）')) : null,
    h('div', { class: 'row' },
      h('button', {
        type: 'button', title: 'Workspaces フォルダの下にこのワークスペース用のフォルダを作って接続',
        onclick: () => attempt(async () => {
          await call('createFolderFor', { workspaceId: ws.id });
          folders = null;
          bmKey = '';
          await loadFolders();
        }),
      }, '新しいフォルダを作成して接続'),
    ),
    h('div', { class: 'row' },
      h('button', { type: 'button', disabled: idx <= 0, onclick: () => attempt(() => call('reorderWorkspace', { id: ws.id, toIndex: idx - 1 })) }, '↑'),
      h('button', { type: 'button', disabled: idx >= order.length - 1, onclick: () => attempt(() => call('reorderWorkspace', { id: ws.id, toIndex: idx + 1 })) }, '↓'),
      h('span', { class: 'grow' }),
      confirmButton('削除', '本当に削除？', () => attempt(async () => {
        await call('deleteWorkspace', { id: ws.id });
        editingId = null;
        if (selectedId === ws.id) selectedId = null;
        toast('削除しました（ブックマークフォルダは残っています）');
      })),
    ),
  );
}

function renderList() {
  const { state, bindings } = data;
  const list = $('list');
  if (!state.workspaceOrder.length) {
    list.replaceChildren(h('div', { class: 'empty' }, 'ワークスペースがありません。右上の ＋ から作成してください。'));
    return;
  }
  const showSession = state.sessionOrder.length > 1;
  list.replaceChildren(...state.workspaceOrder.map((id, index) => {
    const ws = state.workspaces[id];
    const openIn = windowOf(id);
    const here = bindings[windowId] === id;
    const head = h('div', {
      class: 'ws-head row',
      title: here ? 'このウィンドウで開いています' : openIn != null ? 'クリックで開いているウィンドウへ移動' : 'クリックでこのウィンドウに開く',
      onclick: () => onRowClick(id),
    },
      workspaceHotkey(index) ? h('span', { class: 'badge hotkey', title: `${workspaceHotkey(index)} キーで切替（Shift で新しいウィンドウ）` }, workspaceHotkey(index)) : null,
      wsIcon(ws),
      h('span', { class: 'grow ellipsis' }, ws.name),
      showSession ? h('span', { class: 'ws-session', title: `使うセッション: ${sessionName(ws.sessionId)}` }, sessionName(ws.sessionId)) : null,
      ws.bookmarkFolderId ? h('span', { class: 'muted small', title: 'ブックマークフォルダ接続済み' }, '★') : null,
      here ? h('span', { class: 'badge here', title: 'このウィンドウ' }, 'ここ')
        : openIn != null ? h('span', { class: 'badge', title: '別ウィンドウで開いている' }, '別') : null,
      h('span', { class: 'muted small', title: '保存されているタブ数' }, `${ws.tabs.length}`),
    );
    makeTabDropTarget(head, () => data.state?.workspaces[id] || null);
    // 行をドラッグして並び替え（issue #25）。落とす位置の線は行の外枠（.ws）に出す
    const wrap = h('div', { class: `ws${here ? ' current' : ''}${selectedId === id ? ' sel' : ''}` }, head);
    makeWorkspaceDraggable(head, id);
    makeWorkspaceDropTarget(head, id, wrap);
    return wrap;
  }));
}

function entryRow({ url, title, sub, extra, active, discarded, onOpen, onClose, closeTitle = 'タブを閉じる' }) {
  return h('div', {
    class: `entry${active ? ' on' : ''}${discarded ? ' discarded' : ''}`,
    title: url || '',
    onclick: () => onOpen && attempt(onOpen),
  },
    url ? fav(url) : null,
    h('span', { class: 'title ellipsis' }, title || url || '（無題）'),
    sub ? h('span', { class: 'host muted small ellipsis' }, sub) : null,
    extra || null,
    onClose ? h('button', {
      class: 'icon close', type: 'button', title: closeTitle,
      onclick: (e) => { e.stopPropagation(); attempt(onClose); },
    }, '×') : null,
  );
}

// ---- 開いているタブのドラッグ＆ドロップでブックマーク登録 ----

// ドラッグを始めた行の click（そのタブへ移動）を 1 回だけ無視する。次の mousedown で解除
let suppressRowClick = false;
document.addEventListener('mousedown', () => { suppressRowClick = false; }, true);

/** 開いているタブの行をドラッグ可能にする（ブックマーク一覧・ワークスペース行・Chrome のブックマークバーへ落とせる） */
function makeTabDraggable(row, tab) {
  const url = tabUrl(tab);
  if (!url) return row;
  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    suppressRowClick = true;
    const dt = e.dataTransfer;
    dt.effectAllowed = 'copy';
    dt.setData(TAB_DRAG_TYPE, JSON.stringify({ url, title: tab.title || url, tabId: tab.id }));
    dt.setData('text/uri-list', url);
    dt.setData('text/plain', url);
  });
  row.addEventListener('dragend', clearDropTargets);
  // 対象要素上の capture リスナーは onclick より先に呼ばれる
  row.addEventListener('click', (e) => {
    if (!suppressRowClick) return;
    suppressRowClick = false;
    e.stopImmediatePropagation();
  }, true);
  return row;
}

function hasTabDrag(e) {
  return !!e.dataTransfer && [...e.dataTransfer.types].includes(TAB_DRAG_TYPE);
}

function clearDropTargets() {
  for (const el of document.querySelectorAll('.drop-target, .drop-reject')) el.classList.remove('drop-target', 'drop-reject');
}

/**
 * el をタブのドロップ先にする。getWs(): ドロップ先のワークスペース（null なら受け付けない）。
 * 接続フォルダが無いワークスペースはドロップを受けてトーストで理由を出す。
 */
function makeTabDropTarget(el, getWs) {
  el.addEventListener('dragover', (e) => {
    if (!hasTabDrag(e)) return;
    const ws = getWs();
    if (!ws) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    el.classList.toggle('drop-target', !!ws.bookmarkFolderId);
    el.classList.toggle('drop-reject', !ws.bookmarkFolderId);
  });
  el.addEventListener('dragleave', (e) => {
    // 子要素間の移動では外さない（ハイライトの点滅防止）
    if (e.relatedTarget && el.contains(e.relatedTarget)) return;
    el.classList.remove('drop-target', 'drop-reject');
  });
  el.addEventListener('drop', (e) => {
    if (!hasTabDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    clearDropTargets();
    const ws = getWs();
    const item = parseTabDragData((type) => e.dataTransfer.getData(type));
    if (ws && item) attempt(() => dropTabInto(ws, item));
  });
}

async function dropTabInto(ws, { url, title }) {
  if (!ws.bookmarkFolderId) {
    toast('このワークスペースにはブックマークフォルダが接続されていません', true);
    return;
  }
  if (!isBookmarkableUrl(url)) {
    toast('このページはブックマークに保存できません', true);
    return;
  }
  const res = await call('addBookmarkToWorkspace', { workspaceId: ws.id, url, title });
  toast(res.created ? `${res.workspaceName} に保存しました` : `${res.workspaceName} に保存済みです`);
}

function renderBookmarks() {
  const ws = data.state.workspaces[selectedId];
  const body = $('bookmarks');
  $('bmTitle').textContent = 'ブックマーク';
  if (!ws) {
    body.replaceChildren(h('div', { class: 'empty' }, '左のワークスペースを選ぶと、接続フォルダのブックマークを表示します。'));
    return;
  }
  if (!ws.bookmarkFolderId) {
    body.replaceChildren(h('div', { class: 'empty' },
      'ブックマークフォルダが未接続です。',
      h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '8px' } },
        h('button', {
          type: 'button',
          onclick: () => attempt(async () => {
            await call('createFolderFor', { workspaceId: ws.id });
            bmKey = '';
            folders = null;
          }),
        }, 'フォルダを作成して接続'),
      ),
    ));
    return;
  }
  const bookmarks = detail.bookmarks;
  if (bookmarks === undefined) {
    body.replaceChildren(h('div', { class: 'empty' }, '読み込み中…'));
    return;
  }
  if (!bookmarks || bookmarks.error) {
    body.replaceChildren(h('div', { class: 'empty' }, bookmarks?.error || 'フォルダが見つかりません。'));
    return;
  }
  $('bmTitle').textContent = `ブックマーク（${bookmarks.items.length}）`;
  const openWin = windowOf(ws.id);
  const lead = openWin == null
    ? 'このワークスペースは開いていません。行を開くと、この 1 件だけを現在のウィンドウで開きます。'
    : openWin !== windowId
      ? '別ウィンドウで開いています。行を開くとそのウィンドウでこの 1 件を開きます。'
      : '';
  if (!bookmarks.items.length) {
    const nodes = [];
    if (lead) nodes.push(h('div', { class: 'hint' }, lead));
    nodes.push(h('div', { class: 'empty' }, `「${bookmarks.title}」は空です。`));
    body.replaceChildren(...nodes);
    return;
  }
  const groups = [];
  const map = new Map();
  for (const it of bookmarks.items) {
    const key = it.path || '';
    if (!map.has(key)) {
      map.set(key, []);
      groups.push(key);
    }
    map.get(key).push(it);
  }
  const nodes = [];
  if (lead) nodes.push(h('div', { class: 'hint' }, lead));
  if (bookmarks.title) nodes.push(h('div', { class: 'hint' }, bookmarks.title));
  for (const key of groups) {
    if (key || groups.length > 1) nodes.push(h('div', { class: 'group-label' }, key || '直下'));
    for (const it of map.get(key)) {
      nodes.push(entryRow({
        url: it.url,
        title: it.title,
        sub: hostOf(it.url),
        onOpen: () => openSingle(it.url),
      }));
    }
  }
  body.replaceChildren(...nodes);
}

// 開いているタブをブックマーク一覧へドロップ → 選択中ワークスペースの接続フォルダに登録
makeTabDropTarget($('bookmarks'), () => {
  const ws = data.state?.workspaces[selectedId];
  return ws?.bookmarkFolderId ? ws : null;
});

function renderTabs() {
  const view = detail.tabsView;
  const body = $('tabs');
  const ws = data.state.workspaces[selectedId];
  if (!view) {
    $('tabTitle').textContent = 'タブ';
    body.replaceChildren(h('div', { class: 'empty' }, '読み込み中…'));
    return;
  }
  if (view.mode === 'saved') {
    const tabs = view.tabs || [];
    $('tabTitle').textContent = `保存済みのタブ（${tabs.length}）`;
    if (!tabs.length) {
      body.replaceChildren(h('div', { class: 'empty' }, '保存されているタブはありません。'));
      return;
    }
    const nodes = [h('div', { class: 'hint' }, 'まだ開いていません。行を開くと、この 1 件だけを現在のウィンドウで開きます。色の付いた行は、ワークスペースを開いたときに前面になるタブです。')];
    let lastGroup;
    for (const t of tabs) {
      if (t.groupKey !== lastGroup) {
        lastGroup = t.groupKey;
        if (t.groupKey) nodes.push(h('div', { class: 'group-label' }, view.groups?.[t.groupKey]?.title || 'グループ'));
      }
      nodes.push(entryRow({
        url: t.url,
        title: (t.pinned ? '📌 ' : '') + (t.title || t.url),
        sub: hostOf(t.url),
        active: !!t.active,
        onOpen: () => openSingle(t.url),
      }));
    }
    body.replaceChildren(...nodes);
    return;
  }

  const tabs = [...(view.tabs || [])]
    .filter((t) => !isManagerUrl(tabUrl(t)) && !isWorkspaceTabUrl(tabUrl(t)))
    .sort((a, b) => a.index - b.index);
  const groupById = Object.fromEntries((view.groups || []).map((g) => [g.id, g]));
  $('tabTitle').textContent = `開いているタブ（${tabs.length}）`;
  if (!tabs.length) {
    body.replaceChildren(h('div', { class: 'empty' }, '開いているタブはありません。'));
    return;
  }
  const nodes = [];
  if (!ws) nodes.push(h('div', { class: 'hint' }, 'このウィンドウで開いているタブです。'));
  else if (view.windowId !== windowId) nodes.push(h('div', { class: 'hint' }, '別ウィンドウで開いています。行を開くとそのタブへ移動します。'));
  let lastGroup;
  for (const t of tabs) {
    const gid = t.groupId ?? -1;
    if (gid !== lastGroup) {
      lastGroup = gid;
      if (gid !== -1) nodes.push(h('div', { class: 'group-label' }, groupById[gid]?.title || 'グループ'));
    }
    const url = tabUrl(t);
    // 自動クローズの除外（issue #20）: 除外中ならバッジ（クリックで解除）、そうでなければ追加ボタン（行にマウスを乗せると出る）
    const excluded = autoCloseExcludeMatch(url, data.state.settings.autoCloseExclude);
    const exclude = excluded
      ? h('span', {
        class: 'badge excl', title: `自動クローズの対象外（除外パターン: ${excluded}）。クリックで解除`,
        onclick: (e) => { e.stopPropagation(); removeExclude(excluded); },
      }, '除外')
      : url ? h('button', {
        class: 'icon excl', type: 'button', title: '自動クローズから除外（このページ / このサイト全体）',
        onclick: (e) => { e.stopPropagation(); openExcludeDialog(t); },
      }, '🛡') : null;
    nodes.push(makeTabDraggable(entryRow({
      url,
      title: (t.pinned ? '📌 ' : '') + (t.title || url || '新しいタブ'),
      sub: t.discarded ? '休止中' : hostOf(url),
      extra: exclude,
      active: t.active,
      discarded: t.discarded,
      onOpen: () => focusTab(t),
      onClose: async () => { await chrome.tabs.remove(t.id); },
    }), t));
  }
  body.replaceChildren(...nodes);
}

// ---- モーダル: ワークスペース作成 ----

let createIcon = '';

/** 作成モーダルのフォルダ選択肢: 新規作成 / 接続しない / 既存フォルダ（読み込み後に追記） */
function fillCreateFolderOptions() {
  const sel = $('createFolder');
  const keep = sel.value;
  sel.replaceChildren(
    h('option', { value: 'new' }, '新しいフォルダを作成して接続'),
    h('option', { value: '' }, '接続しない'),
  );
  if (folders) {
    const group = h('optgroup', { label: '既存のフォルダを接続' }, folders.map((f) => h('option', { value: f.id }, f.path)));
    sel.append(group);
  } else {
    sel.append(h('option', { value: 'loading', disabled: true }, '既存のフォルダを読み込み中…'));
    attempt(async () => {
      await loadFolders();
      if ($('createDialog').open) fillCreateFolderOptions();
    });
  }
  sel.value = [...sel.options].some((o) => o.value === keep && !o.disabled) ? keep : 'new';
}

function openCreateDialog({ keepTabs = false } = {}) {
  const { state, bindings } = data;
  const current = state.workspaces[bindings[windowId]];
  const defaultSession = current?.sessionId || state.workspaces[state.lastFocusedWorkspaceId]?.sessionId || state.sessionOrder[0];
  $('createSession').replaceChildren(...state.sessionOrder.map((id) =>
    h('option', { value: id, selected: id === defaultSession }, state.sessions[id].name)));
  $('createName').value = '';
  createIcon = '';
  $('createIcon').replaceChildren(iconPicker('', (v) => { createIcon = v; }));
  fillCreateFolderOptions();
  $('createFolder').value = 'new';
  const unassigned = !bindings[windowId];
  $('createKeepRow').hidden = !unassigned;
  $('createKeep').checked = unassigned && keepTabs;
  $('createHint').textContent = unassigned
    ? ''
    : '作成後、このウィンドウを新しいワークスペースに切り替えます（今のタブは現在のワークスペースに保存されます）。';
  $('createDialog').showModal();
  $('createName').focus();
}

$('createOpen').addEventListener('click', () => openCreateDialog());
$('createCancel').addEventListener('click', () => $('createDialog').close());
$('createForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('createName').value.trim();
  if (!name) {
    $('createName').focus();
    return;
  }
  const sessionId = $('createSession').value;
  const folderChoice = $('createFolder').value;
  const folderOpts = folderChoice === 'new' ? { createFolder: true } : { bookmarkFolderId: folderChoice || null };
  const icon = createIcon;
  const keep = !data.bindings[windowId] && $('createKeep').checked;
  $('createDialog').close();
  const create = async () => {
    const { workspaceId, cookieSession } = await call('createWorkspace', keep
      ? { name, sessionId, icon, ...folderOpts, fromWindowId: windowId }
      : { name, sessionId, icon, ...folderOpts, switchTo: true, windowId });
    selectedId = workspaceId;
    editingId = null;
    folders = null;
    bmKey = '';
    toast(keep
      ? (cookieSession ? `「${name}」として保存し、Cookie をセッション「${cookieSession.toName}」に入れ替えました` : `「${name}」として保存しました`)
      : `「${name}」を作成しました`);
    return windowId;
  };
  // 今のタブを引き継ぐだけなら移動しないのでパネルは開いたまま。新しいワークスペースへ切り替えるときは切替後に閉じる
  attempt(() => (keep ? create() : moveAway(create)));
});

// ---- モーダル: セッション管理 ----

async function renderSessionDialog() {
  const { state } = data;
  const list = $('sessionList');
  // Cookie の分離の状態（issue #12）。取れなくても一覧は出す
  let cookie = null;
  try {
    cookie = await call('getCookieStatus');
  } catch { /* 表示だけなので無視 */ }
  const isolating = !!(cookie?.enabled && cookie.permitted);
  $('sessionCookieNote').textContent = isolating
    ? `Cookie の分離: ON。別のセッションのワークスペースに切り替えると、Cookie（ログイン状態）をそのセッションのものに入れ替えます（全ウィンドウに及びます）。今の Cookie: 「${state.sessions[cookie.cookieSessionId]?.name || '不明'}」`
    : (cookie?.enabled && !cookie.permitted
      ? 'Cookie の分離: 設定は ON ですが権限が無いため働いていません。「権限を許可して ON にする」で許可し直してください。'
      : 'Cookie の分離: OFF（セッションはラベルだけです）。ON にすると、セッションごとに Cookie（ログイン状態）を分けて使えます。今 Chrome に入っている Cookie は、このウィンドウのワークスペースのセッションのものになります。');
  $('sessionCookieToggleSlot').replaceChildren(cookie ? cookieToggleButton(cookie, isolating) : '');
  const cookieBadge = (id) => {
    if (!isolating) return null;
    if (id === cookie.cookieSessionId) return h('span', { class: 'badge here', title: '今 Chrome に入っている Cookie はこのセッションのものです' }, '🍪 今の Cookie');
    const jar = cookie.jars[id];
    return h('span', { class: 'muted small', title: jar ? `退避した Cookie: ${jar.count} 件（${new Date(jar.savedAt).toLocaleString()}）` : '退避した Cookie はありません（切り替えると未ログインの状態から始まります）' },
      jar ? `🍪 ${jar.count}` : '🍪 なし');
  };
  list.replaceChildren(...state.sessionOrder.map((id) => {
    const s = state.sessions[id];
    const users = workspacesUsingSession(state, id);
    const name = h('input', { type: 'text', value: s.name, title: '名前を変更' });
    name.addEventListener('change', () => attempt(() => call('renameSession', { id, name: name.value })));
    return h('div', { class: 'sess-row' },
      name,
      cookieBadge(id),
      h('span', { class: 'muted small', title: users.map((w) => state.workspaces[w].name).join('\n') || 'このセッションを使うワークスペースはありません' },
        `${users.length} WS`),
      h('button', {
        type: 'button', disabled: !users.length, title: 'このセッションを使う全ワークスペースをそれぞれ別ウィンドウで開く',
        onclick: () => attempt(() => moveAway(() => call('openSessionWindows', { sessionId: id }))),
      }, '全て開く'),
      confirmButton('削除', '本当に削除？', () => attempt(async () => {
        const res = await call('deleteSession', { id });
        toast(res?.cookieSession
          ? `削除しました（Cookie をセッション「${res.cookieSession.toName}」に入れ替え、ワークスペースも付け替えました）`
          : '削除しました（使っていたワークスペースは別のセッションに付け替えました）');
      }), { disabled: state.sessionOrder.length <= 1, title: state.sessionOrder.length <= 1 ? '最後のセッションは削除できません' : (isolating ? '削除（ワークスペースは消えません。退避した Cookie は消えます）' : '削除（ワークスペースは消えません）') }),
    );
  }));
}

/** セッション管理の「Cookie の分離を ON / OFF にする」。ON は権限の要求を伴うので、クリックの直後に permissions.request を呼ぶ */
function cookieToggleButton(cookie, isolating) {
  if (isolating) {
    return confirmButton('Cookie の分離を OFF にする', '本当に OFF？', () => attempt(async () => {
      await call('setCookieIsolation', { enabled: false });
      toast('Cookie の分離を OFF にしました（退避した Cookie は残しています）');
      await renderSessionDialog();
    }), { title: '権限を返上します。退避した Cookie は残るので、再度 ON にすれば続きから使えます' });
  }
  const label = cookie.enabled && !cookie.permitted ? '権限を許可して ON にする' : 'Cookie の分離を ON にする';
  return h('button', {
    type: 'button', class: 'primary', title: 'Cookie を読み書きする権限（すべてのサイト）の確認が出ます',
    onclick: () => attempt(async () => {
      // 権限ダイアログでパネルがフォーカスを失っても閉じない（閉じるとリクエストごと消える）
      const granted = await holdPanel(() => chrome.permissions.request(COOKIE_PERMISSION));
      if (!granted) {
        toast('権限が許可されなかったため ON にできません', true);
        return;
      }
      // 今 Chrome に入っている Cookie は、このウィンドウのワークスペースのセッション（無ければ最後に使ったワークスペースのセッション）のものとして扱う
      const sessionId = data.state.workspaces[data.bindings[windowId]]?.sessionId;
      const res = await call('setCookieIsolation', { enabled: true, sessionId });
      toast(`Cookie の分離を ON にしました。今の Cookie はセッション「${data.state.sessions[res.cookieSessionId]?.name || ''}」のものです`);
      await renderSessionDialog();
    }),
  }, label);
}

$('sessions').addEventListener('click', () => {
  renderSessionDialog();
  $('sessionDialog').showModal();
  $('sessionName').focus();
});
$('sessionClose').addEventListener('click', () => $('sessionDialog').close());
$('sessionAdd').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('sessionName').value.trim();
  if (!name) return;
  $('sessionName').value = '';
  attempt(async () => {
    await call('createSession', { name });
    // 入力欄にフォーカスが残っていると render() が後回しになるので、一覧だけ即時に描き直す
    data = await call('getState');
    renderSessionDialog();
    toast(`セッション「${name}」を追加しました`);
  });
});

// ---- モーダル: 自動クローズで閉じたタブの履歴 ----

let closedTabs = []; // 新しい順（storage.local の closedTabs）

function updateClosedCount() {
  $('closedTabs').textContent = closedTabs.length ? `閉じたタブ (${closedTabs.length})` : '閉じたタブ';
}

async function loadClosedTabs() {
  closedTabs = await call('listClosedTabs');
  updateClosedCount();
  if ($('closedDialog').open) renderClosedDialog();
}

/** 履歴から 1 件を開き直す。開けたら履歴から消す（開くのに失敗したら残す）。完了後にパネルを閉じる */
function reopenClosed(entry) {
  return moveAway(async () => {
    await openUrlIn(entry.url, entry.workspaceId);
    await call('removeClosedTab', { id: entry.id });
    return null; // フォーカスは openUrlIn が移す
  });
}

function closedRow(entry) {
  const wsName = data.state?.workspaces[entry.workspaceId]?.name || entry.workspaceName;
  return entryRow({
    url: entry.url,
    title: entry.title,
    sub: hostOf(entry.url),
    extra: [
      wsName ? h('span', { class: 'ws-session', title: `ワークスペース: ${wsName}` }, wsName) : null,
      h('span', { class: 'time muted small', title: new Date(entry.closedAt).toLocaleString() }, formatClockTime(entry.closedAt)),
    ],
    onOpen: () => reopenClosed(entry),
    onClose: () => call('removeClosedTab', { id: entry.id }),
    closeTitle: '履歴から削除',
  });
}

const closedClearBtn = confirmButton('すべて削除', '本当に削除？', () => attempt(async () => {
  await call('clearClosedTabs');
  toast('閉じたタブの履歴を削除しました');
}), { title: '閉じたタブの履歴をすべて削除' });
$('closedClearSlot').append(closedClearBtn);
$('closedDesc').textContent = `自動クローズで閉じたタブです。最大 ${CLOSED_TABS_MAX} 件（古いものから消えます）。クリックで開き直します。`;

/** 一覧だけを描き直す（検索ボックスの入力・フォーカスは保つ） */
function renderClosedDialog() {
  closedClearBtn.disabled = !closedTabs.length;
  const q = $('closedSearch').value;
  const items = closedTabs.filter((e) => matchesQuery(`${e.title || ''} ${e.url || ''}`, q));
  const list = $('closedList');
  if (!items.length) {
    list.replaceChildren(h('div', { class: 'empty' }, closedTabs.length ? '一致する閉じたタブはありません' : '自動で閉じたタブはありません'));
    return;
  }
  const now = Date.now();
  const nodes = [];
  let label = null;
  for (const e of items) {
    const l = closedDayLabel(e.closedAt, now);
    if (l !== label) {
      label = l;
      nodes.push(h('div', { class: 'group-label' }, l));
    }
    nodes.push(closedRow(e));
  }
  list.replaceChildren(...nodes);
}

$('closedTabs').addEventListener('click', () => attempt(async () => {
  $('closedSearch').value = '';
  renderClosedDialog();
  $('closedDialog').showModal();
  $('closedSearch').focus();
  await loadClosedTabs();
}));
$('closedClose').addEventListener('click', () => $('closedDialog').close());
$('closedSearch').addEventListener('input', () => renderClosedDialog());

// ---- モーダル: 自動クローズから除外（issue #20） ----

let excludeCandidates = { page: '', site: null };

/** 開いているタブの 🛡 から。このページ / このサイト全体のどちらかを選び、必要なら書き換えて除外リストに追加する */
function openExcludeDialog(tab) {
  const url = tabUrl(tab);
  excludeCandidates = excludePatternsForUrl(url);
  $('excludeTab').textContent = tab.title || url;
  $('excludeTab').title = url;
  const site = $('excludeDialog').querySelector('input[name=excludeKind][value=site]');
  site.disabled = !excludeCandidates.site;
  $('excludeDialog').querySelector('input[name=excludeKind][value=page]').checked = true;
  $('excludeValue').value = excludeCandidates.page;
  $('excludeDialog').showModal();
  $('excludeValue').focus();
}

/** 既に除外されているタブのバッジから、その除外パターンを外す */
function removeExclude(pattern) {
  return attempt(async () => {
    await call('removeAutoCloseExclude', { pattern });
    toast(`除外を解除しました: ${pattern}`);
  });
}

for (const r of $('excludeDialog').querySelectorAll('input[name=excludeKind]')) {
  r.addEventListener('change', () => { if (r.checked) $('excludeValue').value = excludeCandidates[r.value] || ''; });
}
$('excludeCancel').addEventListener('click', () => $('excludeDialog').close());
$('excludeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const pattern = $('excludeValue').value.trim();
  if (!pattern) { toast('除外する URL を入力してください', true); return; }
  attempt(async () => {
    const res = await call('addAutoCloseExclude', { pattern });
    $('excludeDialog').close();
    toast(res.added ? `自動クローズから除外: ${res.pattern}` : '既に除外リストにあります');
  });
});

// ---- ワークスペースの並び替え: ドラッグ＆ドロップ（issue #25） ----

// ドラッグ中のワークスペース ID。dragover 中は dataTransfer の中身が読めないので控えておく
let draggingWsId = null;

function hasWorkspaceDrag(e) {
  return !!e.dataTransfer && [...e.dataTransfer.types].includes(WORKSPACE_DRAG_TYPE);
}

function clearReorderMarks() {
  for (const el of document.querySelectorAll('.drop-before, .drop-after')) el.classList.remove('drop-before', 'drop-after');
}

/**
 * el をワークスペース id のドラッグ元にする。handle を渡すとそこを押した時だけドラッグできる（入力欄のある行用）。
 * ドラッグを始めた行の click（切替）は 1 回だけ無視する
 */
function makeWorkspaceDraggable(el, id, handle = null) {
  if (handle) {
    el.draggable = false;
    handle.addEventListener('mousedown', () => { el.draggable = true; });
    handle.addEventListener('mouseup', () => { el.draggable = false; });
  } else {
    el.draggable = true;
  }
  el.addEventListener('dragstart', (e) => {
    suppressRowClick = true;
    draggingWsId = id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(WORKSPACE_DRAG_TYPE, JSON.stringify({ id }));
    el.classList.add('dragging');
  });
  // ドラッグ直後に click が届いても切替しない（タブの行と同じ仕組み）
  el.addEventListener('click', (e) => {
    if (!suppressRowClick) return;
    suppressRowClick = false;
    e.stopImmediatePropagation();
  }, true);
  el.addEventListener('dragend', () => {
    draggingWsId = null;
    el.classList.remove('dragging');
    if (handle) el.draggable = false;
    clearReorderMarks();
  });
  return el;
}

/** ドロップ位置（行の前 / 後）から並び替え先の index を求める。並びが変わらないなら null */
function reorderTargetIndex(e, el, draggedId, targetId) {
  const r = el.getBoundingClientRect();
  return reorderDropIndex(data.state?.workspaceOrder || [], draggedId, targetId, dropPlacement(e.clientY - r.top, r.height));
}

/**
 * el をワークスペース id の行として、他のワークスペースのドロップ先にする。
 * 上半分に落とすとその行の前、下半分なら後ろへ。印（線）は mark（省略時は el）に付ける
 */
function makeWorkspaceDropTarget(el, id, mark = el) {
  el.addEventListener('dragover', (e) => {
    if (!hasWorkspaceDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = el.getBoundingClientRect();
    const placement = dropPlacement(e.clientY - r.top, r.height);
    const toIndex = draggingWsId ? reorderTargetIndex(e, el, draggingWsId, id) : null;
    mark.classList.toggle('drop-before', toIndex !== null && placement === 'before');
    mark.classList.toggle('drop-after', toIndex !== null && placement === 'after');
  });
  el.addEventListener('dragleave', (e) => {
    if (e.relatedTarget && el.contains(e.relatedTarget)) return;
    mark.classList.remove('drop-before', 'drop-after');
  });
  el.addEventListener('drop', (e) => {
    if (!hasWorkspaceDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    clearReorderMarks();
    const dragged = parseWorkspaceDragData((t) => e.dataTransfer.getData(t));
    if (!dragged) return;
    const toIndex = reorderTargetIndex(e, el, dragged, id);
    if (toIndex === null) return;
    attempt(() => call('reorderWorkspace', { id: dragged, toIndex }));
  });
  return el;
}

// ---- モーダル: ワークスペースの管理（一覧で編集・一括変更・並び替え・削除。issue #25） ----

const manageSelected = new Set(); // チェックを入れたワークスペース ID
let manageExpandId = null; // 「外観」（色・アイコン）を開いている行

/** 行ごとの「自動クローズ」: 設定に従う（null）/ 無効 / 有効（期間） */
function autoCloseControls(ws, { onSave, inline = true }) {
  const { state } = data;
  const globalAc = state.settings.autoClose || { enabled: false, days: 7 };
  const ac = ws?.autoClose || null;
  const acDaysValue = ac?.days ?? globalAc.days;
  const mode = h('select', { title: 'タブの自動クローズ（設定画面の値をこのワークスペースだけ上書き）' },
    h('option', { value: '', selected: !ac }, `設定に従う（${globalAc.enabled ? `有効・${formatAutoCloseDuration(globalAc.days)}` : '無効'}）`),
    h('option', { value: 'off', selected: !!ac && !ac.enabled }, '無効'),
    h('option', { value: 'on', selected: !!ac?.enabled }, '有効'));
  const dur = autoCloseDuration(acDaysValue);
  const value = h('input', { type: 'number', min: '1', step: '1', value: String(dur.value), style: { width: '64px' }, title: '閉じるまでの期間（最後に使ってから）' });
  const unit = h('select', { title: '単位' }, ...Object.entries(AUTO_CLOSE_UNIT_LABELS).map(([v, label]) =>
    h('option', { value: v, selected: v === dur.unit }, label)));
  const durationBox = h('span', { class: 'row ac-duration', hidden: !ac?.enabled }, value, unit);
  const read = () => {
    if (!mode.value) return null;
    if (mode.value === 'off') return { enabled: false, days: acDaysValue };
    const days = autoCloseDaysFrom(value.value, unit.value);
    if (days === null) {
      toast('期間は 15 分以上で入力してください', true);
      value.value = String(dur.value);
      unit.value = dur.unit;
      return undefined;
    }
    return { enabled: true, days };
  };
  const commit = () => {
    const v = read();
    if (v !== undefined) onSave(v);
  };
  mode.addEventListener('change', () => {
    durationBox.hidden = mode.value !== 'on';
    // フォーカスが残っていると一覧の描き直しが後回しになるので外す
    if (inline) mode.blur();
    commit();
  });
  value.addEventListener('change', commit);
  unit.addEventListener('change', commit);
  return { box: h('span', { class: 'row ac-controls' }, mode, durationBox), read };
}

function manageRow(ws, index) {
  const { state, bindings } = data;
  const here = bindings[windowId] === ws.id;
  const openIn = windowOf(ws.id);
  const save = (patch) => attempt(() => call('updateWorkspace', { id: ws.id, patch }));

  const grip = h('span', { class: 'mg-grip', title: 'ドラッグで並び替え' }, '⋮⋮');
  const check = h('input', { type: 'checkbox', checked: manageSelected.has(ws.id), title: '一括変更の対象にする' });
  check.addEventListener('change', () => {
    if (check.checked) manageSelected.add(ws.id); else manageSelected.delete(ws.id);
    syncManageBulk();
  });
  const look = h('button', {
    type: 'button', class: 'icon mg-look', title: '色・アイコンを変更',
    onclick: () => { manageExpandId = manageExpandId === ws.id ? null : ws.id; renderManageDialog(); },
  }, wsIcon(ws), h('span', { class: 'muted small' }, manageExpandId === ws.id ? '▲' : '▼'));
  const name = h('input', { type: 'text', class: 'mg-name', value: ws.name, title: '名前（Enter または他へ移動で保存）' });
  name.addEventListener('change', () => {
    const v = name.value.trim();
    if (!v) { name.value = ws.name; return; }
    save({ name: v });
  });
  const session = h('select', { class: 'mg-session', title: '使うセッション' }, state.sessionOrder.map((id) =>
    h('option', { value: id, selected: id === ws.sessionId }, state.sessions[id].name)));
  session.addEventListener('change', () => {
    session.blur();
    attempt(async () => {
      const res = await call('updateWorkspace', { id: ws.id, patch: { sessionId: session.value } });
      if (res?.cookieSession) toast(`「${ws.name}」のセッションを変え、Cookie を入れ替えてページを読み込み直しました`);
    });
  });
  const ac = autoCloseControls(ws, { onSave: (autoClose) => save({ autoClose }) });
  const status = here ? h('span', { class: 'badge here', title: 'このウィンドウで開いています' }, 'ここ')
    : openIn != null ? h('span', { class: 'badge', title: '別ウィンドウで開いています' }, '別') : null;
  const del = confirmButton('削除', '本当に削除？', () => attempt(async () => {
    await call('deleteWorkspace', { id: ws.id });
    manageSelected.delete(ws.id);
    if (selectedId === ws.id) selectedId = null;
    if (editingId === ws.id) editingId = null;
    toast(`「${ws.name}」を削除しました（ブックマークフォルダは残っています）`);
  }), { class: 'danger icon', title: '削除（ブックマークフォルダは残ります）' });

  const row = h('div', { class: `mg-row${manageSelected.has(ws.id) ? ' sel' : ''}` },
    grip,
    check,
    h('span', { class: 'badge hotkey', title: '一覧での番号' }, workspaceHotkey(index) || String(index + 1)),
    look,
    name,
    session,
    ac.box,
    h('span', { class: 'muted small mg-tabs', title: '保存されているタブ数' }, `${ws.tabs.length} タブ`),
    status,
    del,
  );
  makeWorkspaceDraggable(row, ws.id, grip);
  makeWorkspaceDropTarget(row, ws.id);
  if (manageExpandId !== ws.id) return [row];

  const colors = h('div', { class: 'colors' }, COLORS.map((c) => h('span', {
    class: 'dot' + (c === ws.color ? ' sel' : ''), title: c, style: { background: COLOR_HEX[c] },
    onclick: () => save({ color: c }),
  })));
  const icon = iconPicker(ws.icon, (v) => save({ icon: v }));
  const expand = h('div', { class: 'mg-expand' },
    h('div', { class: 'row' }, h('span', { class: 'edit-label' }, '色'), colors),
    h('div', { class: 'row' }, h('span', { class: 'edit-label' }, 'アイコン'), icon),
  );
  return [row, expand];
}

/** 一括変更バーの件数表示・ボタンの有効 / 無効 */
function syncManageBulk() {
  const n = [...manageSelected].filter((id) => data.state?.workspaces[id]).length;
  const total = data.state?.workspaceOrder.length || 0;
  $('manageCount').textContent = n ? `${n} 件を選択中` : 'チェックした行に下の一括変更を適用します';
  $('manageAll').checked = total > 0 && n === total;
  $('manageAll').indeterminate = n > 0 && n < total;
  for (const el of $('manageDialog').querySelectorAll('.mg-bulk button, .mg-bulk select, .mg-bulk input')) {
    if (el.id !== 'manageAll') el.disabled = !n;
  }
  for (const row of $('manageList').querySelectorAll('.mg-row')) {
    const cb = row.querySelector('input[type=checkbox]');
    row.classList.toggle('sel', !!cb?.checked);
  }
}

let bulkAutoClose = null; // 一括変更の「自動クローズ」コントロール（描画のたびに作り直す）

function renderManageDialog() {
  const { state } = data;
  for (const id of [...manageSelected]) if (!state.workspaces[id]) manageSelected.delete(id);
  if (manageExpandId && !state.workspaces[manageExpandId]) manageExpandId = null;

  // 一括変更のセッション候補（選択中の値は保つ）
  const bs = $('bulkSession');
  const keepSession = bs.value;
  bs.replaceChildren(h('option', { value: '' }, 'セッションを選択…'),
    ...state.sessionOrder.map((id) => h('option', { value: id }, state.sessions[id].name)));
  bs.value = state.sessions[keepSession] ? keepSession : '';
  const bc = $('bulkColor');
  if (!bc.options.length) {
    bc.replaceChildren(h('option', { value: '' }, '色を選択…'),
      ...COLORS.map((c) => h('option', { value: c, style: { color: COLOR_HEX[c] } }, `● ${c}`)));
  }
  // 自動クローズは行と同じコントロール（期間付き）。入力中の値を保つため、開いた時に 1 度だけ作る
  if (!bulkAutoClose) {
    bulkAutoClose = autoCloseControls({ autoClose: null }, { onSave: () => {}, inline: false });
    $('bulkAutoCloseSlot').replaceChildren(bulkAutoClose.box);
  }

  const list = $('manageList');
  if (!state.workspaceOrder.length) {
    list.replaceChildren(h('div', { class: 'empty' }, 'ワークスペースがありません。'));
  } else {
    list.replaceChildren(...state.workspaceOrder.flatMap((id, index) => manageRow(state.workspaces[id], index)));
  }
  syncManageBulk();
}

/** チェックした行に patch を適用する */
function bulkApply(patch, label) {
  const ids = [...manageSelected].filter((id) => data.state.workspaces[id]);
  if (!ids.length) { toast('変更する行にチェックを入れてください', true); return; }
  attempt(async () => {
    const res = await call('updateWorkspaces', { ids, patch });
    toast(`${res.count} 件の${label}を変更しました${res.cookieSession ? '（Cookie を入れ替えてページを読み込み直しました）' : ''}`);
  });
}

$('manage').addEventListener('click', () => {
  manageExpandId = null;
  bulkAutoClose = null;
  renderManageDialog();
  $('manageDialog').showModal();
});
$('manageClose').addEventListener('click', () => $('manageDialog').close());
$('manageAll').addEventListener('change', () => {
  const all = data.state?.workspaceOrder || [];
  if ($('manageAll').checked) for (const id of all) manageSelected.add(id);
  else manageSelected.clear();
  for (const cb of $('manageList').querySelectorAll('.mg-row input[type=checkbox]')) cb.checked = $('manageAll').checked;
  syncManageBulk();
});
$('bulkSessionApply').addEventListener('click', () => {
  const sid = $('bulkSession').value;
  if (!sid) { toast('セッションを選んでください', true); return; }
  bulkApply({ sessionId: sid }, 'セッション');
});
$('bulkColorApply').addEventListener('click', () => {
  const c = $('bulkColor').value;
  if (!c) { toast('色を選んでください', true); return; }
  bulkApply({ color: c }, '色');
});
$('bulkAutoCloseApply').addEventListener('click', () => {
  const v = bulkAutoClose?.read();
  if (v === undefined) return;
  bulkApply({ autoClose: v }, '自動クローズ');
});
$('bulkDeleteSlot').append(confirmButton('選択を削除', '本当に削除？', () => {
  const ids = [...manageSelected].filter((id) => data.state.workspaces[id]);
  if (!ids.length) return;
  attempt(async () => {
    const res = await call('deleteWorkspaces', { ids });
    for (const id of ids) manageSelected.delete(id);
    if (ids.includes(selectedId)) selectedId = null;
    if (ids.includes(editingId)) editingId = null;
    toast(`${res.count} 件を削除しました（ブックマークフォルダは残っています）`);
  });
}, { title: 'チェックした行をまとめて削除（ブックマークフォルダは残ります）' }));

// ---- 描画 ----

let pendingRender = false;

function render() {
  if (!data.state) return;
  const a = document.activeElement;
  // 文字 / 数値の入力欄やセレクトを操作中は描き直さない（フォーカスが外れた時に描く）
  if (a && ((a.tagName === 'INPUT' && (a.type === 'text' || a.type === 'number')) || a.tagName === 'SELECT')) {
    pendingRender = true;
    return;
  }
  pendingRender = false;
  renderDetailHead();
  renderList();
  renderBookmarks();
  renderTabs();
  if ($('sessionDialog').open) renderSessionDialog();
  if ($('manageDialog').open) renderManageDialog();
}

document.addEventListener('focusout', () => {
  if (pendingRender) setTimeout(render, 0);
});

async function bookmarksFor(folderId) {
  if (bmKey === folderId && bmData !== undefined) return bmData;
  bmData = await call('listFolderBookmarks', { folderId });
  bmKey = folderId;
  return bmData;
}

async function refreshDetail() {
  if (!data.state || windowId == null) return;
  const seq = ++detailSeq;
  const ws = data.state.workspaces[selectedId];
  const openWin = ws ? windowOf(ws.id) : null;
  let tabsView;
  if (ws && openWin == null) {
    tabsView = { mode: 'saved', tabs: ws.tabs, groups: ws.groups || {} };
  } else {
    const wid = openWin ?? windowId;
    const [tabs, groups] = await Promise.all([
      chrome.tabs.query({ windowId: wid }),
      chrome.tabGroups.query({ windowId: wid }).catch(() => []),
    ]);
    tabsView = { mode: 'live', windowId: wid, tabs, groups };
  }
  let bookmarks = null;
  if (ws?.bookmarkFolderId) {
    try {
      bookmarks = await bookmarksFor(ws.bookmarkFolderId);
    } catch (e) {
      bookmarks = { error: e.message || String(e), items: [] };
    }
  }
  if (seq !== detailSeq) return;
  detail = { tabsView, bookmarks };
  render();
}

function scheduleDetail() {
  if (windowId == null) return;
  clearTimeout(detailTimer);
  detailTimer = setTimeout(() => attempt(refreshDetail), 80);
}

async function loadFolders() {
  if (folders) return;
  folders = await call('listFolders');
  render();
}

$('discard').addEventListener('click', () => attempt(async () => {
  const n = await call('discardInactive', { windowId });
  toast(`${n} 個のタブを休止しました`);
}));
$('options').addEventListener('click', () => attempt(() => moveAway(() => chrome.runtime.openOptionsPage())));
// パネルはポップアップウィンドウなので、windowId を指定して対象ウィンドウのタブとして開く
$('guide').addEventListener('click', () => attempt(() => moveAway(async () => {
  await chrome.tabs.create({ windowId, url: chrome.runtime.getURL('src/ui/guide.html') });
  return windowId;
})));

chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === 'local' && changes.state) || (area === 'session' && changes.bindings)) attempt(load);
  if (area === 'local' && changes.closedTabs) {
    const v = changes.closedTabs.newValue;
    closedTabs = Array.isArray(v) ? v : [];
    updateClosedCount();
    if ($('closedDialog').open) renderClosedDialog();
  }
});
chrome.bookmarks.onCreated.addListener(() => { bmKey = ''; folders = null; scheduleDetail(); });
chrome.bookmarks.onRemoved.addListener(() => { bmKey = ''; folders = null; scheduleDetail(); });
chrome.bookmarks.onChanged.addListener(() => { bmKey = ''; folders = null; scheduleDetail(); });
chrome.bookmarks.onMoved.addListener(() => { bmKey = ''; folders = null; scheduleDetail(); });
for (const ev of ['onCreated', 'onRemoved', 'onUpdated', 'onMoved', 'onActivated']) {
  chrome.tabs[ev].addListener(() => scheduleDetail());
}

// ---- 検索ボックス: ワークスペース / 全ワークスペースのブックマーク / 閲覧履歴 ----

let allBm = null; // listWorkspaceBookmarks のキャッシュ（ブックマーク変更・接続変更で破棄）
let allBmKey = '';
let searchItems = []; // { el, run(shift) }
let searchSel = 0;
let searchSeq = 0;
let searchTimer = 0;

async function allBookmarks() {
  if (!allBm) allBm = await call('listWorkspaceBookmarks');
  return allBm;
}

/** 接続フォルダの組み合わせが変わったらブックマークのキャッシュを捨てる */
function syncBookmarkCache() {
  const key = data.state.workspaceOrder.map((id) => data.state.workspaces[id].bookmarkFolderId || '').join(',');
  if (key !== allBmKey) { allBmKey = key; allBm = null; }
}

function relTime(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  const min = Math.floor(d / 60000);
  if (min < 1) return 'たった今';
  if (min < 60) return `${min} 分前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 時間前`;
  const day = Math.floor(hr / 24);
  if (day === 1) return '昨日';
  if (day < 7) return `${day} 日前`;
  const t = new Date(ts);
  return `${t.getMonth() + 1}/${t.getDate()}`;
}

function searchSelect(i) {
  if (!searchItems.length) return;
  searchSel = (i + searchItems.length) % searchItems.length;
  searchItems.forEach((it, j) => it.el.classList.toggle('on', j === searchSel));
  searchItems[searchSel].el.scrollIntoView({ block: 'nearest' });
}

function searchEntry({ icon, url, title, sub, time, run }) {
  const el = h('div', { class: 'entry', title: url || '' },
    icon || (url ? fav(url) : null),
    h('span', { class: 'title ellipsis' }, title || url || '（無題）'),
    sub ? h('span', { class: 'host muted small ellipsis' }, sub) : null,
    time ? h('span', { class: 'time' }, time) : null,
  );
  const entry = { el, run };
  el.addEventListener('click', (e) => entry.run(e.shiftKey));
  el.addEventListener('mousemove', () => searchSelect(searchItems.indexOf(entry)));
  return entry;
}

function closeSearch() {
  const box = $('searchResults');
  box.hidden = true;
  box.replaceChildren();
  searchItems = [];
}

async function runSearch() {
  const q = $('search').value.trim();
  const seq = ++searchSeq;
  if (!q || !data.state) { closeSearch(); return; }
  const { state } = data;
  const out = [];
  const list = [];
  const push = (e) => { list.push(e); out.push(e.el); };
  const section = (label) => out.push(h('div', { class: 'section' }, label));

  // ワークスペース（名前・セッション名・アイコン）
  const wsList = state.workspaceOrder
    .map((id) => state.workspaces[id])
    .filter((w) => matchesQuery(`${w.name} ${sessionName(w.sessionId)} ${w.icon || ''}`, q));
  section(`ワークスペース（${wsList.length}）`);
  for (const w of wsList) {
    const here = data.bindings[windowId] === w.id;
    push(searchEntry({
      icon: wsIcon(w),
      title: w.name,
      sub: here ? 'このウィンドウ' : `${sessionName(w.sessionId)} · ${w.tabs.length} タブ`,
      run: async (shift) => {
        clearSearch();
        if (shift) await openNewWindow(w.id);
        else { selectWorkspace(w.id); await switchHere(w.id); }
      },
    }));
  }

  // ブックマーク（全ワークスペースの接続フォルダ）
  let folders = [];
  try { folders = await allBookmarks(); } catch { /* 読み込み失敗時は空扱い */ }
  if (seq !== searchSeq) return;
  const bms = [];
  for (const f of folders) {
    for (const it of f.items) {
      if (matchesQuery(`${it.title} ${it.url} ${it.path} ${state.workspaces[f.workspaceId]?.name || ''}`, q)) bms.push({ ...it, workspaceId: f.workspaceId });
    }
  }
  section(`ブックマーク（${bms.length}）`);
  for (const b of bms.slice(0, 30)) {
    const wsName = state.workspaces[b.workspaceId]?.name || '';
    push(searchEntry({
      url: b.url,
      title: b.title,
      sub: [wsName, b.path].filter(Boolean).join(' / ') || hostOf(b.url),
      run: (shift) => attempt(async () => { await openUrlIn(b.url, shift ? null : b.workspaceId); clearSearch(); }),
    }));
  }

  // 閲覧履歴（Chrome の URL バーと同様にタイトル・URL で検索。新しい順）
  let hist = [];
  try {
    hist = await chrome.history.search({ text: q, maxResults: 60, startTime: 0 });
  } catch (e) {
    console.warn('[search] history', e);
  }
  if (seq !== searchSeq) return;
  const seen = new Set(bms.map((b) => normalizeUrlForMatch(b.url)));
  const histList = [];
  for (const hItem of hist.sort((a, b) => (b.lastVisitTime || 0) - (a.lastVisitTime || 0))) {
    const key = normalizeUrlForMatch(hItem.url);
    if (!hItem.url || seen.has(key) || isManagerUrl(hItem.url) || isWorkspaceTabUrl(hItem.url) || hItem.url.startsWith('chrome-extension://')) continue;
    seen.add(key);
    histList.push(hItem);
    if (histList.length >= 20) break;
  }
  section(`閲覧履歴（${histList.length}）`);
  for (const hItem of histList) {
    push(searchEntry({
      url: hItem.url,
      title: hItem.title || hItem.url,
      sub: hostOf(hItem.url),
      time: relTime(hItem.lastVisitTime),
      run: (shift) => attempt(async () => { await openUrlIn(hItem.url, shift ? null : selectedId); clearSearch(); }),
    }));
  }
  if (!list.length) out.push(h('div', { class: 'empty' }, '一致するものがありません'));

  const box = $('searchResults');
  box.replaceChildren(...out);
  box.hidden = false;
  searchItems = list;
  searchSel = 0;
  searchSelect(0);
}

function clearSearch() {
  $('search').value = '';
  closeSearch();
}

$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => attempt(runSearch), 120);
});
$('search').addEventListener('focus', () => { if ($('search').value.trim() && $('searchResults').hidden) attempt(runSearch); });
$('search').addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); searchSelect(searchSel + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); searchSelect(searchSel - 1); }
  else if (e.key === 'Enter') { e.preventDefault(); searchItems[searchSel]?.run(e.shiftKey); }
  else if (e.key === 'Escape' && $('search').value) {
    // 入力があれば消すだけ。空のときは下の Esc ハンドラでパネルを閉じる
    e.preventDefault();
    clearSearch();
  }
});
// 結果の外側をクリックしたら閉じる（入力欄に戻れば再表示）
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('.search-wrap')) closeSearch();
});
// "/" で検索ボックスへフォーカス（入力中・モーダル表示中を除く）
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.ctrlKey || e.altKey || e.metaKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
  if (document.querySelector('dialog[open]')) return;
  e.preventDefault();
  $('search').focus();
  $('search').select();
});
// 番号キー 1〜9 / 0 でワークスペースへ切替（Shift で新しいウィンドウ）。入力欄では発火しない（空の検索ボックスのみ例外）
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.altKey || e.metaKey) return;
  // Shift 併用時は e.key が '!' などになるので e.code（Digit / Numpad）から数字を取る
  const m = /^(?:Digit|Numpad)([0-9])$/.exec(e.code || '');
  const key = m ? m[1] : e.key;
  const index = hotkeyToIndex(key);
  if (index == null) return;
  const t = e.target;
  const editable = t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
  if (editable && !(t === $('search') && !t.value)) return;
  if (editingId || document.querySelector('dialog[open]')) return;
  const id = data?.state?.workspaceOrder[index];
  if (!id) return;
  e.preventDefault();
  if (e.shiftKey) openNewWindow(id);
  else switchHere(id);
});
// パネルが表示されたとき、他に入力中でなければ検索ボックスへ
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const a = document.activeElement;
  if (!a || a === document.body) $('search').focus();
});
// Esc: 作成 / セッションのダイアログ → ✎ の編集 → 検索結果 の順に閉じ、何も開いていなければパネルを閉じる
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return;
  if (document.querySelector('dialog[open]')) return; // ダイアログは Esc で閉じる（ブラウザ既定の動作）
  e.preventDefault();
  if (editingId) {
    editingId = null;
    // 入力欄にフォーカスがあると描画が後回しになるので外す
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    render();
    return;
  }
  if (!$('searchResults').hidden) { closeSearch(); return; }
  closePanel();
});
// フォーカスを失ったら閉じる（モーダル的な挙動）。一瞬だけ外れることがあるので少し待ってから確かめる
window.addEventListener('blur', (e) => {
  if (e.target !== window) return;
  setTimeout(() => { if (!document.hasFocus() && !holdOpen) closePanel(); }, 150);
});
// 対象ウィンドウが閉じられたらパネルも閉じる
chrome.windows.onRemoved.addListener((id) => { if (id === windowId) closePanel(); });

chrome.bookmarks.onCreated.addListener(() => { allBm = null; });
chrome.bookmarks.onRemoved.addListener(() => { allBm = null; });
chrome.bookmarks.onChanged.addListener(() => { allBm = null; });
chrome.bookmarks.onMoved.addListener(() => { allBm = null; });

(async () => {
  const self = await chrome.windows.getCurrent();
  if (self.type === 'popup') selfWindowId = self.id;
  windowId = await resolveTargetWindow();
  await attempt(load);
  $('search').focus();
  attempt(loadClosedTabs);
})();
