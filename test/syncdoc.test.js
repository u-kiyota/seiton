// 同期（issue #4）の純粋ロジック: ドキュメントの生成・3 方向マージ・state への反映・項目の分割・容量調整
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SYNC_TITLE_MAX, SYNC_META_KEY, LOCAL_ONLY_SETTINGS, utf8Bytes, canon, same, syncSettings, syncTab, syncTabsFrom, tabsFromSync,
  syncWorkspaceEntry, buildSyncDoc, docMeta, docFromParts, pick3, mergeSyncDocs, emptyDoc, applySyncDoc,
  syncItemBytes, wsChunkKey, parseWsChunkKey, chunkSyncBlob, joinSyncChunks, wsChunkCounts, measureSyncItems,
  pickTabsToOmit, omitTabs, diffSyncItems, omittedWorkspaces, shelfFromSync,
} from '../src/lib/syncdoc.js';
import { normalizeState, defaultState, DEFAULT_SETTINGS } from '../src/lib/core.js';

function ws(id, extra = {}) {
  return {
    id, name: `WS ${id}`, color: 'blue', icon: '', sessionId: 'sess_default', tabs: [], groups: {},
    bookmarkFolderId: null, bookmarkFolderManaged: false, createdAt: 1000, updatedAt: 1000, autoClose: null, ...extra,
  };
}

function tab(url, extra = {}) {
  return { url, title: `T ${url}`, pinned: false, active: false, groupKey: null, favIconUrl: 'https://x/fav.ico', lastAccessed: 123, ...extra };
}

function stateWith(workspaces, extra = {}) {
  const st = defaultState();
  st.sessions.sess_default.createdAt = 1;
  for (const w of workspaces) st.workspaces[w.id] = w;
  st.workspaceOrder = workspaces.map((w) => w.id);
  return normalizeState({ ...st, ...extra });
}

// ---- 縮約形 ----

test('syncTab: URL・タイトル（100 文字まで）・固定・グループ・アクティブだけにし、favicon と最終アクセス時刻は持たない', () => {
  const long = 'あ'.repeat(200);
  const t = syncTab(tab('https://a/', { title: long, pinned: true, groupKey: 'g1', active: true }));
  assert.deepEqual(t, { u: 'https://a/', t: 'あ'.repeat(SYNC_TITLE_MAX), p: 1, g: 'g1', a: 1 });
  assert.deepEqual(syncTab(tab('https://b/', { title: 'https://b/' })), { u: 'https://b/' }, 'タイトルが URL と同じなら省く');
});

test('tabsFromSync: 保存タブの形に戻す（favicon は空、タイトルが無ければ URL）', () => {
  const list = syncTabsFrom([tab('https://a/'), { url: '' }, null, tab('https://b/', { pinned: true, groupKey: 'g2' })]);
  assert.equal(list.length, 2);
  assert.deepEqual(tabsFromSync([...list, { u: 'https://c/' }]), [
    { url: 'https://a/', title: 'T https://a/', pinned: false, active: false, groupKey: null, favIconUrl: '' },
    { url: 'https://b/', title: 'T https://b/', pinned: true, active: false, groupKey: 'g2', favIconUrl: '' },
    { url: 'https://c/', title: 'https://c/', pinned: false, active: false, groupKey: null, favIconUrl: '' },
  ]);
});

test('syncSettings: 端末ごとの設定（syncEnabled）は同期しない', () => {
  assert.deepEqual(LOCAL_ONLY_SETTINGS, ['syncEnabled']);
  const s = syncSettings({ ...DEFAULT_SETTINGS, syncEnabled: true });
  assert.equal('syncEnabled' in s, false);
  assert.equal(s.lazyRestore, true);
});

