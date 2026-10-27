// 同期（issue #4）の純粋ロジック。chrome API に依存しない（node --test でテストする）。
//
// chrome.storage.sync の制約（Chrome の定数）: 全体 100 KB（QUOTA_BYTES = 102,400）、1 項目 8 KB（QUOTA_BYTES_PER_ITEM = 8,192）、
// 512 項目（MAX_ITEMS）、書き込み 120 回 / 分・1,800 回 / 時。保存している state は favicon や最終アクセス時刻を含み、
// タブの変化のたびに書き換わるので、そのままでは容量・回数とも収まらない。そこで:
//   - 同期用の「ドキュメント」（この形）に縮約する: タブは URL・タイトル（100 文字まで）・固定・グループ・アクティブだけ。
//     favicon・最終アクセス時刻・最後に使っていたワークスペース・退避した Cookie・閉じたタブの履歴は同期しない
//   - ワークスペースごとに gzip + Base64 の文字列（blob）にして、8 KB 単位の項目に分割して保存する（w.<id>.<n>）。
//     設定・セッション・並び順は 1 項目（m）にまとめる
//   - 容量に収まらないときは、最後に開いた日時が古いワークスペースから順にタブだけを省く（名前・色・セッションなどは必ず同期する）
//   - 複数のブラウザで同時に変えたときは、前回同期した版（base）と比べる 3 方向マージ。片方だけが変えたらそれを採用、
//     両方が変えたら updatedAt の新しい方。削除は「base にあって片方に無い」で分かるので墓標（tombstone）は持たない
//
// 同期ドキュメントの形:
//   { v, settings, settingsAt, sessions: { id: { name, createdAt, updatedAt } }, sessionOrder, workspaceOrder, orderAt,
//     workspaces: { id: { name, color, icon, sessionId, autoClose, folder, createdAt, updatedAt, lastOpenedAt, tabs, groups, shelf, tabsOmitted? } } }
//   folder: null | { path: [フォルダ名, ...], managed }（ブックマークの ID はブラウザごとに違うので、パスで持つ）
//   tabs: [{ u, t, p?, g?, a? }]（url / title / pinned / groupKey / active）
//   shelf: [{ u, t? }]（よく開くタブ置き場。issue #34。タブと同じ縮約形で、容量超過でも省かない）

export const SYNC_DOC_VERSION = 1;
/** chrome.storage.sync の制約（実行時に chrome.storage.sync.QUOTA_BYTES などがあればそちらを使う） */
export const SYNC_QUOTA_BYTES = 102400;
export const SYNC_QUOTA_BYTES_PER_ITEM = 8192;
export const SYNC_MAX_ITEMS = 512;
/** 全体の上限に対して空けておく余裕（他の項目の書き込み失敗を避ける） */
export const SYNC_RESERVE_BYTES = 2048;
export const SYNC_META_KEY = 'm';
export const SYNC_WS_PREFIX = 'w.';
/** 同期するタイトルの長さ（URL は切らない） */
export const SYNC_TITLE_MAX = 100;
/** 端末ごとの設定（同期しない） */
export const LOCAL_ONLY_SETTINGS = Object.freeze(['syncEnabled']);

const utf8 = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

/** 文字列の UTF-8 バイト数（Chrome は JSON 文字列のバイト数で容量を数える） */
export function utf8Bytes(str) {
  const s = String(str);
  if (utf8) return utf8.encode(s).length;
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/** キーの順序に依らない正規化 JSON（同じ内容かの比較用） */
export function canon(v) {
  if (v === undefined) return 'undefined';
  return JSON.stringify(sortKeys(v));
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (v[k] !== undefined) out[k] = sortKeys(v[k]);
    }
    return out;
  }
  return v;
}

export function same(a, b) {
  return canon(a) === canon(b);
}

// ---- state → 同期ドキュメント ----

/** 同期する設定（端末ごとの項目を除く） */
export function syncSettings(settings) {
  const out = {};
  for (const [k, v] of Object.entries(settings || {})) {
    if (!LOCAL_ONLY_SETTINGS.includes(k)) out[k] = v;
  }
  return out;
}

