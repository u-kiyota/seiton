// 同期（issue #4）: chrome API を偽物に差し替えて、2 台の端末（ローカル保存は別、同期ストレージは共有）で
// 取り込み → マージ → 書き出し の流れと、容量超過時のタブの省略、削除の伝播を確かめる
import { test } from 'node:test';
import assert from 'node:assert/strict';

const fake = makeFakeChrome();
globalThis.chrome = fake.chrome;
const {
  runSync, setSyncEnabled, clearSyncData, getSyncStatus, readRemote, fitSyncDoc, encodeWorkspaceBlob, decodeWorkspaceBlob,
  bookmarkPaths, resolveFolderPath, getBase, SYNC_BASE_KEY,
} = await import('../src/lib/sync.js');
const { loadState, saveState, setBinding, getBindings } = await import('../src/lib/store.js');
const { normalizeState, defaultState } = await import('../src/lib/core.js');
const { SYNC_META_KEY, SYNC_RESERVE_BYTES, wsChunkCounts, buildSyncDoc, syncItemBytes } = await import('../src/lib/syncdoc.js');

function makeFakeChrome() {
  const devices = {};
  let current = null;
  const sync = {};
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const area = (getStore) => ({
    async get(k) {
      const s = getStore();
      if (k === null || k === undefined) return clone(s);
      if (typeof k === 'string') return { [k]: clone(s[k]) };
      const out = {};
      for (const key of k) out[key] = clone(s[key]);
      return out;
    },
    async set(obj) { const s = getStore(); for (const [k, v] of Object.entries(obj)) s[k] = clone(v); },
    async remove(k) { const s = getStore(); for (const key of [].concat(k)) delete s[key]; },
    async clear() { const s = getStore(); for (const key of Object.keys(s)) delete s[key]; },
  });
  const tree = () => devices[current].bookmarks;
  const chrome = {
    storage: {
      local: area(() => devices[current].local),
      session: area(() => devices[current].session),
      sync: Object.assign(area(() => sync), {
        QUOTA_BYTES: 102400, QUOTA_BYTES_PER_ITEM: 8192, MAX_ITEMS: 512,
        async getBytesInUse() { return Object.entries(sync).reduce((n, [k, v]) => n + k.length + JSON.stringify(v).length, 0); },
      }),
    },
    bookmarks: { async getTree() { return [clone(tree())]; } },
    windows: { WINDOW_ID_NONE: -1 },
  };
  const defaultTree = () => ({
    id: '0', title: '', children: [
      { id: '1', title: 'ブックマーク バー', children: [] },
      { id: '2', title: 'その他のブックマーク', children: [{ id: '10', title: 'Workspaces', children: [{ id: '11', title: 'Work', children: [] }] }] },
    ],
  });
  return {
    chrome, sync,
    use(name) { devices[name] ||= { local: {}, session: {}, bookmarks: defaultTree() }; current = name; },
    device(name) { return devices[name]; },
  };
}

function ws(id, extra = {}) {
  return {
    id, name: `WS ${id}`, color: 'blue', icon: '', sessionId: 'sess_default', tabs: [], groups: {},
    bookmarkFolderId: null, bookmarkFolderManaged: false, createdAt: 1000, updatedAt: 1000, autoClose: null, ...extra,
  };
}
function tab(url, extra = {}) {
  return { url, title: `T ${url}`, pinned: false, active: false, groupKey: null, favIconUrl: 'https://x/fav.ico', lastAccessed: 123, ...extra };
}
async function setLocalState(workspaces, { enabled = true, ...extra } = {}) {
  const st = defaultState();
  st.sessions.sess_default.createdAt = 1;
  for (const w of workspaces) st.workspaces[w.id] = w;
  st.workspaceOrder = workspaces.map((w) => w.id);
  st.settings.syncEnabled = enabled;
  await saveState(normalizeState({ ...st, ...extra }));
}
const wsOf = async () => (await loadState()).workspaces;

test('encodeWorkspaceBlob / decodeWorkspaceBlob: gzip + Base64 で往復し、URL の多いタブ一覧は縮む', async () => {
  const entry = { name: 'テスト', tabs: Array.from({ length: 30 }, (_, i) => ({ u: `https://github.com/u-kiyota/seiton/issues/${i}`, t: `issue ${i} · u-kiyota/seiton` })) };
  const blob = await encodeWorkspaceBlob(entry);
  assert.equal(blob[0], 'z');
  assert.ok(blob.length < JSON.stringify(entry).length / 2, `圧縮が効いていない: ${blob.length} / ${JSON.stringify(entry).length}`);
  assert.deepEqual(await decodeWorkspaceBlob(blob), entry);
  await assert.rejects(decodeWorkspaceBlob('q' + btoa('{}')), /未知の形式/);
});