test('buildSyncDoc: state から同期ドキュメントを作る（接続フォルダはパス、最後に使ったワークスペースは含めない）', () => {
  const st = stateWith([
    ws('a', { bookmarkFolderId: '11', bookmarkFolderManaged: true, tabs: [tab('https://a/')], lastOpenedAt: 5 }),
    ws('b', { bookmarkFolderPath: ['その他', 'X'] }),
    ws('c'),
  ], { lastFocusedWorkspaceId: 'a', settingsAt: 7, orderAt: 8 });
  st.settings.syncEnabled = true;
  const doc = buildSyncDoc(st, { folderPaths: { a: ['その他', 'Workspaces', 'WS a'] } });
  assert.equal(doc.v, 1);
  assert.equal('lastFocusedWorkspaceId' in doc, false);
  assert.equal('syncEnabled' in doc.settings, false);
  assert.equal(doc.settingsAt, 7);
  assert.equal(doc.orderAt, 8);
  assert.deepEqual(doc.workspaceOrder, ['a', 'b', 'c']);
  assert.deepEqual(doc.workspaces.a.folder, { path: ['その他', 'Workspaces', 'WS a'], managed: true });
  assert.deepEqual(doc.workspaces.a.tabs, [{ u: 'https://a/', t: 'T https://a/' }]);
  assert.equal(doc.workspaces.a.lastOpenedAt, 5);
  assert.deepEqual(doc.workspaces.b.folder, { path: ['その他', 'X'], managed: false }, 'ID が無くてもパスを覚えていればそれを同期する');
  assert.equal(doc.workspaces.c.folder, null);
  assert.deepEqual(doc.sessions.sess_default, { name: 'デフォルト', createdAt: 1, updatedAt: 0 });
});

test('docMeta / docFromParts: m 項目とワークスペースの往復', () => {
  const doc = buildSyncDoc(stateWith([ws('a')]));
  const meta = docMeta(doc);
  assert.equal('workspaces' in meta, false);
  assert.deepEqual(docFromParts(meta, doc.workspaces), doc);
  assert.equal(docFromParts(null, {}), null);
});

test('canon / same: キーの順序に依らず比較し、undefined の項目は無視する', () => {
  assert.ok(same({ a: 1, b: { c: 2, d: undefined } }, { b: { c: 2 }, a: 1 }));
  assert.ok(!same({ a: 1 }, { a: 2 }));
  assert.equal(canon(undefined), 'undefined');
  assert.ok(same(undefined, undefined));
  assert.ok(!same(undefined, null));
});

test('utf8Bytes: 日本語は 3 バイト', () => {
  assert.equal(utf8Bytes('abc'), 3);
  assert.equal(utf8Bytes('あい'), 6);
});

// ---- 3 方向マージ ----

test('pick3: 片方だけ変わればその側、両方変われば新しい方、削除 vs 変更 は変更', () => {
  const at = (x) => x.at;
  const B = { v: 1, at: 1 };
  assert.deepEqual(pick3({ v: 1, at: 1 }, { v: 2, at: 2 }, B, at), { v: 2, at: 2 }, 'リモートだけ変更');
  assert.deepEqual(pick3({ v: 3, at: 3 }, { v: 1, at: 1 }, B, at), { v: 3, at: 3 }, 'ローカルだけ変更');
  assert.deepEqual(pick3({ v: 3, at: 3 }, { v: 2, at: 2 }, B, at), { v: 3, at: 3 }, '両方変更: 新しいローカル');
  assert.deepEqual(pick3({ v: 3, at: 3 }, { v: 2, at: 9 }, B, at), { v: 2, at: 9 }, '両方変更: 新しいリモート');
  assert.deepEqual(pick3({ v: 3, at: 3 }, { v: 2, at: 3 }, B, at), { v: 3, at: 3 }, '同時刻はローカル');
  assert.equal(pick3(undefined, { v: 1, at: 1 }, B, at), undefined, 'ローカルで削除、リモート変更なし → 削除');
  assert.equal(pick3({ v: 1, at: 1 }, undefined, B, at), undefined, 'リモートで削除、ローカル変更なし → 削除');
  assert.deepEqual(pick3({ v: 5, at: 5 }, undefined, B, at), { v: 5, at: 5 }, 'リモートで削除、ローカル変更 → ローカルを残す');
  assert.deepEqual(pick3(undefined, { v: 5, at: 5 }, B, at), { v: 5, at: 5 }, 'ローカルで削除、リモート変更 → リモートを残す');
  assert.deepEqual(pick3({ v: 1, at: 1 }, undefined, undefined, at), { v: 1, at: 1 }, '初回（base 無し）はローカルの追加');
  assert.deepEqual(pick3(undefined, { v: 1, at: 1 }, undefined, at), { v: 1, at: 1 }, '初回はリモートの追加');
});

