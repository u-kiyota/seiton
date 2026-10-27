import {
  tabUrl, normalizeUrlForMatch, isManagerUrl, isWorkspaceTabUrl, matchesQuery,
  TAB_DRAG_TYPE, parseTabDragData, isBookmarkableUrl, workspaceHotkey, hotkeyToIndex,
  autoCloseDaysFrom, autoCloseDuration, formatAutoCloseDuration, AUTO_CLOSE_UNIT_LABELS,
  autoCloseExcludeMatch, excludePatternsForUrl, resolveSwitchMode, switchKeyHints, SWITCH_MODE_SHORT, moveTabsMessage,
} from '../lib/core.js';
import { iconPicker, makeWorkspaceDraggable, makeWorkspaceDropTarget } from './manage.js';
import { call, h, faviconUrl, COLOR_HEX, wsIcon, toast, attempt, confirmButton } from './api.js';

const $ = (id) => document.getElementById(id);
const COLORS = Object.keys(COLOR_HEX);

// 対象ウィンドウ（パネルを呼び出した通常ウィンドウ）。切替・URL を開く先はここ。パネル自身のウィンドウではない
let windowId;
// パネル自身のポップアップウィンドウ。タブとして開かれた場合（旧版の名残など）は null で、自動では閉じない
let selfWindowId = null;
// parked: 休止中のワークスペース（issue #35）→ { windowId, groupId }
let data = { state: null, bindings: {}, parked: {} };
// Cookie の分離の状態（issue #12）。✎ のヒントに使う。live（今の Cookie の件数）は重いので取らない
let cookieInfo = null;
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

/** 休止中（issue #35: タブを閉じずに折りたたんだグループに残している）なら { windowId, groupId }、そうでなければ null */
function parkedOf(wsId) {
  return data.parked?.[wsId] || null;
}

/** 既定の切替方法（設定・管理の「表示・操作」。issue #37） */
function defaultSwitchMode() {
  return data.state?.settings?.switchMode || 'switch';
}

/** キーの組み合わせと既定の切替方法から、実際の切替方法を決める */
function keyMode(e) {
  return resolveSwitchMode(e, defaultSwitchMode());
}

/** 検索ボックスのヒントを既定の切替方法に合わせる */
function renderHint() {
  const k = switchKeyHints(defaultSwitchMode());
  const s = SWITCH_MODE_SHORT;
  $('searchHint').textContent = `↑↓ 選択 / Enter ワークスペース→${s[k.enter]}・URL→開く / Shift+Enter ワークスペース→${s[k.shift]}・URL→このウィンドウ / Ctrl+Enter ワークスペース→${s[k.ctrl]} / Esc 検索を消す・閉じる / 1〜9/0 ${s[k.enter]}（Shift で ${s[k.shift]}）`;
}

