import { uiText, setText, setTranslatedAttribute, replaceChildren, languageOnlyChange, getLanguage } from './i18n.js';
// クイックパレット: 現在のワークスペースのタブ / 接続フォルダのブックマーク / ワークスペース切替
import { call, h, faviconUrl, wsIcon, attempt, toast } from './api.js';
import { matchesQuery, normalizeUrlForMatch, resolveSwitchMode } from '../lib/core.js';

const $ = (id) => document.getElementById(id);
let windowId;
let palette;
let items = []; // { el, run(shift), remove? }
let sel = 0;

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function item({ icon, title, sub, cls = '', run, remove }) {
  const el = h('div', { class: `item ${cls}` },
    icon,
    h('span', { class: 'title' }, title),
    sub ? h('span', { class: 'sub' }, sub) : null,
    remove ? h('button', {
      class: 'icon close', title: uiText("タブを閉じる"),
      onclick: (e) => { e.stopPropagation(); remove(); },
    }, '×') : null,
  );
  const entry = { el, run, remove };
  el.addEventListener('click', (e) => run(e.shiftKey, keyMode(e)));
  el.addEventListener('mousemove', () => select(items.indexOf(entry)));
  return entry;
}

function select(i) {
  if (!items.length) return;
  sel = (i + items.length) % items.length;
  items.forEach((it, j) => it.el.classList.toggle('sel', j === sel));
  items[sel].el.scrollIntoView({ block: 'nearest' });
}

async function openUrl(url, inCurrentTab) {
  const existing = palette.tabs.find((t) => normalizeUrlForMatch(t.url) === normalizeUrlForMatch(url));
  if (existing && !inCurrentTab) {
    await chrome.tabs.update(existing.id, { active: true });
  } else if (inCurrentTab && palette.tabs.some((t) => t.active)) {
    const active = palette.tabs.find((t) => t.active);
    await chrome.tabs.update(active.id, { url });
  } else {
    // 前面がワークスペースタブ（一覧から除外している）のときは、そのページを置き換えず新しいタブで開く
    await chrome.tabs.create({ windowId, url });
  }
  window.close();
}

/** 先頭が ">"（全角 "＞" も可）ならワークスペースだけを検索するモード */
function parseQuery(raw) {
  const m = raw.match(/^\s*[>＞]\s*(.*)$/);
  return m ? { q: m[1], wsOnly: true } : { q: raw, wsOnly: false };
}

