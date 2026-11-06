// 同期（issue #4）: chrome.storage.sync（Chrome / Edge のアカウントで同期される拡張用ストレージ）に、
// ワークスペース・セッション・設定を保存し、別のブラウザで同じ状態を再現する。自前のアカウントやサーバーは持たない。
// 形・分割・マージの規則は syncdoc.js（純粋ロジック）。ここは chrome API との橋渡し:
//   - 同期ストレージの読み書き（gzip + Base64 の blob を 8 KB の項目に分割、変わった項目だけ書く）
//   - 前回同期した版（base。storage.local の syncBase）と 3 方向マージし、ローカルの state を更新する
//   - 接続フォルダをパス ⇔ ID で引き直す（ブックマークの ID はブラウザごとに違う）
//   - デバウンスとまとめ書き（書き込み回数の上限 120 回 / 分・1,800 回 / 時に収める）
// runSync は store.js の serialize の中で動かす（state の read-modify-write を他の処理と直列にする）
import { t } from './i18n.js';
import { normalizeState } from './core.js';
import { loadState, saveState, serialize, setBinding, windowForWorkspace } from './store.js';
import {
  SYNC_DOC_VERSION, SYNC_QUOTA_BYTES, SYNC_QUOTA_BYTES_PER_ITEM, SYNC_MAX_ITEMS, SYNC_RESERVE_BYTES, SYNC_META_KEY,
  buildSyncDoc, mergeSyncDocs, applySyncDoc, docMeta, docFromParts, same, chunkSyncBlob, joinSyncChunks, wsChunkCounts,
  measureSyncItems, syncItemBytes, pickTabsToOmit, omitTabs, diffSyncItems, omittedWorkspaces,
} from './syncdoc.js';

/** storage.local: 前回同期した版のドキュメント（3 方向マージの base） */
export const SYNC_BASE_KEY = 'syncBase';
/** storage.local: 設定画面に出す同期の状態 */
export const SYNC_STATUS_KEY = 'syncStatus';
/** ローカルの変化を同期ストレージへ書くまでの待ち（この間の変化はまとめる） */
export const SYNC_PUSH_DELAY_MS = 10000;
/** 同期ストレージの変化（他の端末の書き込み）を取り込むまでの待ち（分割された項目が揃うのを待つ） */
export const SYNC_PULL_DELAY_MS = 2000;

export function syncAvailable() {
  return typeof chrome !== 'undefined' && !!chrome.storage?.sync;
}

/** 実行時の上限（chrome.storage.sync の定数があればそれを使う） */
export function syncLimits() {
  const s = syncAvailable() ? chrome.storage.sync : null;
  return {
    quota: s?.QUOTA_BYTES || SYNC_QUOTA_BYTES,
    perItem: s?.QUOTA_BYTES_PER_ITEM || SYNC_QUOTA_BYTES_PER_ITEM,
    maxItems: s?.MAX_ITEMS || SYNC_MAX_ITEMS,
  };
}

// ---- blob（gzip + Base64） ----

const enc = new TextEncoder();
const dec = new TextDecoder();

async function gzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** ワークスペースのエントリ → blob。先頭 1 文字が形式（z: gzip + Base64、j: Base64 のみ。CompressionStream が無い環境向け） */
export async function encodeWorkspaceBlob(entry) {
  const bytes = enc.encode(JSON.stringify(entry));
  if (typeof CompressionStream === 'function') {
    try {
      return 'z' + toBase64(await gzip(bytes));
    } catch { /* 圧縮に失敗したら非圧縮で */ }
  }
  return 'j' + toBase64(bytes);
}

export async function decodeWorkspaceBlob(blob) {
  if (typeof blob !== 'string' || blob.length < 2) throw new Error(t('blob が空です'));
  const fmt = blob[0];
  let bytes = fromBase64(blob.slice(1));
  if (fmt === 'z') bytes = await gunzip(bytes);
  else if (fmt !== 'j') throw new Error(t('未知の形式: {format}', { format: fmt }));
  return JSON.parse(dec.decode(bytes));
}