function sessionName(id) {
  return data.state.sessions[id]?.name || '';
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
  renderHint();
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

/**
 * 対象ウィンドウをそのワークスペースに切り替える（別ウィンドウで開いていればそちらへ。休止中なら再開）。完了後にパネルを閉じる。
 * park: 今のワークスペースのタブを閉じずに休止（折りたたんだグループ）にして残す（issue #35）
 */
function switchHere(id, { park = false } = {}) {
  if (data.bindings[windowId] === id) return undefined;
  return attempt(() => moveAway(async () => {
    const res = await call('switchWorkspace', { windowId, workspaceId: id, park });
    return res?.windowId ?? windowId;
  }));
}

/** 切替方法（switchModeFromKeys の戻り値）に応じて開く: window = 新しいウィンドウ / park = 休止して切替 / switch = 切替 */
function openWorkspaceBy(id, mode) {
  selectWorkspace(id);
  if (mode === 'window') return openNewWindow(id);
  return switchHere(id, { park: mode === 'park' });
}

/** 休止を終了: 休止グループのタブを閉じる（閉じる直前の内容は保存される） */
function endParked(id) {
  return attempt(async () => {
    const r = await call('closeParked', { workspaceId: id });
    toast(`休止を終了し、${r.closed} 個のタブを閉じました`);
  });
}

/** 新しいウィンドウで開く（既に開いていればそのウィンドウへ）。完了後にパネルを閉じる */
function openNewWindow(id) {
  return attempt(() => moveAway(async () => (await call('openInNewWindow', { workspaceId: id }))?.windowId));
}

/** 一覧の行をクリック: 選択して、既定の切替方法でそのワークスペースを開く（別ウィンドウで開いていればそちらへ） */
function onRowClick(id) {
  openWorkspaceBy(id, defaultSwitchMode());
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
    const parkedIn = parkedOf(ws.id);
    parts.push(h('div', { class: 'row' },
      wsIcon(ws, 'lg'),
      h('span', { class: 'grow ellipsis' }, h('b', {}, ws.name)),
      h('span', { class: 'ws-session', title: '使うセッション' }, sessionName(ws.sessionId)),
      here ? h('span', { class: 'badge here' }, 'このウィンドウ')
        : openIn != null ? h('span', { class: 'badge' }, '別ウィンドウ')
          : parkedIn ? h('span', { class: 'badge parked', title: '休止中: タブは閉じずに折りたたんだグループ「⏸ …」に残っています' },
            parkedIn.windowId === windowId ? 'このウィンドウで休止中' : '別ウィンドウで休止中')
            : h('span', { class: 'badge' }, '未オープン'),
      here ? null : h('button', {
        class: 'primary', type: 'button',
        title: openIn != null ? '開いているウィンドウへ移動'
          : parkedIn ? '休止グループを解いて再開する（今のワークスペースのタブは閉じて保存）'
            : 'このウィンドウのタブを入れ替えて開く',
        onclick: () => switchHere(ws.id),
      }, openIn != null ? 'そのウィンドウへ' : parkedIn ? '再開' : 'このウィンドウで開く'),
      here || openIn != null ? null : h('button', {
        type: 'button',
        title: '今のワークスペースのタブを閉じずに休止（折りたたんだグループ）にして残し、このワークスペースを開く',
        onclick: () => switchHere(ws.id, { park: true }),
      }, '⏸ 休止して開く'),
      h('button', {
        class: 'icon', type: 'button', title: '新しいウィンドウで開く',
        onclick: () => openNewWindow(ws.id),
      }, '⧉'),
      parkedIn ? h('button', {
        type: 'button', title: '休止を終了: 休止グループのタブを閉じる（閉じる直前の内容は保存されます）',
        onclick: () => endParked(ws.id),
      }, '休止を終了') : null,
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
    cookieInfo && !cookieInfo.permitted && state.sessionOrder.length > 1
      ? h('div', { class: 'muted small', style: { margin: '-4px 0 4px' } }, 'Cookie を分けるための権限が未許可です。',
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); openSettings('sessions'); } }, '設定・管理の「セッション」'), 'から許可できます')
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
    const parkedIn = parkedOf(id);
    const head = h('div', {
      class: 'ws-head row',
      title: here ? 'このウィンドウで開いています'
        : openIn != null ? 'クリックで開いているウィンドウへ移動'
          : parkedIn ? 'クリックで休止を解いて再開（別ウィンドウで休止中ならこのウィンドウへ移す）'
            : 'クリックでこのウィンドウに開く',
      onclick: () => onRowClick(id),
    },
      workspaceHotkey(index) ? h('span', { class: 'badge hotkey', title: `${workspaceHotkey(index)} キーで切替（Shift で新しいウィンドウ）` }, workspaceHotkey(index)) : null,
      wsIcon(ws),
      h('span', { class: 'grow ellipsis' }, ws.name),
      showSession ? h('span', { class: 'ws-session', title: `使うセッション: ${sessionName(ws.sessionId)}` }, sessionName(ws.sessionId)) : null,
      ws.bookmarkFolderId ? h('span', { class: 'muted small', title: 'ブックマークフォルダ接続済み' }, '★') : null,
      here ? h('span', { class: 'badge here', title: 'このウィンドウ' }, 'ここ')
        : openIn != null ? h('span', { class: 'badge', title: '別ウィンドウで開いている' }, '別')
          : parkedIn ? h('span', {
            class: 'badge parked',
            title: parkedIn.windowId === windowId ? 'このウィンドウで休止中（タブは折りたたんだグループに残っています）' : '別ウィンドウで休止中',
          }, parkedIn.windowId === windowId ? '休止' : '別・休止') : null,
      h('span', { class: 'muted small', title: '保存されているタブ数' }, `${ws.tabs.length}`),
      // 行の操作（マウスを乗せると出る。issue #35）: ⏸ 今のタブを休止して切替 / ⧉ 新しいウィンドウで開く
      here || openIn != null ? null : h('button', {
        class: 'icon act', type: 'button',
        title: '今のワークスペースのタブを閉じずに休止して、このワークスペースに切り替える',
        onclick: (e) => { e.stopPropagation(); selectWorkspace(id); switchHere(id, { park: true }); },
      }, '⏸'),
      h('button', {
        class: 'icon act', type: 'button',
        title: openIn != null ? '開いているウィンドウへ移動' : '新しいウィンドウで開く',
        onclick: (e) => { e.stopPropagation(); openNewWindow(id); },
      }, '⧉'),
    );
    makeTabDropTarget(head, () => data.state?.workspaces[id] || null);
    // 行をドラッグして並び替え（issue #25）。落とす位置の線は行の外枠（.ws）に出す
    const wrap = h('div', { class: `ws${here ? ' current' : ''}${selectedId === id ? ' sel' : ''}` }, head);
    makeWorkspaceDraggable(head, id);
    makeWorkspaceDropTarget(head, id, { getOrder: () => data.state?.workspaceOrder, mark: wrap });
    return wrap;
  }));
}