/** 保存タブ 1 件 → 同期用の縮約形 */
export function syncTab(t) {
  const url = typeof t?.url === 'string' ? t.url : '';
  const out = { u: url };
  const title = typeof t?.title === 'string' ? t.title.slice(0, SYNC_TITLE_MAX) : '';
  if (title && title !== url) out.t = title;
  if (t?.pinned) out.p = 1;
  if (t?.groupKey) out.g = t.groupKey;
  if (t?.active) out.a = 1;
  return out;
}

export function syncTabsFrom(tabs) {
  return (Array.isArray(tabs) ? tabs : []).filter((t) => t && typeof t.url === 'string' && t.url).map(syncTab);
}

/** よく開くタブ置き場（issue #34）の縮約形 [{ u, t? }] → [{ url, title }] */
export function shelfFromSync(list) {
  return (Array.isArray(list) ? list : []).filter((t) => t && typeof t.u === 'string' && t.u).map((t) => ({
    url: t.u,
    title: typeof t.t === 'string' && t.t ? t.t : t.u,
  }));
}

/** 同期用の縮約形 → 保存タブ（favicon と最終アクセス時刻は無い） */
export function tabsFromSync(list) {
  return (Array.isArray(list) ? list : []).filter((t) => t && typeof t.u === 'string' && t.u).map((t) => ({
    url: t.u,
    title: typeof t.t === 'string' && t.t ? t.t : t.u,
    pinned: !!t.p,
    active: !!t.a,
    groupKey: typeof t.g === 'string' && t.g ? t.g : null,
    favIconUrl: '',
  }));
}

function groupsFrom(groups) {
  const out = {};
  for (const [k, g] of Object.entries(groups && typeof groups === 'object' ? groups : {})) {
    if (!g || typeof g !== 'object') continue;
    out[k] = { title: typeof g.title === 'string' ? g.title : '', color: typeof g.color === 'string' ? g.color : 'grey', collapsed: !!g.collapsed };
  }
  return out;
}

/**
 * ワークスペース 1 件の同期エントリ。folderPath: 接続フォルダのパス（配列。呼び出し側が ID から引く。無ければ ws.bookmarkFolderPath）
 */
export function syncWorkspaceEntry(ws, folderPath) {
  const path = Array.isArray(folderPath) && folderPath.length ? folderPath
    : (Array.isArray(ws.bookmarkFolderPath) && ws.bookmarkFolderPath.length ? ws.bookmarkFolderPath : null);
  return {
    name: typeof ws.name === 'string' ? ws.name : '',
    color: typeof ws.color === 'string' ? ws.color : 'grey',
    icon: typeof ws.icon === 'string' ? ws.icon : '',
    sessionId: typeof ws.sessionId === 'string' ? ws.sessionId : '',
    autoClose: ws.autoClose && typeof ws.autoClose === 'object' ? { enabled: !!ws.autoClose.enabled, days: ws.autoClose.days } : null,
    folder: path ? { path, managed: !!ws.bookmarkFolderManaged } : null,
    createdAt: Number.isFinite(ws.createdAt) ? ws.createdAt : 0,
    updatedAt: Number.isFinite(ws.updatedAt) ? ws.updatedAt : 0,
    lastOpenedAt: Number.isFinite(ws.lastOpenedAt) ? ws.lastOpenedAt : 0,
    tabs: syncTabsFrom(ws.tabs),
    groups: groupsFrom(ws.groups),
    shelf: syncTabsFrom(ws.shelf),
  };
}

