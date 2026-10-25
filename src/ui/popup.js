// クイックパレット: 現在のワークスペースのタブ / 接続フォルダのブックマーク / ワークスペース切替
import { call, h, faviconUrl, wsIcon, attempt, toast } from './api.js';
import { matchesQuery, normalizeUrlForMatch } from '../lib/core.js';
import { openManager } from '../lib/manager.js';

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
      class: 'icon close', title: 'タブを閉じる',
      onclick: (e) => { e.stopPropagation(); remove(); },
    }, '×') : null,
  );
  const entry = { el, run, remove };
  el.addEventListener('click', (e) => run(e.shiftKey));
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
  } else if (inCurrentTab) {
    const active = palette.tabs.find((t) => t.active);
    await chrome.tabs.update(active.id, { url });
  } else {
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
  if (!wsOnly) out.push(h('div', { class: 'section' }, `開いているタブ（${tabList.length}）`));
  for (const t of tabList) {
    push(item({
      icon: h('img', { class: 'fav', src: faviconUrl(t.url) }),
      title: (t.pinned ? '📌 ' : '') + (t.title || t.url),
      sub: t.discarded ? '休止中' : hostOf(t.url),
      cls: t.discarded ? 'discarded' : '',
      run: async () => { await chrome.tabs.update(t.id, { active: true }); window.close(); },
      remove: async () => {
        await chrome.tabs.remove(t.id).catch(() => {});
        palette.tabs = palette.tabs.filter((x) => x.id !== t.id);
        render();
      },
    }));
  }

  // 接続フォルダのブックマーク
  if (wsOnly) {
    // ワークスペース検索モード: ブックマークは出さない
  } else if (!ws) {
    out.push(h('div', { class: 'section' }, 'ブックマーク'), h('div', { class: 'empty' }, 'このウィンドウはワークスペース未割り当てです'));
  } else if (!bookmarks) {
    out.push(h('div', { class: 'section' }, 'ブックマーク'), h('div', { class: 'empty' }, 'ブックマークフォルダが未接続です（管理パネルの ✎ から接続）'));
  } else {
    const bms = bookmarks.items.filter((b) => matchesQuery(`${b.title} ${b.url} ${b.path}`, q));
    out.push(h('div', { class: 'section' }, `ブックマーク: ${bookmarks.title}（${bms.length}）`));
    if (!bookmarks.items.length) out.push(h('div', { class: 'empty' }, 'まだブックマークがありません（★ 保存 / Ctrl+D で追加）'));
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
    wsOnly ? `ワークスペース（${wsList.length}）` : `ワークスペースを切り替え（${wsList.length}）`,
    wsOnly ? null : h('span', { class: 'grow' }),
    wsOnly ? null : h('span', { class: 'muted', style: { fontWeight: 'normal' } }, '「>」でワークスペースのみ検索'),
  ));
  if (wsOnly && !wsList.length) out.push(h('div', { class: 'empty' }, state.workspaceOrder.length ? '一致するワークスペースがありません' : 'ワークスペースがありません（☰ の管理パネルから作成）'));
  for (const { w, s } of wsList) {
    const here = w.id === workspaceId;
    push(item({
      icon: wsIcon(w),
      title: w.name,
      sub: here ? 'このウィンドウ' : `${s?.name || ''} · ${w.tabs.length} タブ`,
      cls: here ? 'here' : '',
      run: (shift) => attempt(async () => {
        // Shift で新しいウィンドウ、通常はこのウィンドウを切替
        if (shift) await call('openInNewWindow', { workspaceId: w.id });
        else if (!here) await call('switchWorkspace', { windowId, workspaceId: w.id });
        window.close();
      }),
    }));
  }

  $('results').replaceChildren(...out);
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
  else if (e.key === 'Enter') { e.preventDefault(); items[sel]?.run(e.shiftKey); }
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
  toast(res.duplicated ? '既に保存済みです' : 'ブックマークに保存しました');
  palette = await call('getPalette', { windowId });
  render();
}));
$('openPanel').addEventListener('click', async () => {
  try { await openManager(windowId); } catch (e) { console.warn(e); }
  window.close();
});

(async () => {
  windowId = (await chrome.windows.getCurrent()).id;
  palette = await attempt(() => call('getPalette', { windowId }));
  if (!palette) return;
  const ws = palette.state.workspaces[palette.workspaceId];
  $('wsName').textContent = ws ? ws.name : '未割り当てのウィンドウ';
  $('wsDot').replaceChildren(...(ws ? [wsIcon(ws)] : []));
  $('saveTab').disabled = !ws?.bookmarkFolderId;
  render();
})();
