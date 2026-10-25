// ワークスペースタブ: ウィンドウ左端の色付きグループの中に置かれ、このウィンドウの今のワークスペースを示すページ。
// 今のワークスペース・全ワークスペースの一覧（切替 / 新しいウィンドウ）・管理パネルを開く・接続フォルダのブックマークを表示する。
// タブは別ウィンドウへドラッグされることもあるので、描画のたびに自分のウィンドウを確かめる。
import { call, h, faviconUrl, wsIcon, toast, attempt, COLOR_HEX } from './api.js';
import { indicatorLabel, workspaceTabGroupProps } from '../lib/core.js';
import { drawIndicatorIcon } from '../lib/draw.js';

const $ = (id) => document.getElementById(id);
const DEFAULT_FAVICON = '../../icons/icon32.png';

let windowId = null;
let data = null; // { state, bindings }
let bmCache = { folderId: null, value: undefined };
let loadTimer = 0;
let loadSeq = 0;

function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

function fav(url) {
  const img = h('img', { class: 'fav', src: faviconUrl(url), alt: '' });
  img.addEventListener('error', () => img.remove());
  return img;
}

function sessionName(id) {
  return data?.state.sessions[id]?.name || '';
}

function windowOf(wsId) {
  const e = Object.entries(data.bindings).find(([, w]) => w === wsId);
  return e ? Number(e[0]) : null;
}

let faviconKey = '';
/** タブの favicon をワークスペースの色＋絵文字 / 頭文字にする（ツールバーアイコンと同じ描画）。描けなければ既定アイコン */
function setFavicon(label) {
  const key = label ? `${label.emoji}|${label.color}|${label.text}` : '';
  if (key === faviconKey) return;
  faviconKey = key;
  let href = DEFAULT_FAVICON;
  if (label) {
    try {
      const img = drawIndicatorIcon(label, 32);
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      canvas.getContext('2d').putImageData(img, 0, 0);
      href = canvas.toDataURL('image/png');
    } catch (e) {
      console.warn('[wstab] favicon を描画できません', e);
    }
  }
  $('favicon').href = href;
}

function renderCurrent(ws) {
  const box = $('current');
  if (!ws) {
    box.style.borderLeftColor = 'var(--border)';
    box.replaceChildren(
      h('span', { class: 'big-icon text', style: { background: COLOR_HEX.grey } }, '?'),
      h('div', { class: 'names' },
        h('h1', { class: 'ws-name' }, '未割り当て'),
        h('span', { class: 'muted' }, 'このウィンドウはワークスペースに割り当てられていません。下の一覧から選ぶと、このウィンドウをそのワークスペースに切り替えます。'),
      ),
    );
    return;
  }
  const label = indicatorLabel(ws, sessionName(ws.sessionId));
  box.style.borderLeftColor = label.color;
  box.replaceChildren(
    h('span', { class: `big-icon${label.emoji ? '' : ' text'}`, style: { background: label.emoji ? `color-mix(in srgb, ${label.color} 22%, transparent)` : label.color } }, label.text),
    h('div', { class: 'names' },
      h('h1', { class: 'ws-name ellipsis' }, ws.name),
      h('span', { class: 'ws-session', title: '使うセッション' }, sessionName(ws.sessionId) || 'セッションなし'),
    ),
  );
}

function renderList(currentId) {
  const { state } = data;
  const list = $('list');
  if (!state.workspaceOrder.length) {
    list.replaceChildren(h('div', { class: 'empty' }, 'ワークスペースがありません。管理パネルの ＋ から作成してください。'));
    return;
  }
  list.replaceChildren(...state.workspaceOrder.map((id) => {
    const ws = state.workspaces[id];
    const here = id === currentId;
    const openIn = windowOf(id);
    const head = h('div', {
      class: 'ws-head row',
      title: here ? 'このウィンドウで開いています' : openIn != null ? 'クリックで開いているウィンドウへ移動' : 'クリックでこのウィンドウを切り替える',
      onclick: () => { if (!here) switchHere(id); },
    },
      wsIcon(ws),
      h('span', { class: 'grow ellipsis' }, ws.name),
      state.sessionOrder.length > 1 ? h('span', { class: 'ws-session' }, sessionName(ws.sessionId)) : null,
      here ? h('span', { class: 'badge here' }, 'ここ') : openIn != null ? h('span', { class: 'badge' }, '別') : null,
      h('span', { class: 'actions' },
        h('button', {
          class: 'icon', type: 'button', title: openIn != null && !here ? '開いているウィンドウへ移動' : '新しいウィンドウで開く',
          onclick: (e) => { e.stopPropagation(); openNewWindow(id); },
        }, '⧉'),
      ),
    );
    return h('div', { class: `ws${here ? ' current sel' : ''}` }, head);
  }));
}