/** check: { on, onToggle(e) } を渡すと行の先頭にチェックボックス（別のワークスペースへの移動用。issue #33） */
function entryRow({ url, title, sub, extra, active, discarded, check, onOpen, onClose, closeTitle = 'タブを閉じる' }) {
  return h('div', {
    class: `entry${active ? ' on' : ''}${discarded ? ' discarded' : ''}${check?.on ? ' checked' : ''}`,
    title: url || '',
    onclick: () => onOpen && attempt(onOpen),
  },
    check ? h('input', {
      type: 'checkbox', class: 'check', checked: !!check.on, title: '選択して別のワークスペースへ移動（Shift+クリックで範囲）',
      onclick: (e) => { e.stopPropagation(); check.onToggle(e); },
    }) : null,
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
    ? (parkedOf(ws.id) ? '休止中です。' : 'このワークスペースは開いていません。') + '行を開くと、この 1 件だけを現在のウィンドウで開きます。'
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
    renderTabActions(null, []);
    body.replaceChildren(h('div', { class: 'empty' }, '読み込み中…'));
    return;
  }
  if (view.mode === 'saved') {
    const tabs = view.tabs || [];
    syncCheckedScope(`${selectedId}:saved`);
    const keys = tabs.map((_t, i) => i);
    renderTabActions(view, keys);
    $('tabTitle').textContent = `保存済みのタブ（${tabs.length}）`;
    if (!tabs.length) {
      body.replaceChildren(h('div', { class: 'empty' }, '保存されているタブはありません。'));
      return;
    }
    const nodes = [h('div', { class: 'hint' }, 'まだ開いていません。行を開くと、この 1 件だけを現在のウィンドウで開きます。色の付いた行は、ワークスペースを開いたときに前面になるタブです。')];
    let lastGroup;
    tabs.forEach((t, i) => {
      if (t.groupKey !== lastGroup) {
        lastGroup = t.groupKey;
        if (t.groupKey) nodes.push(h('div', { class: 'group-label' }, view.groups?.[t.groupKey]?.title || 'グループ'));
      }
      nodes.push(entryRow({
        url: t.url,
        title: (t.pinned ? '📌 ' : '') + (t.title || t.url),
        sub: hostOf(t.url),
        active: !!t.active,
        check: { on: checked.has(i), onToggle: (e) => toggleChecked(keys, i, e) },
        onOpen: () => openSingle(t.url),
      }));
    });
    body.replaceChildren(...nodes);
    return;
  }

  const tabs = [...(view.tabs || [])]
    .filter((t) => !isManagerUrl(tabUrl(t)) && !isWorkspaceTabUrl(tabUrl(t)))
    .sort((a, b) => a.index - b.index);
  const groupById = Object.fromEntries((view.groups || []).map((g) => [g.id, g]));
  syncCheckedScope(`${selectedId}:live:${view.windowId}`);
  const keys = tabs.map((t) => t.id);
  renderTabActions(view, keys);
  $('tabTitle').textContent = `${view.parked ? '休止中のタブ' : '開いているタブ'}（${tabs.length}）`;
  if (!tabs.length) {
    body.replaceChildren(h('div', { class: 'empty' }, '開いているタブはありません。'));
    return;
  }
  const nodes = [];
  if (!ws) nodes.push(h('div', { class: 'hint' }, 'このウィンドウで開いているタブです。'));
  else if (view.parked) {
    nodes.push(h('div', { class: 'hint' }, `${view.windowId === windowId ? 'このウィンドウ' : '別ウィンドウ'}で休止中（折りたたんだグループ「⏸ …」）のタブです。行を開くとそのタブへ移動します（ワークスペースは切り替わりません）。`));
  } else if (view.windowId !== windowId) nodes.push(h('div', { class: 'hint' }, '別ウィンドウで開いています。行を開くとそのタブへ移動します。'));
  let lastGroup;
  tabs.forEach((t, i) => {
    const gid = t.groupId ?? -1;
    if (gid !== lastGroup) {
      lastGroup = gid;
      // 休止中は全部が休止グループなので見出しは出さない
      if (gid !== -1 && !view.parked) nodes.push(h('div', { class: 'group-label' }, groupById[gid]?.title || 'グループ'));
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
      sub: t.discarded ? 'メモリ解放済み' : hostOf(url),
      extra: exclude,
      active: t.active,
      discarded: t.discarded,
      check: { on: checked.has(t.id), onToggle: (e) => toggleChecked(keys, i, e) },
      onOpen: () => focusTab(t),
      onClose: async () => { await chrome.tabs.remove(t.id); },
    }), t));
  });
  body.replaceChildren(...nodes);
}