/** state 全体 → 同期ドキュメント。folderPaths: { [wsId]: path[] }（接続フォルダの ID から引いたパス） */
export function buildSyncDoc(state, { folderPaths = {} } = {}) {
  const sessions = {};
  for (const [id, s] of Object.entries(state.sessions || {})) {
    sessions[id] = {
      name: typeof s?.name === 'string' ? s.name : '',
      createdAt: Number.isFinite(s?.createdAt) ? s.createdAt : 0,
      updatedAt: Number.isFinite(s?.updatedAt) ? s.updatedAt : 0,
    };
  }
  const workspaces = {};
  for (const [id, ws] of Object.entries(state.workspaces || {})) {
    if (!ws || typeof ws !== 'object') continue;
    workspaces[id] = syncWorkspaceEntry(ws, folderPaths[id]);
  }
  return {
    v: SYNC_DOC_VERSION,
    settings: syncSettings(state.settings),
    settingsAt: Number.isFinite(state.settingsAt) ? state.settingsAt : 0,
    sessions,
    sessionOrder: Array.isArray(state.sessionOrder) ? [...state.sessionOrder] : [],
    workspaceOrder: Array.isArray(state.workspaceOrder) ? [...state.workspaceOrder] : [],
    orderAt: Number.isFinite(state.orderAt) ? state.orderAt : 0,
    workspaces,
  };
}

/** ドキュメントのうち、同期ストレージの m 項目に入れる部分（ワークスペース以外） */
export function docMeta(doc) {
  if (!doc) return null;
  return {
    v: doc.v ?? SYNC_DOC_VERSION,
    settings: doc.settings || {},
    settingsAt: doc.settingsAt || 0,
    sessions: doc.sessions || {},
    sessionOrder: doc.sessionOrder || [],
    workspaceOrder: doc.workspaceOrder || [],
    orderAt: doc.orderAt || 0,
  };
}

/** m 項目とワークスペースのエントリからドキュメントを組み立てる（読み取り側） */
export function docFromParts(meta, workspaces) {
  if (!meta || typeof meta !== 'object') return null;
  return { ...docMeta(meta), workspaces: workspaces && typeof workspaces === 'object' ? workspaces : {} };
}

// ---- 3 方向マージ ----

/**
 * 1 つのエンティティ（ワークスペース / セッション / 設定 / 並び順）を、前回同期した版 base と比べて決める。
 * - 片方だけが base から変わっていれば、その側（undefined = 削除 も含む）
 * - 両方が変わっていれば、削除 vs 変更 なら変更を残し、変更 vs 変更 なら at() の新しい方（同じならローカル）
 */
export function pick3(local, remote, base, at = () => 0) {
  const l = !same(local, base);
  const r = !same(remote, base);
  if (!r) return local;
  if (!l) return remote;
  if (local === undefined) return remote;
  if (remote === undefined) return local;
  return at(remote) > at(local) ? remote : local;
}

/** 並び順の整合: 存在する id だけにし、無い id を末尾に足す（補う順は candidates の並び） */
function fixOrder(order, ids, ...candidates) {
  const out = [];
  const exists = new Set(ids);
  for (const id of [...(order || []), ...candidates.flat()]) {
    if (exists.has(id) && !out.includes(id)) out.push(id);
  }
  for (const id of ids) if (!out.includes(id)) out.push(id);
  return out;
}

/**
 * ローカル（今の state から作ったドキュメント）・リモート（同期ストレージ）・base（前回同期した版）をマージする。
 * remote が null（同期ストレージが空）なら base も無いものとして扱う（他の端末で「同期データを削除」した直後に、
 * こちらのワークスペースを「削除された」と誤って消さないため）。base が null なら初回（両方の和集合）
 */