function switchHere(id) {
  attempt(async () => {
    const res = await call('switchWorkspace', { windowId, workspaceId: id });
    if (res?.focused) toast('別のウィンドウで開いています');
  });
}

function openNewWindow(id) {
  attempt(() => call('openInNewWindow', { workspaceId: id }));
}

async function bookmarksFor(folderId) {
  if (bmCache.folderId === folderId && bmCache.value !== undefined) return bmCache.value;
  const value = await call('listFolderBookmarks', { folderId });
  bmCache = { folderId, value };
  return value;
}

async function renderBookmarks(ws, seq) {
  const body = $('bookmarks');
  $('bmTitle').textContent = 'ブックマーク';
  if (!ws) {
    body.replaceChildren(h('div', { class: 'empty' }, 'ワークスペースに切り替えると、接続フォルダのブックマークを表示します。'));
    return;
  }
  if (!ws.bookmarkFolderId) {
    body.replaceChildren(h('div', { class: 'empty' }, 'ブックマークフォルダが未接続です（管理パネルの ✎ から接続できます）。'));
    return;
  }
  let bm;
  try {
    bm = await bookmarksFor(ws.bookmarkFolderId);
  } catch (e) {
    bm = { error: e.message || String(e) };
  }
  if (seq !== loadSeq) return;
  if (!bm || bm.error) {
    body.replaceChildren(h('div', { class: 'empty' }, bm?.error || 'フォルダが見つかりません。'));
    return;
  }
  $('bmTitle').textContent = `ブックマーク: ${bm.title}（${bm.items.length}）`;
  if (!bm.items.length) {
    body.replaceChildren(h('div', { class: 'empty' }, `「${bm.title}」は空です（Ctrl+D / Alt+Shift+D で追加）。`));
    return;
  }
  const nodes = [];
  let lastPath;
  for (const it of bm.items) {
    const path = it.path || '';
    if (path !== lastPath) {
      lastPath = path;
      if (path) nodes.push(h('div', { class: 'group-label' }, path));
    }
    nodes.push(h('div', {
      class: 'entry', title: it.url,
      // 新しいタブはウィンドウの末尾に開く（このタブの隣に開くとワークスペースタブのグループに入ってしまうため）
      onclick: () => attempt(() => chrome.tabs.create({ windowId, url: it.url, active: true })),
    },
      fav(it.url),
      h('span', { class: 'title ellipsis' }, it.title || it.url),
      h('span', { class: 'host muted small ellipsis' }, hostOf(it.url)),
    ));
  }
  body.replaceChildren(...nodes);
}

async function load() {
  const seq = ++loadSeq;
  const [win, fresh] = await Promise.all([chrome.windows.getCurrent(), call('getState')]);
  if (seq !== loadSeq) return;
  windowId = win.id;
  data = fresh;
  const ws = data.state.workspaces[data.bindings[windowId]] || null;
  document.title = ws ? (workspaceTabGroupProps(ws).title || ws.name) : 'seiton — 未割り当て';
  setFavicon(ws ? indicatorLabel(ws, sessionName(ws.sessionId)) : null);
  renderCurrent(ws);
  renderList(ws?.id || null);
  await renderBookmarks(ws, seq);
}

function scheduleLoad() {
  clearTimeout(loadTimer);
  loadTimer = setTimeout(() => attempt(load), 100);
}

$('openManager').addEventListener('click', () => attempt(() => call('openManager', { windowId })));
$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === 'local' && changes.state) || (area === 'session' && changes.bindings)) scheduleLoad();
});
const dropBookmarks = () => { bmCache = { folderId: null, value: undefined }; scheduleLoad(); };
for (const ev of ['onCreated', 'onRemoved', 'onChanged', 'onMoved']) chrome.bookmarks[ev].addListener(dropBookmarks);
// このタブが別ウィンドウへ移されたら、そのウィンドウのワークスペースで描き直す
chrome.tabs.onAttached.addListener(scheduleLoad);

attempt(load);