// ---- タブの選択と別のワークスペースへの移動（issue #33） ----

// チェックしたタブ。開いているタブはタブ ID、保存済みタブは一覧での位置（index）。scope（ワークスペース・表示モード）が変わったら捨てる
let checked = new Set();
let checkedScope = '';
let lastCheckedIndex = -1;
let moveDest = ''; // 最後に選んだ移動先（描き直しても保つ）

function syncCheckedScope(scope) {
  if (scope === checkedScope) return;
  checkedScope = scope;
  checked.clear();
  lastCheckedIndex = -1;
}

/** 行のチェックボックス。Shift+クリックで前回チェックした行からの範囲をまとめて同じ状態にする */
function toggleChecked(keys, index, e) {
  const on = !checked.has(keys[index]);
  const from = e?.shiftKey && lastCheckedIndex >= 0 ? Math.min(lastCheckedIndex, index) : index;
  const to = e?.shiftKey && lastCheckedIndex >= 0 ? Math.max(lastCheckedIndex, index) : index;
  for (let i = from; i <= to; i++) {
    if (on) checked.add(keys[i]);
    else checked.delete(keys[i]);
  }
  lastCheckedIndex = index;
  renderTabs();
}

/** タブ一覧の上のバー: 選択件数・すべて選択 / 解除・移動先・移動 */
function renderTabActions(view, keys) {
  const bar = $('tabActions');
  $('tabs').classList.toggle('selecting', checked.size > 0);
  if (!checked.size || !view) {
    bar.hidden = true;
    bar.replaceChildren();
    return;
  }
  const { state } = data;
  const candidates = state.workspaceOrder.filter((id) => id !== selectedId);
  if (!candidates.some((id) => id === moveDest)) moveDest = candidates[0] || '';
  const dest = h('select', { title: '移動先のワークスペース' }, candidates.map((id) => {
    const w = state.workspaces[id];
    const where = windowOf(id) === windowId ? '（このウィンドウ）' : windowOf(id) != null ? '（別ウィンドウ）' : parkedOf(id) ? '（休止中）' : '';
    return h('option', { value: id, selected: id === moveDest }, `${w.icon ? w.icon + ' ' : ''}${w.name}${where}`);
  }));
  dest.addEventListener('change', () => { moveDest = dest.value; });
  const move = h('button', {
    class: 'primary', type: 'button', disabled: !candidates.length,
    title: '移動先が開いていればそのウィンドウへ移し（読み込み直さない）、休止中なら休止グループに加え、閉じていれば保存タブに加えてタブを閉じます',
    onclick: () => moveChecked(view, dest.value),
  }, '移動');
  // replaceChildren(null) は "null" という文字列になるので、要素だけを渡す
  bar.replaceChildren(...[
    h('span', { class: 'muted' }, `${checked.size} 件を選択`),
    checked.size < keys.length ? h('button', { type: 'button', onclick: () => { for (const k of keys) checked.add(k); renderTabs(); } }, 'すべて選択') : null,
    h('button', { type: 'button', onclick: () => { checked.clear(); lastCheckedIndex = -1; renderTabs(); } }, '解除'),
    h('span', { class: 'grow' }),
    h('span', { class: 'muted small' }, '移動先'),
    dest,
    move,
    candidates.length ? null : h('span', { class: 'muted small' }, '他のワークスペースがありません'),
  ].filter(Boolean));
  bar.hidden = false;
}