export function mergeSyncDocs({ local, remote, base }) {
  const L = local || emptyDoc();
  const R = remote || null;
  const B = R ? (base || null) : null;
  const out = emptyDoc();

  // 設定
  const settings = pick3(
    { settings: L.settings, at: L.settingsAt },
    R ? { settings: R.settings, at: R.settingsAt } : undefined,
    B ? { settings: B.settings, at: B.settingsAt } : undefined,
    (x) => x.at,
  ) || { settings: L.settings, at: L.settingsAt };
  out.settings = settings.settings || {};
  out.settingsAt = settings.at || 0;

  // セッション
  const sessionIds = new Set([...Object.keys(L.sessions || {}), ...Object.keys(R?.sessions || {}), ...Object.keys(B?.sessions || {})]);
  for (const id of sessionIds) {
    const s = pick3(L.sessions?.[id], R?.sessions?.[id], B?.sessions?.[id], (x) => x.updatedAt || 0);
    if (s) out.sessions[id] = s;
  }

  // ワークスペース
  const wsIds = new Set([...Object.keys(L.workspaces || {}), ...Object.keys(R?.workspaces || {}), ...Object.keys(B?.workspaces || {})]);
  for (const id of wsIds) {
    const l = L.workspaces?.[id];
    const r = R?.workspaces?.[id];
    const w = pick3(l, r, B?.workspaces?.[id], (x) => x.updatedAt || 0);
    if (!w) continue;
    const entry = { ...w };
    // 最後に開いた日時は端末ごとに進むので、常に新しい方
    entry.lastOpenedAt = Math.max(l?.lastOpenedAt || 0, r?.lastOpenedAt || 0, w.lastOpenedAt || 0);
    // 採用した側がタブを省略している（相手の端末で容量に収まらなかった）なら、もう片方のタブを残す
    if (entry.tabsOmitted) {
      const other = w === l ? r : l;
      if (other && !other.tabsOmitted) {
        entry.tabs = other.tabs;
        entry.groups = other.groups;
        delete entry.tabsOmitted;
      }
    }
    out.workspaces[id] = entry;
  }

  // 並び順（2 つの並びを 1 つのエンティティとして扱う）
  const order = pick3(
    { ws: L.workspaceOrder, ss: L.sessionOrder, at: L.orderAt },
    R ? { ws: R.workspaceOrder, ss: R.sessionOrder, at: R.orderAt } : undefined,
    B ? { ws: B.workspaceOrder, ss: B.sessionOrder, at: B.orderAt } : undefined,
    (x) => x.at,
  ) || { ws: L.workspaceOrder, ss: L.sessionOrder, at: L.orderAt };
  out.orderAt = order.at || 0;
  if (!Object.keys(out.sessions).length) {
    // 両方で別々のセッションを消して空になった。ローカルの先頭を残す
    const id = L.sessionOrder?.[0] || Object.keys(L.sessions || {})[0];
    if (id && L.sessions?.[id]) out.sessions[id] = L.sessions[id];
  }
  out.sessionOrder = fixOrder(order.ss, Object.keys(out.sessions), L.sessionOrder, R?.sessionOrder);
  out.workspaceOrder = fixOrder(order.ws, Object.keys(out.workspaces), L.workspaceOrder, R?.workspaceOrder);
  // 消えたセッションを使っていたワークスペースは先頭のセッションへ
  for (const w of Object.values(out.workspaces)) {
    if (!out.sessions[w.sessionId]) w.sessionId = out.sessionOrder[0] || '';
  }
  return out;
}

export function emptyDoc() {
  return { v: SYNC_DOC_VERSION, settings: {}, settingsAt: 0, sessions: {}, sessionOrder: [], workspaceOrder: [], orderAt: 0, workspaces: {} };
}

// ---- 同期ドキュメント → state ----

/**
 * マージ結果を state に反映した新しい state を返す（normalizeState は呼び出し側で）。
 * folderIds: { [wsId]: folderId | null }（パスから引けた接続フォルダ。引けなかった id は入れない）
 * 端末ごとの値（lastFocusedWorkspaceId・端末ごとの設定・favicon・最終アクセス時刻・接続フォルダ ID）はできるだけ保つ
 */