test('mergeSyncDocs: 初回（base 無し）は両方の和集合。同じ id は新しい方', () => {
  const local = buildSyncDoc(stateWith([ws('a', { updatedAt: 10 }), ws('x', { name: 'local x', updatedAt: 1 })]));
  const remote = buildSyncDoc(stateWith([ws('b', { updatedAt: 20 }), ws('x', { name: 'remote x', updatedAt: 2 })]));
  const m = mergeSyncDocs({ local, remote, base: null });
  assert.deepEqual(Object.keys(m.workspaces).sort(), ['a', 'b', 'x']);
  assert.equal(m.workspaces.x.name, 'remote x');
  assert.deepEqual(m.workspaceOrder, ['a', 'x', 'b'], 'ローカルの並びを基本に、無いものを末尾へ');
});

test('mergeSyncDocs: リモートが空（他の端末で同期データを削除した直後）なら base を無視してローカルを全部残す', () => {
  const base = buildSyncDoc(stateWith([ws('a'), ws('b')]));
  const local = buildSyncDoc(stateWith([ws('a'), ws('b')]));
  const m = mergeSyncDocs({ local, remote: null, base });
  assert.deepEqual(Object.keys(m.workspaces).sort(), ['a', 'b']);
});

test('mergeSyncDocs: 削除の伝播（base にあって片方に無い）と、削除 vs 変更 の扱い', () => {
  const base = buildSyncDoc(stateWith([ws('a', { updatedAt: 1 }), ws('b', { updatedAt: 1 }), ws('c', { updatedAt: 1 })]));
  // ローカルで a を削除、リモートで b を削除（c はリモートで変更）
  const local = buildSyncDoc(stateWith([ws('b', { updatedAt: 1 }), ws('c', { updatedAt: 1 })]));
  const remote = buildSyncDoc(stateWith([ws('a', { updatedAt: 1 }), ws('c', { name: 'c2', updatedAt: 5 })]));
  const m = mergeSyncDocs({ local, remote, base });
  assert.deepEqual(Object.keys(m.workspaces).sort(), ['c']);
  assert.equal(m.workspaces.c.name, 'c2');
  // ローカルで変更したものをリモートで削除 → 残る
  const local2 = buildSyncDoc(stateWith([ws('a', { name: 'a!', updatedAt: 9 })]));
  const remote2 = buildSyncDoc(stateWith([]));
  const base2 = buildSyncDoc(stateWith([ws('a', { updatedAt: 1 })]));
  assert.equal(mergeSyncDocs({ local: local2, remote: remote2, base: base2 }).workspaces.a.name, 'a!');
});

test('mergeSyncDocs: 両方で変えたワークスペースは updatedAt の新しい方。lastOpenedAt は常に大きい方', () => {
  const base = buildSyncDoc(stateWith([ws('a', { updatedAt: 1, lastOpenedAt: 1 })]));
  const local = buildSyncDoc(stateWith([ws('a', { name: 'L', updatedAt: 5, lastOpenedAt: 50 })]));
  const remote = buildSyncDoc(stateWith([ws('a', { name: 'R', updatedAt: 7, lastOpenedAt: 20 })]));
  const m = mergeSyncDocs({ local, remote, base });
  assert.equal(m.workspaces.a.name, 'R');
  assert.equal(m.workspaces.a.lastOpenedAt, 50);
});