test('bookmarkPaths / resolveFolderPath: ID ⇔ パス', async () => {
  fake.use('A');
  assert.deepEqual(await bookmarkPaths(['11', 'nope']), { 11: ['その他のブックマーク', 'Workspaces', 'Work'] });
  assert.equal(await resolveFolderPath(['その他のブックマーク', 'Workspaces', 'Work']), '11');
  assert.equal(await resolveFolderPath(['その他のブックマーク', 'Nope']), null);
  assert.equal(await resolveFolderPath([]), null);
});

test('端末 A の内容が同期ストレージへ書かれ、端末 B が取り込む（接続フォルダはパスで引き直す）', async () => {
  fake.use('A');
  await setLocalState([
    ws('a', { tabs: [tab('https://a/'), tab('https://a2/', { pinned: true })], bookmarkFolderId: '11', bookmarkFolderManaged: true, updatedAt: 10 }),
    ws('b', { tabs: [tab('https://b/')], updatedAt: 10 }),
  ]);
  const st = await runSync();
  assert.equal(st.error, null);
  assert.equal(st.applied, false, 'リモートが空なのでローカルは変わらない');
  assert.ok(st.wrote >= 3);
  assert.ok(fake.sync[SYNC_META_KEY]);
  assert.deepEqual(wsChunkCounts(fake.sync), { a: 1, b: 1 });
  assert.ok((await getBase())?.workspaces?.a, 'base を保存した');

  fake.use('B');
  await setLocalState([]);
  const stB = await runSync();
  assert.equal(stB.error, null);
  assert.equal(stB.applied, true);
  const w = await wsOf();
  assert.deepEqual(Object.keys(w).sort(), ['a', 'b']);
  assert.equal(w.a.tabs.length, 2);
  assert.equal(w.a.tabs[0].favIconUrl, '', 'favicon は同期しない');
  assert.equal(w.a.tabs[1].pinned, true);
  assert.equal(w.a.bookmarkFolderId, '11', '同じパスのフォルダを接続した');
  assert.equal(w.a.bookmarkFolderManaged, true);
  assert.equal(stB.wrote, 0, 'B は何も書かなかった（内容が同じ）');
  assert.deepEqual((await loadState()).workspaceOrder, ['a', 'b']);
});

test('端末 B での変更が A に届く（A のタブの favicon は保たれる）。両方で同時に変えたら新しい方', async () => {
  fake.use('B');
  let s = await loadState();
  s.workspaces.a.name = 'A renamed';
  s.workspaces.a.updatedAt = 20;
  await saveState(s);
  assert.equal((await runSync()).wrote, 1);

  fake.use('A');
  const st = await runSync();
  assert.equal(st.applied, true);
  const w = await wsOf();
  assert.equal(w.a.name, 'A renamed');
  assert.equal(w.a.tabs[0].favIconUrl, 'https://x/fav.ico', 'タブの内容が同じなら今のタブを保つ');

  // 両方で b を変える: A が新しい
  s = await loadState();
  s.workspaces.b.name = 'B from A';
  s.workspaces.b.updatedAt = 40;
  await saveState(s);
  await runSync();
  fake.use('B');
  s = await loadState();
  s.workspaces.b.name = 'B from B';
  s.workspaces.b.updatedAt = 30;
  await saveState(s);
  await runSync();
  assert.equal((await wsOf()).b.name, 'B from A');
  fake.use('A');
  await runSync();
  assert.equal((await wsOf()).b.name, 'B from A');
});