/** チェックしたタブを移動先のワークスペースへ移す。開いているタブは ID で、保存済みタブは位置と URL で指定する */
function moveChecked(view, workspaceId) {
  if (!workspaceId || !checked.size) return;
  return attempt(async () => {
    let res;
    if (view.mode === 'saved') {
      const picks = [...checked].map((i) => ({ index: i, url: view.tabs[i]?.url })).filter((p) => p.url);
      res = await call('moveSavedTabs', { fromWorkspaceId: selectedId, picks, workspaceId });
    } else {
      res = await call('moveTabs', { tabIds: [...checked], workspaceId });
    }
    checked.clear();
    lastCheckedIndex = -1;
    toast(moveTabsMessage(res));
    render();
    attempt(refreshDetail);
  });
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
  // 休止して切替（issue #35）: 割り当て済みのウィンドウでだけ選べる。セッションが変わる（Cookie を入れ替える）ときは選べない
  $('createPark').checked = false;
  const updatePark = () => {
    const swap = !!cookieInfo?.permitted && current && $('createSession').value !== current.sessionId;
    $('createParkRow').hidden = unassigned || swap;
  };
  updatePark();
  $('createSession').onchange = updatePark;
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
  const park = !keep && !$('createParkRow').hidden && $('createPark').checked;
  $('createDialog').close();
  const create = async () => {
    const { workspaceId, cookieSession } = await call('createWorkspace', keep
      ? { name, sessionId, icon, ...folderOpts, fromWindowId: windowId }
      : { name, sessionId, icon, ...folderOpts, switchTo: true, windowId, park });
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

// ---- 閉じたタブの件数（左下の「設定・管理」ボタンのバッジ。一覧は設定・管理画面の「閉じたタブ」） ----

function updateClosedCount(n) {
  const badge = $('closedBadge');
  badge.hidden = !n;
  badge.textContent = String(n);
  badge.title = `自動クローズで閉じたタブ: ${n} 件（設定・管理の「閉じたタブ」で開き直せます）`;
}

async function loadClosedCount() {
  updateClosedCount((await call('listClosedTabs')).length);
}

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
  const parkedIn = ws ? parkedOf(ws.id) : null;
  let tabsView;
  if (ws && openWin == null && !parkedIn) {
    tabsView = { mode: 'saved', tabs: ws.tabs, groups: ws.groups || {} };
  } else {
    // 休止中（issue #35）なら、そのウィンドウの休止グループに入っているタブだけを生で見せる
    const wid = openWin ?? parkedIn?.windowId ?? windowId;
    const [tabs, groups] = await Promise.all([
      chrome.tabs.query({ windowId: wid }),
      chrome.tabGroups.query({ windowId: wid }).catch(() => []),
    ]);
    tabsView = {
      mode: 'live', windowId: wid, groups, parked: !!parkedIn,
      tabs: parkedIn ? tabs.filter((t) => t.groupId === parkedIn.groupId) : tabs,
    };
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
  toast(`${n} 個のタブのメモリを解放しました`);
}));
/**
 * 設定・管理画面（ワークスペース / セッション / 閉じたタブ / 各設定）を対象ウィンドウのタブで開く。
 * 既に開いていればそのタブへ。section は #workspaces などの節。開いたらパネルを閉じる
 */