test('mergeSyncDocs: 採用した側がタブを省略していれば、もう片方のタブを残す', () => {
  const base = buildSyncDoc(stateWith([ws('a', { updatedAt: 1, tabs: [tab('https://old/')] })]));
  const local = buildSyncDoc(stateWith([ws('a', { updatedAt: 1, tabs: [tab('https://old/')] })]));
  const remoteDoc = buildSyncDoc(stateWith([ws('a', { name: 'R', updatedAt: 9 })]));
  remoteDoc.workspaces.a = omitTabs(remoteDoc.workspaces.a);
  const m = mergeSyncDocs({ local, remote: remoteDoc, base });
  assert.equal(m.workspaces.a.name, 'R');
  assert.equal(m.workspaces.a.tabsOmitted, undefined);
  assert.deepEqual(m.workspaces.a.tabs, [{ u: 'https://old/', t: 'T https://old/' }]);
});

test('mergeSyncDocs: 設定と並び順はそれぞれの更新時刻で新しい方。セッションが消えたワークスペースは先頭のセッションへ', () => {
  const base = buildSyncDoc(stateWith([ws('a'), ws('b')], { settingsAt: 1, orderAt: 1 }));
  const localState = stateWith([ws('a'), ws('b')], { settingsAt: 1, orderAt: 10 });
  localState.workspaceOrder = ['b', 'a'];
  localState.sessions.s2 = { id: 's2', name: 'S2', createdAt: 1, updatedAt: 1 };
  localState.sessionOrder.push('s2');
  localState.workspaces.b.sessionId = 's2';
  const local = buildSyncDoc(localState);
  const remoteState = stateWith([ws('a'), ws('b')], { settingsAt: 5, orderAt: 1 });
  remoteState.settings.lazyRestore = false;
  const remote = buildSyncDoc(remoteState);
  const m = mergeSyncDocs({ local, remote, base });
  assert.equal(m.settings.lazyRestore, false, 'リモートの設定が新しい');
  assert.equal(m.settingsAt, 5);
  assert.deepEqual(m.workspaceOrder, ['b', 'a'], 'ローカルの並びが新しい');
  assert.deepEqual(m.sessionOrder, ['sess_default', 's2']);
  assert.equal(m.workspaces.b.sessionId, 's2');
  // リモートで s2 を削除（base に s2 がある状態から）
  const base2 = m;
  const local2 = m;
  const remote2 = { ...m, sessions: { sess_default: m.sessions.sess_default }, sessionOrder: ['sess_default'] };
  const m2 = mergeSyncDocs({ local: local2, remote: remote2, base: base2 });
  assert.deepEqual(Object.keys(m2.sessions), ['sess_default']);
  assert.equal(m2.workspaces.b.sessionId, 'sess_default');
});

test('mergeSyncDocs: 何も変わっていなければローカルと同じ内容', () => {
  const doc = buildSyncDoc(stateWith([ws('a', { tabs: [tab('https://a/')] })]));
  const m = mergeSyncDocs({ local: doc, remote: doc, base: doc });
  assert.ok(same(m, doc));
  assert.ok(same(mergeSyncDocs({ local: emptyDoc(), remote: null, base: null }), emptyDoc()));
});

// ---- state への反映 ----

test('applySyncDoc: 内容が同じタブは今のもの（favicon・最終アクセス時刻付き）を保ち、違えば置き換える', () => {
  const st = stateWith([ws('a', { tabs: [tab('https://a/')] }), ws('b', { tabs: [tab('https://b/')] })]);
  const doc = buildSyncDoc(st);
  doc.workspaces.b.tabs = [{ u: 'https://b2/', t: 'B2' }];
  const next = normalizeState(applySyncDoc(st, doc));
  assert.equal(next.workspaces.a.tabs[0].favIconUrl, 'https://x/fav.ico');
  assert.equal(next.workspaces.a.tabs[0].lastAccessed, 123);
  assert.deepEqual(next.workspaces.b.tabs, [{ url: 'https://b2/', title: 'B2', pinned: false, active: false, groupKey: null, favIconUrl: '' }]);
});