// ---- 同期ストレージの読み取り ----

/**
 * 同期ストレージの全項目を読んでドキュメントにする。
 * 戻り値: { items, doc, unreadable }。m が無ければ doc は null。項目が欠けている / 壊れているワークスペースは unreadable に入れて doc から外す
 */
export async function readRemote() {
  const items = await chrome.storage.sync.get(null);
  const meta = items[SYNC_META_KEY];
  const unreadable = [];
  if (!meta || typeof meta !== 'object') return { items, doc: null, unreadable };
  if ((meta.v || 0) > SYNC_DOC_VERSION) throw new Error(t('同期データが新しい版（v{version}）です。seiton を更新してください', { version: meta.v }));
  const workspaces = {};
  for (const id of Object.keys(wsChunkCounts(items))) {
    const blob = joinSyncChunks(id, items);
    if (blob === null) { unreadable.push(id); continue; }
    try {
      const entry = await decodeWorkspaceBlob(blob);
      if (entry && typeof entry === 'object') workspaces[id] = entry;
      else unreadable.push(id);
    } catch (e) {
      console.warn('[sync] unreadable workspace', id, e?.message || e);
      unreadable.push(id);
    }
  }
  return { items, doc: docFromParts(meta, workspaces), unreadable };
}

// ---- 接続フォルダのパス ⇔ ID ----

async function bookmarkTree() {
  try {
    const [root] = await chrome.bookmarks.getTree();
    return root;
  } catch {
    return null;
  }
}

/** フォルダ ID → ルート直下からのタイトルの配列（無ければ null） */
export async function bookmarkPaths(ids) {
  const out = {};
  const want = new Set((ids || []).filter(Boolean).map(String));
  if (!want.size) return out;
  const root = await bookmarkTree();
  if (!root) return out;
  const walk = (node, path) => {
    for (const c of node.children || []) {
      if (c.url) continue;
      const p = [...path, c.title];
      if (want.has(String(c.id))) out[String(c.id)] = p;
      walk(c, p);
    }
  };
  walk(root, []);
  return out;
}

/** パス（タイトルの配列）→ フォルダ ID（無ければ null。同名が複数あれば最初のもの） */
export async function resolveFolderPath(path) {
  if (!Array.isArray(path) || !path.length) return null;
  const root = await bookmarkTree();
  if (!root) return null;
  let node = root;
  for (const title of path) {
    const next = (node.children || []).find((c) => !c.url && c.title === title);
    if (!next) return null;
    node = next;
  }
  return node.id;
}

// ---- base と状態 ----

export async function getBase() {
  const { [SYNC_BASE_KEY]: base } = await chrome.storage.local.get(SYNC_BASE_KEY);
  return base && typeof base === 'object' ? base : null;
}

async function setBase(doc) {
  if (doc) await chrome.storage.local.set({ [SYNC_BASE_KEY]: doc });
  else await chrome.storage.local.remove(SYNC_BASE_KEY);
}

export async function getSyncStatus() {
  const { [SYNC_STATUS_KEY]: st } = await chrome.storage.local.get(SYNC_STATUS_KEY);
  const state = await loadState();
  const lim = syncLimits();
  let bytesInUse = null;
  if (syncAvailable()) {
    try { bytesInUse = await chrome.storage.sync.getBytesInUse(null); } catch { /* 未対応 */ }
  }
  return {
    available: syncAvailable(),
    enabled: !!state.settings.syncEnabled,
    quota: lim.quota,
    perItem: lim.perItem,
    maxItems: lim.maxItems,
    bytesInUse,
    lastSyncAt: null, bytes: null, items: null, omitted: [], unreadable: [], error: null, applied: false,
    ...(st && typeof st === 'object' ? st : {}),
  };
}

async function writeStatus(patch) {
  const { [SYNC_STATUS_KEY]: prev } = await chrome.storage.local.get(SYNC_STATUS_KEY);
  await chrome.storage.local.set({ [SYNC_STATUS_KEY]: { ...(prev && typeof prev === 'object' ? prev : {}), ...patch } });
}