export function applySyncDoc(state, doc, { folderIds = {} } = {}) {
  const next = { ...state };
  next.settings = { ...state.settings };
  for (const k of Object.keys(next.settings)) {
    if (!LOCAL_ONLY_SETTINGS.includes(k)) delete next.settings[k];
  }
  Object.assign(next.settings, doc.settings || {});
  next.settingsAt = doc.settingsAt || 0;

  next.sessions = {};
  for (const [id, s] of Object.entries(doc.sessions || {})) {
    const prev = state.sessions?.[id];
    next.sessions[id] = { ...(prev || {}), id, name: s.name, createdAt: s.createdAt || prev?.createdAt || Date.now(), updatedAt: s.updatedAt || 0 };
  }
  next.sessionOrder = [...(doc.sessionOrder || [])];

  next.workspaces = {};
  for (const [id, e] of Object.entries(doc.workspaces || {})) {
    const prev = state.workspaces?.[id];
    const ws = { ...(prev || {}), id };
    ws.name = e.name;
    ws.color = e.color;
    ws.icon = e.icon || '';
    ws.sessionId = e.sessionId;
    ws.autoClose = e.autoClose ? { enabled: !!e.autoClose.enabled, days: e.autoClose.days } : null;
    ws.createdAt = e.createdAt || prev?.createdAt || Date.now();
    ws.updatedAt = e.updatedAt || 0;
    ws.lastOpenedAt = Math.max(e.lastOpenedAt || 0, prev?.lastOpenedAt || 0) || undefined;
    if (ws.lastOpenedAt === undefined) delete ws.lastOpenedAt;
    // タブ: 内容が同じなら今のタブ（favicon・最終アクセス時刻付き）を保つ。省略されていれば今のものを残す
    if (e.tabsOmitted) {
      ws.tabs = prev?.tabs || [];
      ws.groups = prev?.groups || {};
    } else if (prev && same(syncTabsFrom(prev.tabs), e.tabs || []) && same(groupsFrom(prev.groups), groupsFrom(e.groups))) {
      ws.tabs = prev.tabs;
      ws.groups = prev.groups;
    } else {
      ws.tabs = tabsFromSync(e.tabs);
      ws.groups = groupsFrom(e.groups);
    }
    // よく開くタブ置き場（issue #34）: 内容が同じなら今のものを保つ
    ws.shelf = prev && same(syncTabsFrom(prev.shelf), e.shelf || []) ? (prev.shelf || []) : shelfFromSync(e.shelf);
    // 接続フォルダ: パスから引けたらその ID、引けなければ未接続のままパスだけ覚えておく（後で引き直す・そのまま同期し返す）
    if (!e.folder) {
      ws.bookmarkFolderId = null;
      ws.bookmarkFolderManaged = false;
      delete ws.bookmarkFolderPath;
    } else if (id in folderIds && folderIds[id]) {
      ws.bookmarkFolderId = folderIds[id];
      ws.bookmarkFolderManaged = !!e.folder.managed;
      delete ws.bookmarkFolderPath;
    } else {
      ws.bookmarkFolderId = null;
      ws.bookmarkFolderManaged = !!e.folder.managed;
      ws.bookmarkFolderPath = [...e.folder.path];
    }
    next.workspaces[id] = ws;
  }
  next.workspaceOrder = [...(doc.workspaceOrder || [])];
  next.orderAt = doc.orderAt || 0;
  return next;
}

// ---- 同期ストレージの項目への分割と容量 ----

/** 項目 1 つの大きさ（Chrome の数え方: キーの長さ + 値の JSON のバイト数） */
export function syncItemBytes(key, value) {
  return utf8Bytes(key) + utf8Bytes(JSON.stringify(value));
}

export function wsChunkKey(id, n) {
  return `${SYNC_WS_PREFIX}${id}.${n}`;
}

/** 同期ストレージのキー → { id, n }（ワークスペースの項目でなければ null） */
export function parseWsChunkKey(key) {
  const m = /^w\.(.+)\.(\d+)$/.exec(String(key));
  return m ? { id: m[1], n: Number(m[2]) } : null;
}

/**
 * ワークスペース 1 件の blob（ASCII 文字列）を 1 項目 perItem バイト以下の項目に分割する。
 * 先頭の項目の値は「<項目数>|」で始まる（全部揃っているかを読み取り側で確かめる）
 */
export function chunkSyncBlob(id, blob, { perItem = SYNC_QUOTA_BYTES_PER_ITEM } = {}) {
  const s = String(blob);
  // 値は ASCII 前提（Base64）。JSON の引用符 2 文字とヘッダー分を引く
  const room = (n) => perItem - utf8Bytes(wsChunkKey(id, n)) - 2 - 8;
  const first = room(0);
  const rest = room(1);
  if (first <= 16 || rest <= 16) throw new Error('項目の上限が小さすぎます');
  const parts = [];
  // 先頭はヘッダー分を差し引いて切る
  let i = Math.min(s.length, first - 6);
  parts.push(s.slice(0, i));
  while (i < s.length) {
    parts.push(s.slice(i, i + rest));
    i += rest;
  }
  const items = {};
  parts.forEach((p, n) => { items[wsChunkKey(id, n)] = n === 0 ? `${parts.length}|${p}` : p; });
  return items;
}