test('applySyncDoc: タブが省略されたエントリは今のタブを残し、新しいワークスペースなら空', () => {
  const st = stateWith([ws('a', { tabs: [tab('https://a/')] })]);
  const doc = buildSyncDoc(stateWith([ws('a', { tabs: [tab('https://a/')] }), ws('n', { tabs: [tab('https://n/')] })]));
  doc.workspaces.a = omitTabs(doc.workspaces.a);
  doc.workspaces.n = omitTabs(doc.workspaces.n);
  const next = normalizeState(applySyncDoc(st, doc));
  assert.equal(next.workspaces.a.tabs.length, 1);
  assert.deepEqual(next.workspaces.n.tabs, []);
});

test('applySyncDoc: 端末ごとの設定・最後に使ったワークスペースは保ち、消えたワークスペースは消す', () => {
  const st = stateWith([ws('a'), ws('gone')], { lastFocusedWorkspaceId: 'a' });
  st.settings.syncEnabled = true;
  const doc = buildSyncDoc(stateWith([ws('a')]));
  doc.settings.lazyRestore = false;
  const next = normalizeState(applySyncDoc(st, doc));
  assert.equal(next.settings.syncEnabled, true);
  assert.equal(next.settings.lazyRestore, false);
  assert.equal(next.lastFocusedWorkspaceId, 'a');
  assert.equal('gone' in next.workspaces, false);
  assert.deepEqual(next.workspaceOrder, ['a']);
});

test('applySyncDoc: 接続フォルダはパスから引けたら ID、引けなければ未接続のままパスを覚える', () => {
  const st = stateWith([ws('a', { bookmarkFolderId: '11', bookmarkFolderManaged: true }), ws('b'), ws('c', { bookmarkFolderId: '99' })]);
  const doc = buildSyncDoc(st, { folderPaths: { a: ['O', 'W', 'A'], c: ['O', 'W', 'C'] } });
  doc.workspaces.b.folder = { path: ['O', 'B'], managed: false };
  doc.workspaces.c.folder = null;
  const next = normalizeState(applySyncDoc(st, doc, { folderIds: { a: '11' } }));
  assert.equal(next.workspaces.a.bookmarkFolderId, '11');
  assert.equal(next.workspaces.a.bookmarkFolderPath, undefined);
  assert.equal(next.workspaces.b.bookmarkFolderId, null);
  assert.deepEqual(next.workspaces.b.bookmarkFolderPath, ['O', 'B']);
  assert.equal(next.workspaces.c.bookmarkFolderId, null, 'リモートで接続を外した');
  assert.equal(next.workspaces.c.bookmarkFolderPath, undefined);
  // 反映した state から作り直したドキュメントは元と同じ（往復しても差分が出ない）
  assert.ok(same(buildSyncDoc(next, { folderPaths: { a: ['O', 'W', 'A'] } }), doc));
});

test('normalizeState: settingsAt / orderAt / セッションの updatedAt / 接続フォルダのパスを保ち、不正なパスは捨てる', () => {
  const st = normalizeState({
    sessions: { s: { name: 'S', createdAt: 1, updatedAt: 2 } },
    workspaces: { a: { name: 'A', sessionId: 's', bookmarkFolderPath: ['x', 'y'] }, b: { name: 'B', sessionId: 's', bookmarkFolderPath: 'bad' } },
    settingsAt: 5, orderAt: 6, settings: { syncEnabled: 'yes' },
  });
  assert.equal(st.sessions.s.updatedAt, 2);
  assert.equal(st.settingsAt, 5);
  assert.equal(st.orderAt, 6);
  assert.deepEqual(st.workspaces.a.bookmarkFolderPath, ['x', 'y']);
  assert.equal('bookmarkFolderPath' in st.workspaces.b, false);
  assert.equal(st.settings.syncEnabled, false, 'boolean 以外は OFF');
  assert.equal(normalizeState(null).settingsAt, 0);
});