// ---- 容量に収める ----

/**
 * ドキュメントを項目に変換し、全体の上限・項目数に収まるまで、最後に開いた日時が古いワークスペースからタブを省く。
 * 戻り値: { doc（省略を反映）, items, bytes, count, omitted }
 */
export async function fitSyncDoc(doc, lim = syncLimits()) {
  const d = { ...doc, workspaces: { ...doc.workspaces } };
  const blobs = {};
  for (const [id, e] of Object.entries(d.workspaces)) blobs[id] = await encodeWorkspaceBlob(e);
  const omitted = new Set(Object.keys(d.workspaces).filter((id) => d.workspaces[id].tabsOmitted));
  const build = () => {
    const items = { [SYNC_META_KEY]: docMeta(d) };
    for (const [id, blob] of Object.entries(blobs)) Object.assign(items, chunkSyncBlob(id, blob, { perItem: lim.perItem }));
    return items;
  };
  let items = build();
  const metaBytes = syncItemBytes(SYNC_META_KEY, items[SYNC_META_KEY]);
  if (metaBytes > lim.perItem) {
    throw new Error(t('設定・セッション・並び順が 1 項目の上限（{limit} バイト）を超えています（{bytes} バイト）。ワークスペースかセッションを減らしてください', { limit: lim.perItem.toLocaleString(), bytes: metaBytes.toLocaleString() }));
  }
  let m = measureSyncItems(items);
  while (m.bytes > lim.quota - SYNC_RESERVE_BYTES || m.count > lim.maxItems) {
    const id = pickTabsToOmit(d, omitted);
    if (!id) throw new Error(t('同期ストレージの容量（{limit} バイト）に収まりません（{bytes} バイト）', { limit: lim.quota.toLocaleString(), bytes: m.bytes.toLocaleString() }));
    d.workspaces[id] = omitTabs(d.workspaces[id]);
    omitted.add(id);
    blobs[id] = await encodeWorkspaceBlob(d.workspaces[id]);
    items = build();
    m = measureSyncItems(items);
  }
  return { doc: d, items, bytes: m.bytes, count: m.count, omitted: omittedWorkspaces(d) };
}

// ---- 同期の本体 ----

let afterApply = null;

/** state をリモートから書き換えた後に呼ぶ処理（アラームやワークスペースタブの再設定）を登録する */
export function configureSync({ onApplied } = {}) {
  afterApply = typeof onApplied === 'function' ? onApplied : null;
}

/**
 * 取り込み → マージ → 書き出し を 1 回行う。serialize の中から呼ぶこと。
 * 戻り値: 状態（getSyncStatus と同じ形）。同期が OFF なら何もしない
 */