function render() {
  const raw = $('q').value;
  const { q, wsOnly } = parseQuery(raw);
  const { state, workspaceId, tabs, bookmarks } = palette;
  const out = [];
  items = [];
  const push = (entry) => { items.push(entry); out.push(entry.el); };
  const ws = state.workspaces[workspaceId];

  // 開いているタブ（ワークスペース検索モードでは出さない）
  const tabList = wsOnly ? [] : tabs.filter((t) => matchesQuery(`${t.title} ${t.url}`, q));
  if (!wsOnly) out.push(h('div', { class: 'section' }, uiText("開いているタブ（{p0}）", {p0: (tabList.length)})));
  for (const t of tabList) {
    push(item({
      icon: h('img', { class: 'fav', src: faviconUrl(t.url) }),
      title: (t.pinned ? '📌 ' : '') + (t.title || t.url),
      sub: t.discarded ? uiText("メモリ解放済み") : hostOf(t.url),
      cls: t.discarded ? 'discarded' : '',
      run: async () => { await chrome.tabs.update(t.id, { active: true }); window.close(); },
      remove: async () => {
        await chrome.tabs.remove(t.id).catch(() => {});
        palette.tabs = palette.tabs.filter((x) => x.id !== t.id);
        render();
      },
    }));
  }

  // よく開くタブ置き場（issue #34）。ワークスペース検索モードと、置き場が空のときは出さない
  if (!wsOnly && ws && palette.shelf?.length) {
    const shelf = palette.shelf.filter((s) => matchesQuery(`${s.title} ${s.url}`, q));
    out.push(h('div', { class: 'section' }, uiText("よく開くタブ（{p0}）", {p0: (shelf.length)})));
    for (const s of shelf) {
      push(item({
        icon: h('img', { class: 'fav', src: faviconUrl(s.url) }),
        title: s.title,
        sub: hostOf(s.url),
        run: (shift) => attempt(() => openUrl(s.url, shift)),
      }));
    }
  }

  // 接続フォルダのブックマーク
  if (wsOnly) {
    // ワークスペース検索モード: ブックマークは出さない
  } else if (!ws) {
    out.push(h('div', { class: 'section' }, uiText("ブックマーク")), h('div', { class: 'empty' }, uiText("このウィンドウはワークスペース未割り当てです")));
  } else if (!bookmarks) {
    out.push(h('div', { class: 'section' }, uiText("ブックマーク")), h('div', { class: 'empty' }, uiText("ブックマークフォルダが未接続です（管理パネルの ✎ から接続）")));
  } else {
    const bms = bookmarks.items.filter((b) => matchesQuery(`${b.title} ${b.url} ${b.path}`, q));
    out.push(h('div', { class: 'section' }, uiText("ブックマーク: {p0}（{p1}）", {p0: (bookmarks.title), p1: (bms.length)})));
    if (!bookmarks.items.length) out.push(h('div', { class: 'empty' }, uiText("まだブックマークがありません（★ 保存 / Ctrl+D で追加）")));
    for (const b of bms) {
      push(item({
        icon: h('img', { class: 'fav', src: faviconUrl(b.url) }),
        title: b.title,
        sub: b.path || hostOf(b.url),
        run: (shift) => attempt(() => openUrl(b.url, shift)),
      }));
    }
  }

  // ワークスペース切替（表示順。サブに使うセッション名を出す）。
  // 通常モードでは現在のワークスペースを除く。ワークスペース検索モードでは全件出し、現在のものは「ここ」と表示
  const wsList = state.workspaceOrder
    .map((id) => ({ w: state.workspaces[id], s: state.sessions[state.workspaces[id].sessionId] }))
    .filter(({ w, s }) => (wsOnly || w.id !== workspaceId) && matchesQuery(`${w.name} ${s?.name || ''} ${w.icon || ''}`, q));
  out.push(h('div', { class: 'section' },
    wsOnly ? uiText("ワークスペース（{p0}）", {p0: (wsList.length)}) : uiText("ワークスペースを切り替え（{p0}）", {p0: (wsList.length)}),
    wsOnly ? null : h('span', { class: 'grow' }),
    wsOnly ? null : h('span', { class: 'muted', style: { fontWeight: 'normal' } }, uiText("「>」でワークスペースのみ検索")),
  ));
  if (wsOnly && !wsList.length) out.push(h('div', { class: 'empty' }, state.workspaceOrder.length ? uiText("一致するワークスペースがありません") : uiText("ワークスペースがありません（☰ の管理パネルから作成）")));
  for (const { w, s } of wsList) {
    const here = w.id === workspaceId;
    push(item({
      icon: wsIcon(w),
      title: w.name,
      sub: here ? uiText("このウィンドウ") : uiText("{p0} · {p1} タブ", {p0: (s?.name || ''), p1: (w.tabs.length)}),
      cls: here ? 'here' : '',
      run: (_shift, mode) => attempt(async () => {
        // 既定の切替方法（設定）に Shift（新しいウィンドウとの入れ替え）/ Ctrl（休止との入れ替え）を加味した mode で開く（issue #35 / #37）
        if (mode === 'window') await call('openInNewWindow', { workspaceId: w.id });
        else if (!here) await call('switchWorkspace', { windowId, workspaceId: w.id, park: mode === 'park' });
        window.close();
      }),
    }));
  }

  replaceChildren($('results'), ...out);
  select(raw.trim() ? 0 : Math.max(0, items.findIndex((it, i) => tabList[i]?.active)));
}

$('q').addEventListener('input', render);
document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); select(sel + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); select(sel - 1); }
  else if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
    // Tab でワークスペース検索モードの ON / OFF を切り替える（検索語は残す）
    e.preventDefault();
    const q = $('q');
    const { q: body, wsOnly } = parseQuery(q.value);
    q.value = wsOnly ? body : `>${body}`;
    q.focus();
    q.setSelectionRange(q.value.length, q.value.length);
    render();
  }
  else if (e.key === 'Enter') { e.preventDefault(); items[sel]?.run(e.shiftKey, keyMode(e)); }
  else if (e.key === 'Delete' && items[sel]?.remove) {
    // 検索欄の文字削除を邪魔しないよう、カーソルが末尾にある時だけタブを閉じる
    const q = $('q');
    if (e.target === q && q.selectionStart !== q.value.length) return;
    e.preventDefault();
    items[sel].remove();
  }
});

$('saveTab').addEventListener('click', () => attempt(async () => {
  const res = await call('saveCurrentTab', { windowId });
  toast(res.duplicated ? uiText("既に保存済みです") : uiText("ブックマークに保存しました"));
  palette = await call('getPalette', { windowId });
  render();
}));
$('openPanel').addEventListener('click', async () => {
  // パネルを開くとこのパレットはフォーカスを失って閉じるので、開く処理はサービスワーカーに任せる
  try { await call('openManager', { windowId }); } catch (e) { console.warn(e); }
  window.close();
});

(async () => {
  windowId = (await chrome.windows.getCurrent()).id;
  palette = await attempt(() => call('getPalette', { windowId }));
  if (!palette) return;
  const ws = palette.state.workspaces[palette.workspaceId];
  setText($('wsName'), ws ? ws.name : uiText("未割り当てのウィンドウ"));
  replaceChildren($('wsDot'), ...(ws ? [wsIcon(ws)] : []));
  $('saveTab').disabled = !ws?.bookmarkFolderId;
  render();
})();

/** キーの組み合わせと既定の切替方法（設定・管理の「表示・操作」）から、ワークスペースの切替方法を決める（issue #37） */
function keyMode(e) {
  return resolveSwitchMode(e, palette?.state?.settings?.switchMode);
}