// ---- 項目の分割と容量 ----

test('chunkSyncBlob / joinSyncChunks: 8 KB 以下の項目に分割して戻せる。項目が欠ければ null', () => {
  const blob = 'z' + 'A'.repeat(20000);
  const items = chunkSyncBlob('ws_1', blob);
  const keys = Object.keys(items);
  assert.equal(keys.length, 3);
  assert.deepEqual(keys, ['w.ws_1.0', 'w.ws_1.1', 'w.ws_1.2']);
  for (const [k, v] of Object.entries(items)) assert.ok(syncItemBytes(k, v) <= 8192, `${k} が 8 KB を超えている`);
  assert.ok(items['w.ws_1.0'].startsWith('3|'));
  assert.equal(joinSyncChunks('ws_1', items), blob);
  const partial = { ...items };
  delete partial['w.ws_1.2'];
  assert.equal(joinSyncChunks('ws_1', partial), null);
  assert.equal(joinSyncChunks('ws_1', {}), null);
  assert.equal(joinSyncChunks('ws_1', { 'w.ws_1.0': 'junk' }), null);
  // 小さいものは 1 項目
  const one = chunkSyncBlob('ws_2', 'zabc');
  assert.deepEqual(one, { 'w.ws_2.0': '1|zabc' });
  assert.equal(joinSyncChunks('ws_2', one), 'zabc');
});

test('parseWsChunkKey / wsChunkCounts / measureSyncItems', () => {
  assert.deepEqual(parseWsChunkKey('w.ws_ab.12'), { id: 'ws_ab', n: 12 });
  assert.equal(parseWsChunkKey('m'), null);
  assert.equal(wsChunkKey('x', 2), 'w.x.2');
  const items = { m: { v: 1 }, 'w.a.0': '1|z', 'w.b.0': '2|z', 'w.b.1': 'z' };
  assert.deepEqual(wsChunkCounts(items), { a: 1, b: 2 });
  assert.deepEqual(measureSyncItems(items), { bytes: 1 + 7 + 5 + 5 + 5 + 5 + 5 + 3, count: 4 });
});

test('pickTabsToOmit / omitTabs: 最後に開いた日時が古いものから、タブのあるものだけ', () => {
  const doc = buildSyncDoc(stateWith([
    ws('old', { tabs: [tab('https://o/')], lastOpenedAt: 1 }),
    ws('new', { tabs: [tab('https://n/')], lastOpenedAt: 9 }),
    ws('empty', { lastOpenedAt: 0 }),
    ws('never', { tabs: [tab('https://v/')], updatedAt: 3 }),
  ]));
  assert.equal(pickTabsToOmit(doc), 'old');
  assert.equal(pickTabsToOmit(doc, new Set(['old'])), 'never', 'lastOpenedAt が無ければ updatedAt');
  doc.workspaces.old = omitTabs(doc.workspaces.old);
  doc.workspaces.never = omitTabs(doc.workspaces.never);
  assert.equal(pickTabsToOmit(doc), 'new');
  doc.workspaces.new = omitTabs(doc.workspaces.new);
  assert.equal(pickTabsToOmit(doc), null);
  assert.deepEqual(omittedWorkspaces(doc).map((w) => w.id).sort(), ['never', 'new', 'old']);
  assert.deepEqual(doc.workspaces.old.tabs, []);
  assert.equal(doc.workspaces.old.name, 'WS old');
});