/**
 * 同期ストレージの項目からワークスペース id の blob を組み立てる。項目が欠けていれば null（書き込み途中・壊れている）
 */
export function joinSyncChunks(id, items) {
  const head = items?.[wsChunkKey(id, 0)];
  if (typeof head !== 'string') return null;
  const m = /^(\d+)\|/.exec(head);
  if (!m) return null;
  const n = Number(m[1]);
  if (!(n >= 1)) return null;
  let out = head.slice(m[0].length);
  for (let i = 1; i < n; i++) {
    const p = items[wsChunkKey(id, i)];
    if (typeof p !== 'string') return null;
    out += p;
  }
  return out;
}

/** 同期ストレージの項目一覧からワークスペース id ごとの項目数（キーの存在ベース） */
export function wsChunkCounts(items) {
  const out = {};
  for (const k of Object.keys(items || {})) {
    const p = parseWsChunkKey(k);
    if (p) out[p.id] = Math.max(out[p.id] || 0, p.n + 1);
  }
  return out;
}

/** 項目の集合の合計バイト数と項目数 */
export function measureSyncItems(items) {
  let bytes = 0;
  let count = 0;
  for (const [k, v] of Object.entries(items || {})) {
    bytes += syncItemBytes(k, v);
    count++;
  }
  return { bytes, count };
}

/**
 * 容量に収めるために次にタブを省くワークスペース: まだ省いていない・タブのあるもののうち、最後に開いた日時（無ければ更新日時）が最も古いもの。
 * 無ければ null
 */
export function pickTabsToOmit(doc, omitted = new Set()) {
  let best = null;
  let bestAt = Infinity;
  for (const [id, e] of Object.entries(doc.workspaces || {})) {
    if (omitted.has(id) || e.tabsOmitted || !e.tabs?.length) continue;
    const at = e.lastOpenedAt || e.updatedAt || 0;
    if (at < bestAt) { best = id; bestAt = at; }
  }
  return best;
}

/** タブを省いたエントリ（名前・色・セッションなどはそのまま） */
export function omitTabs(entry) {
  return { ...entry, tabs: [], groups: {}, tabsOmitted: true };
}

/** 同期ストレージに書く / 消す項目を決める（内容が変わったワークスペースと m だけ）。remoteItems は今の同期ストレージの項目 */
export function diffSyncItems({ items, remoteItems, remoteDoc, doc }) {
  const set = {};
  const remove = [];
  if (!remoteDoc || !same(docMeta(doc), docMeta(remoteDoc))) set[SYNC_META_KEY] = items[SYNC_META_KEY];
  const nextCounts = wsChunkCounts(items);
  const prevCounts = wsChunkCounts(remoteItems);
  for (const id of new Set([...Object.keys(nextCounts), ...Object.keys(prevCounts)])) {
    const changed = !remoteDoc || !same(doc.workspaces[id], remoteDoc.workspaces?.[id]);
    const n = nextCounts[id] || 0;
    const p = prevCounts[id] || 0;
    if (changed) {
      for (let i = 0; i < n; i++) set[wsChunkKey(id, i)] = items[wsChunkKey(id, i)];
    }
    for (let i = n; i < p; i++) remove.push(wsChunkKey(id, i));
    // 項目数が同じでも内容が壊れて読めなかった（remoteDoc に無い）なら書き直す
    if (!changed && n && !remoteDoc?.workspaces?.[id]) {
      for (let i = 0; i < n; i++) set[wsChunkKey(id, i)] = items[wsChunkKey(id, i)];
    }
  }
  return { set, remove };
}

/** 表示用: 省略されたワークスペースの一覧（id と名前） */
export function omittedWorkspaces(doc) {
  return Object.entries(doc?.workspaces || {}).filter(([, e]) => e.tabsOmitted).map(([id, e]) => ({ id, name: e.name }));
}