function openSettings(section = '') {
  return attempt(() => moveAway(async () => {
    const base = chrome.runtime.getURL('src/ui/options.html');
    const url = section ? `${base}#${section}` : base;
    const [tab] = await chrome.tabs.query({ url: `${base}*` });
    if (tab) {
      await chrome.tabs.update(tab.id, { url, active: true });
      return tab.windowId;
    }
    await chrome.tabs.create({ windowId, url });
    return windowId;
  }));
}
$('options').addEventListener('click', () => openSettings());
// パネルはポップアップウィンドウなので、windowId を指定して対象ウィンドウのタブとして開く
$('guide').addEventListener('click', () => attempt(() => moveAway(async () => {
  await chrome.tabs.create({ windowId, url: chrome.runtime.getURL('src/ui/guide.html') });
  return windowId;
})));

chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === 'local' && changes.state) || (area === 'session' && (changes.bindings || changes.parked))) attempt(load);
  if (area === 'local' && changes.closedTabs) {
    const v = changes.closedTabs.newValue;
    updateClosedCount(Array.isArray(v) ? v.length : 0);
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
let searchItems = []; // { el, run(mode) }  mode: switchModeFromKeys の戻り値（switch / window / park）
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
  el.addEventListener('click', (e) => entry.run(keyMode(e)));
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
    const parkedIn = parkedOf(w.id);
    push(searchEntry({
      icon: wsIcon(w),
      title: w.name,
      sub: here ? 'このウィンドウ'
        : `${parkedIn ? (parkedIn.windowId === windowId ? '休止中 · ' : '別ウィンドウで休止中 · ') : ''}${sessionName(w.sessionId)} · ${w.tabs.length} タブ`,
      // Enter = 既定の切替方法 / Shift+Enter = 新しいウィンドウとの入れ替え / Ctrl+Enter = 休止との入れ替え（keyMode）
      run: async (mode) => {
        clearSearch();
        await openWorkspaceBy(w.id, mode);
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
      run: (mode) => attempt(async () => { await openUrlIn(b.url, mode === 'window' ? null : b.workspaceId); clearSearch(); }),
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
      run: (mode) => attempt(async () => { await openUrlIn(hItem.url, mode === 'window' ? null : selectedId); clearSearch(); }),
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
  else if (e.key === 'Enter') { e.preventDefault(); searchItems[searchSel]?.run(keyMode(e)); }
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
// 番号キー 1〜9 / 0 でワークスペースへ切替（既定の切替方法。Shift で新しいウィンドウとの入れ替え）。入力欄では発火しない（空の検索ボックスのみ例外）
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
  openWorkspaceBy(id, keyMode(e)); // 既定の切替方法（Shift で新しいウィンドウとの入れ替え）
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
  setTimeout(() => { if (!document.hasFocus()) closePanel(); }, 150);
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
  attempt(loadClosedCount);
})();