test('削除の伝播: A で消すと B でも消え、開いていたウィンドウは未割り当てになる。B で変更していれば残って A に戻る', async () => {
  fake.use('A');
  let s = await loadState();
  delete s.workspaces.b;
  s.workspaceOrder = ['a'];
  s.orderAt = 50;
  await saveState(s);
  await runSync();
  assert.equal('w.b.0' in fake.sync, false);

  fake.use('B');
  await setBinding(7, 'b');
  await runSync();
  assert.equal('b' in (await wsOf()), false);
  assert.deepEqual(await getBindings(), {});

  // B で a を変更した後、A で a を削除 → B の同期で a は残り、A に戻る
  s = await loadState();
  s.workspaces.a.name = 'A edited on B';
  s.workspaces.a.updatedAt = 60;
  await saveState(s);
  fake.use('A');
  s = await loadState();
  delete s.workspaces.a;
  s.workspaceOrder = [];
  await saveState(s);
  await runSync();
  assert.deepEqual(wsChunkCounts(fake.sync), {});
  fake.use('B');
  await runSync();
  assert.equal((await wsOf()).a.name, 'A edited on B');
  assert.deepEqual(wsChunkCounts(fake.sync), { a: 1 });
  fake.use('A');
  await runSync();
  assert.equal((await wsOf()).a?.name, 'A edited on B');
});

test('設定と並び順も同期される（端末ごとの syncEnabled は同期しない）', async () => {
  fake.use('A');
  let s = await loadState();
  s.settings.lazyRestore = false;
  s.settings.autoCloseExclude = ['github.com'];
  s.settingsAt = 100;
  await saveState(s);
  await runSync();
  fake.use('B');
  s = await loadState();
  s.settings.syncEnabled = true;
  await saveState(s);
  await runSync();
  s = await loadState();
  assert.equal(s.settings.lazyRestore, false);
  assert.deepEqual(s.settings.autoCloseExclude, ['github.com']);
  assert.equal(s.settings.syncEnabled, true);
  assert.equal('syncEnabled' in fake.sync[SYNC_META_KEY].settings, false);
});

test('容量に収まらないときは、最後に開いた日時が古いワークスペースからタブだけ省き、受け取った側は今のタブを残す', async () => {
  const many = (n) => Array.from({ length: n }, (_, i) => tab(`https://example${i}.com/path/${Math.random().toString(36).slice(2)}/${'x'.repeat(40)}`, { title: `page ${i} ${Math.random().toString(36)}` }));
  fake.use('A');
  await setLocalState([
    ws('old', { tabs: many(60), lastOpenedAt: 1, updatedAt: 1 }),
    ws('mid', { tabs: many(60), lastOpenedAt: 2, updatedAt: 1 }),
    ws('new', { tabs: many(400), lastOpenedAt: 3, updatedAt: 1 }), // 圧縮しても 8 KB に収まらず複数の項目に分割される
  ]);
  await fake.chrome.storage.local.remove(SYNC_BASE_KEY);
  await fake.chrome.storage.sync.clear();
  const full = await fitSyncDoc(buildSyncDoc(await loadState()));
  assert.equal(full.omitted.length, 0);
  assert.ok(wsChunkCounts(full.items).new >= 2, 'new は複数の項目に分割される');
  // 上限を「old のタブを省けばちょうど収まる」大きさに下げる（省いたエントリにも名前などの数百バイトは残る）
  const oldBytes = Object.entries(full.items).filter(([k]) => k.startsWith('w.old.')).reduce((n, [k, v]) => n + syncItemBytes(k, v), 0);
  assert.ok(oldBytes > 1000);
  const lim = { quota: full.bytes - oldBytes + SYNC_RESERVE_BYTES + 600, perItem: 8192, maxItems: 512 };
  const fitted = await fitSyncDoc(buildSyncDoc(await loadState()), lim);
  assert.deepEqual(fitted.omitted.map((w) => w.id), ['old']);
  assert.ok(fitted.bytes <= lim.quota);
  // 項目数の上限でも省く（m + 3 件 = 4 項目に収まるまで。分割されていた new のタブが省かれる）
  const byItems = await fitSyncDoc(buildSyncDoc(await loadState()), { quota: 102400, perItem: 8192, maxItems: 4 });
  assert.ok(byItems.omitted.some((w) => w.id === 'new'));
  assert.ok(byItems.count <= 4);
  // 設定だけで 1 項目を超えると例外
  await assert.rejects(fitSyncDoc(buildSyncDoc(await loadState()), { quota: 102400, perItem: 100, maxItems: 512 }), /1 項目の上限/);

  // 実際の同期で省略 → B は old のタブを受け取らないが名前は受け取る。B が old のタブを持っていれば残す
  fake.chrome.storage.sync.QUOTA_BYTES = lim.quota;
  try {
    const st = await runSync();
    assert.equal(st.error, null);
    assert.deepEqual(st.omitted.map((w) => w.id), ['old']);
    assert.ok(st.bytes <= lim.quota);
    fake.use('B');
    await setLocalState([ws('old', { name: 'stale name', tabs: [tab('https://keep/')], lastOpenedAt: 1, updatedAt: 0 })]);
    await fake.chrome.storage.local.remove(SYNC_BASE_KEY);
    await runSync();
    const w = await wsOf();
    assert.equal(w.old.name, 'WS old', '名前は同期される');
    assert.equal(w.old.tabs.length, 1, 'タブは今のものを残す');
    assert.equal(w.new.tabs.length, 400);
    // B の old は小さいので容量に収まり、B のタブが同期ストレージに書かれる（省略が埋まる）
    const remote = await readRemote();
    assert.equal(remote.doc.workspaces.old.tabsOmitted, undefined);
    assert.deepEqual(remote.doc.workspaces.old.tabs, [{ u: 'https://keep/', t: 'T https://keep/' }]);
  } finally {
    fake.chrome.storage.sync.QUOTA_BYTES = 102400;
  }
});