export async function runSync({ force = false } = {}) {
  const state = await loadState();
  if (!state.settings.syncEnabled && !force) return getSyncStatus();
  if (!syncAvailable()) {
    await writeStatus({ error: t('このブラウザでは chrome.storage.sync が使えません'), applied: false });
    return getSyncStatus();
  }
  try {
    const remote = await readRemote();
    const base = await getBase();
    const paths = await bookmarkPaths(Object.values(state.workspaces).map((w) => w.bookmarkFolderId));
    const folderPaths = {};
    for (const ws of Object.values(state.workspaces)) {
      if (ws.bookmarkFolderId && paths[String(ws.bookmarkFolderId)]) folderPaths[ws.id] = paths[String(ws.bookmarkFolderId)];
    }
    const local = buildSyncDoc(state, { folderPaths });
    // 読めなかったワークスペース（他の端末が書いている途中など）は「変わっていない」として扱い、削除とみなさない
    let remoteForMerge = remote.doc;
    if (remote.doc && remote.unreadable.length) {
      remoteForMerge = { ...remote.doc, workspaces: { ...remote.doc.workspaces } };
      for (const id of remote.unreadable) {
        const known = base?.workspaces?.[id] || local.workspaces[id];
        if (known) remoteForMerge.workspaces[id] = known;
      }
    }
    const merged = mergeSyncDocs({ local, remote: remoteForMerge, base });

    let applied = false;
    if (!same(merged, local)) {
      const folderIds = {};
      for (const [id, e] of Object.entries(merged.workspaces)) {
        if (!e.folder) continue;
        const ws = state.workspaces[id];
        if (ws?.bookmarkFolderId && same(folderPaths[id], e.folder.path)) folderIds[id] = ws.bookmarkFolderId;
        else {
          const found = await resolveFolderPath(e.folder.path);
          if (found) folderIds[id] = found;
        }
      }
      const next = normalizeState(applySyncDoc(state, merged, { folderIds }));
      // 消えたワークスペースを開いていたウィンドウは未割り当てにする（タブは閉じない）
      for (const id of Object.keys(state.workspaces)) {
        if (next.workspaces[id]) continue;
        const win = await windowForWorkspace(id);
        if (win !== null) await setBinding(win, null);
      }
      await saveState(next);
      applied = true;
    } else {
      // 内容は同じでも、パスだけ覚えている接続フォルダが今は見つかるなら接続する（他の端末で作ったフォルダが同期されてきたとき）
      let changed = false;
      for (const ws of Object.values(state.workspaces)) {
        if (ws.bookmarkFolderId || !Array.isArray(ws.bookmarkFolderPath)) continue;
        const found = await resolveFolderPath(ws.bookmarkFolderPath);
        if (!found) continue;
        ws.bookmarkFolderId = found;
        delete ws.bookmarkFolderPath;
        changed = true;
      }
      if (changed) await saveState(state);
    }

    const fitted = await fitSyncDoc(merged);
    const { set, remove } = diffSyncItems({ items: fitted.items, remoteItems: remote.items, remoteDoc: remote.doc, doc: fitted.doc });
    // 自分の書き込みも storage.onChanged（sync）を起こし、もう一度 runSync が予約されるが、内容が同じなので何も書かない
    if (remove.length) await chrome.storage.sync.remove(remove);
    if (Object.keys(set).length) await chrome.storage.sync.set(set);
    await setBase(fitted.doc);
    await writeStatus({
      lastSyncAt: Date.now(), bytes: fitted.bytes, items: fitted.count, omitted: fitted.omitted,
      unreadable: remote.unreadable, error: null, applied,
      wrote: Object.keys(set).length + remove.length,
    });
    if (applied && afterApply) {
      try { await afterApply(await loadState()); } catch (e) { console.warn('[sync] afterApply failed', e); }
    }
  } catch (e) {
    console.warn('[sync] failed', e);
    await writeStatus({ error: e?.message || String(e), applied: false });
  }
  return getSyncStatus();
}

// ---- 予約（デバウンス） ----

let timer = null;

/** delay ms 後に runSync を直列キューで実行する（既に予約があれば置き換える） */
export function scheduleSync(delay = SYNC_PUSH_DELAY_MS) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    serialize(() => runSync()).catch((e) => console.warn('[sync] scheduled run failed', e));
  }, delay);
}

export function cancelScheduledSync() {
  clearTimeout(timer);
  timer = null;
}

/** 同期の ON / OFF。ON にしたときは base を捨てて初回同期（ローカルとリモートの和集合）を行う */
export async function setSyncEnabled(enabled) {
  const state = await loadState();
  state.settings.syncEnabled = !!enabled;
  await saveState(state);
  if (enabled) {
    await setBase(null);
    await writeStatus({ error: null, lastSyncAt: null, omitted: [], unreadable: [] });
    return runSync();
  }
  cancelScheduledSync();
  return getSyncStatus();
}

/** 同期ストレージを空にして同期を OFF にする（他の端末のローカルデータは消えない。ON のままだと次の同期で書き戻されるため OFF にする） */
export async function clearSyncData() {
  cancelScheduledSync();
  const state = await loadState();
  if (state.settings.syncEnabled) {
    state.settings.syncEnabled = false;
    await saveState(state);
  }
  if (syncAvailable()) await chrome.storage.sync.clear();
  await setBase(null);
  await chrome.storage.local.remove(SYNC_STATUS_KEY);
  return getSyncStatus();
}