test('diffSyncItems: 変わったワークスペースと m だけ書き、消えた / 減った項目を消し、読めなかったものは書き直す', () => {
  const doc = buildSyncDoc(stateWith([ws('a', { updatedAt: 2 }), ws('b')]));
  const items = { [SYNC_META_KEY]: docMeta(doc), 'w.a.0': '1|za', 'w.b.0': '1|zb' };
  const remoteDoc = buildSyncDoc(stateWith([ws('a', { updatedAt: 1 }), ws('b'), ws('gone')]));
  const remoteItems = { [SYNC_META_KEY]: docMeta(remoteDoc), 'w.a.0': '2|zaOLD', 'w.a.1': 'x', 'w.b.0': '1|zb', 'w.gone.0': '1|zg' };
  const { set, remove } = diffSyncItems({ items, remoteItems, remoteDoc, doc });
  assert.deepEqual(Object.keys(set).sort(), ['m', 'w.a.0'], 'a は変わった、b は同じ、m は並び順が変わった');
  assert.deepEqual(remove.sort(), ['w.a.1', 'w.gone.0']);
  // リモートが空なら全部書く
  const all = diffSyncItems({ items, remoteItems: {}, remoteDoc: null, doc });
  assert.deepEqual(Object.keys(all.set).sort(), ['m', 'w.a.0', 'w.b.0']);
  // 読めなかった（remoteDoc に無いが項目はある）b は書き直す
  const broken = { ...doc, workspaces: { a: doc.workspaces.a } }; // m は読めたが b の項目が壊れている
  const d2 = diffSyncItems({ items, remoteItems: { [SYNC_META_KEY]: docMeta(doc), 'w.a.0': '1|za', 'w.b.0': 'junk' }, remoteDoc: broken, doc });
  assert.deepEqual(Object.keys(d2.set).sort(), ['w.b.0']);
  assert.deepEqual(d2.remove, []);
});

// ---- よく開くタブ置き場（issue #34）は同期する ----

test('syncWorkspaceEntry / shelfFromSync: 置き場はタブと同じ縮約形で同期し、戻せる', () => {
  const e = syncWorkspaceEntry(ws('a', { shelf: [{ url: 'https://a/', title: 'A' }, { url: 'https://b/', title: 'https://b/' }] }));
  assert.deepEqual(e.shelf, [{ u: 'https://a/', t: 'A' }, { u: 'https://b/' }]);
  assert.deepEqual(shelfFromSync(e.shelf), [{ url: 'https://a/', title: 'A' }, { url: 'https://b/', title: 'https://b/' }]);
  assert.deepEqual(syncWorkspaceEntry(ws('b')).shelf, []);
  assert.deepEqual(shelfFromSync(undefined), []);
});

test('applySyncDoc: 置き場が同じなら今のものを保ち、違えば置き換える。タブを省いたエントリでも置き場は届く', () => {
  const shelf = [{ url: 'https://a/', title: 'A' }];
  const local = stateWith([ws('a', { shelf })]);
  const doc = buildSyncDoc(local);
  const same1 = applySyncDoc(local, doc);
  assert.equal(same1.workspaces.a.shelf, local.workspaces.a.shelf, '同じ内容なら同じ配列');
  doc.workspaces.a.shelf = [{ u: 'https://b/', t: 'B' }];
  const changed = applySyncDoc(local, doc);
  assert.deepEqual(changed.workspaces.a.shelf, [{ url: 'https://b/', title: 'B' }]);
  const omitted = omitTabs(doc.workspaces.a);
  assert.deepEqual(omitted.shelf, [{ u: 'https://b/', t: 'B' }], 'タブを省いても置き場は残る');
  const applied = applySyncDoc(local, { ...doc, workspaces: { a: omitted } });
  assert.deepEqual(applied.workspaces.a.shelf, [{ url: 'https://b/', title: 'B' }]);
  assert.equal(applied.workspaces.a.tabs, local.workspaces.a.tabs);
});