test('読めないワークスペース（項目が欠けている）は削除とみなさず、書き直す', async () => {
  fake.use('A');
  await setLocalState([ws('p', { tabs: [tab('https://p/')], updatedAt: 1 }), ws('q', { tabs: [tab('https://q/')], updatedAt: 1 })]);
  await fake.chrome.storage.local.remove(SYNC_BASE_KEY);
  await fake.chrome.storage.sync.clear();
  await runSync();
  // q の項目を壊す
  fake.sync['w.q.0'] = '2|' + fake.sync['w.q.0'].slice(2);
  const st = await runSync();
  assert.deepEqual(st.unreadable, ['q']);
  assert.ok('q' in (await wsOf()), 'ローカルの q は消えない');
  assert.ok(fake.sync['w.q.0'].startsWith('1|'), '書き直した');
  assert.deepEqual((await runSync()).unreadable, []);
});

test('同期データの削除: 同期ストレージが空になり OFF になる。他の端末は消えたと誤解せず全部書き戻す', async () => {
  fake.use('A');
  const before = Object.keys(await wsOf()).sort();
  const st = await clearSyncData();
  assert.equal(st.enabled, false);
  assert.deepEqual(Object.keys(fake.sync), []);
  assert.equal(await getBase(), null);
  assert.deepEqual(Object.keys(await wsOf()).sort(), before, 'ローカルは消えない');
  assert.equal((await runSync()).lastSyncAt, null, 'OFF なら何もしない');

  // B は base を持ったまま。空のリモートを見ても削除とみなさず書き戻す
  fake.use('B');
  const wsB = Object.keys(await wsOf()).sort();
  assert.ok(wsB.length > 0);
  const stB = await runSync();
  assert.equal(stB.error, null);
  assert.deepEqual(Object.keys(await wsOf()).sort(), wsB);
  assert.deepEqual(Object.keys(wsChunkCounts(fake.sync)).sort(), wsB);
});

test('setSyncEnabled: ON で base を捨てて初回同期（和集合）、OFF は止めるだけ', async () => {
  fake.use('A');
  await setLocalState([ws('local-only', { updatedAt: 1 })], { enabled: false });
  await fake.chrome.storage.local.set({ [SYNC_BASE_KEY]: { stale: true } });
  const st = await setSyncEnabled(true);
  assert.equal(st.enabled, true);
  assert.equal(st.error, null);
  const w = await wsOf();
  assert.ok('local-only' in w);
  assert.ok(Object.keys(w).length > 1, 'リモートにあったワークスペースも取り込んだ');
  assert.ok((await getBase())?.workspaces?.['local-only']);
  const off = await setSyncEnabled(false);
  assert.equal(off.enabled, false);
  assert.equal((await loadState()).settings.syncEnabled, false);
  assert.ok(fake.sync[SYNC_META_KEY], 'OFF にしても同期ストレージは残る');
});

test('getSyncStatus: 使えない環境ではエラーを示す', async () => {
  const saved = fake.chrome.storage.sync;
  fake.chrome.storage.sync = undefined;
  try {
    const st = await getSyncStatus();
    assert.equal(st.available, false);
    await fake.chrome.storage.local.set({ state: { ...(await loadState()), settings: { ...(await loadState()).settings, syncEnabled: true } } });
    const run = await runSync();
    assert.match(run.error, /chrome\.storage\.sync/);
  } finally {
    fake.chrome.storage.sync = saved;
  }
});
