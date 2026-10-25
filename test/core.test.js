import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  snapshotTabs, urlOverlap, matchWindowsToWorkspaces, missingTabs, shouldRouteBookmark,
  neighborWorkspace, normalizeState, defaultState, matchesQuery, planRestore, isManagerUrl, managerPopupBounds,
  workspacesUsingSession, normalizeIcon, ICONS, ICON_GROUPS,
  TAB_DRAG_TYPE, isBookmarkableUrl, firstUriFromList, parseTabDragData, findBookmarkByUrl,
  COLORS, COLOR_HEX, firstGrapheme, indicatorLabel, changedBindingWindows, indicatorSignature, UNASSIGNED_INDICATOR_TITLE,
  workspaceHotkey, hotkeyToIndex,
  DEFAULT_SETTINGS, parseAutoCloseDays, normalizeAutoClose, normalizeAutoCloseOverride, effectiveAutoClose,
  isAutoCloseActive, tabsToAutoClose, effectiveLastAccessed,
} from '../src/lib/core.js';

test('COLOR_HEX: 全ての色名に hex がある', () => {
  for (const c of COLORS) assert.match(COLOR_HEX[c], /^#[0-9a-f]{6}$/);
});

test('firstGrapheme: サロゲートペア・結合文字・ZWJ 絵文字を壊さない', () => {
  assert.equal(firstGrapheme('案件A'), '案');
  assert.equal(firstGrapheme('  abc'), 'a');
  assert.equal(firstGrapheme('𠮷野家'), '𠮷');
  assert.equal(firstGrapheme('éx'), 'é');
  assert.equal(firstGrapheme('👨‍👩‍👧 家族'), '👨‍👩‍👧');
  assert.equal(firstGrapheme(''), '');
  assert.equal(firstGrapheme(null), '');
});

test('indicatorLabel: 絵文字があればそれ、無ければ名前の先頭 1 文字、名前も空なら ?', () => {
  assert.deepEqual(indicatorLabel({ name: '案件A', color: 'blue', icon: '💼' }, 'AWS 本番'), {
    text: '💼', emoji: true, color: COLOR_HEX.blue, title: 'seiton — 案件A（AWS 本番）',
  });
  const noIcon = indicatorLabel({ name: 'research', color: 'red', icon: '' }, 'デフォルト');
  assert.equal(noIcon.text, 'r');
  assert.equal(noIcon.emoji, false);
  assert.equal(noIcon.color, COLOR_HEX.red);
  assert.equal(noIcon.title, 'seiton — research（デフォルト）');
  const empty = indicatorLabel({ name: '  ', color: 'nope' }, '');
  assert.equal(empty.text, '?');
  assert.equal(empty.color, COLOR_HEX.grey, '不明な色は grey');
  assert.equal(empty.title, 'seiton — (名前なし)', 'セッション名が無ければ括弧を付けない');
  assert.equal(indicatorLabel({ name: 'x', icon: 'a b' }, 's').emoji, false, '不正なアイコンは未設定扱い');
});

test('indicatorLabel: 未割り当て', () => {
  const l = indicatorLabel(null);
  assert.equal(l.title, UNASSIGNED_INDICATOR_TITLE);
  assert.equal(l.title, 'seiton — 未割り当て（クイックパレット）');
  assert.equal(l.color, null);
  assert.equal(l.text, '');
});

test('changedBindingWindows: 新旧の差分の windowId', () => {
  assert.deepEqual(changedBindingWindows({ 1: 'a', 2: 'b' }, { 1: 'a', 2: 'c', 3: 'd' }).sort(), [2, 3]);
  assert.deepEqual(changedBindingWindows({ 1: 'a' }, {}), [1]);
  assert.deepEqual(changedBindingWindows(undefined, { 5: 'x' }), [5]);
  assert.deepEqual(changedBindingWindows({ 1: 'a' }, { 1: 'a' }), []);
});

test('indicatorSignature: タブだけの変更では変わらず、名前・色・アイコン・セッション名で変わる', () => {
  const base = defaultState();
  base.workspaces.w1 = { id: 'w1', name: 'A', color: 'blue', icon: '', sessionId: base.sessionOrder[0], tabs: [] };
  const sig = indicatorSignature(base);
  const clone = () => JSON.parse(JSON.stringify(base));
  const tabsOnly = clone();
  tabsOnly.workspaces.w1.tabs = [{ url: 'https://a' }];
  tabsOnly.lastFocusedWorkspaceId = 'w1';
  assert.equal(indicatorSignature(tabsOnly), sig);
  for (const mut of [
    (s) => { s.workspaces.w1.name = 'B'; },
    (s) => { s.workspaces.w1.color = 'red'; },
    (s) => { s.workspaces.w1.icon = '💼'; },
    (s) => { s.sessions[s.sessionOrder[0]].name = '別名'; },
    (s) => { delete s.workspaces.w1; },
  ]) {
    const s = clone();
    mut(s);
    assert.notEqual(indicatorSignature(s), sig);
  }
  assert.equal(typeof indicatorSignature(undefined), 'string');
});

test('snapshotTabs: 並び順・グループ・除外 URL', () => {
  const tabs = [
    { index: 2, url: 'https://b.example/', title: 'B', groupId: 7 },
    { index: 0, url: 'chrome-extension://abc/popup.html', title: 'ext' },
    { index: 1, pendingUrl: 'https://a.example/', title: '', pinned: true, active: true, groupId: -1, favIconUrl: 'data:image/png;base64,xx' },
  ];
  const snap = snapshotTabs(tabs, { 7: { title: '調査', color: 'blue', collapsed: true } });
  assert.deepEqual(snap.tabs.map((t) => t.url), ['https://a.example/', 'https://b.example/']);
  assert.equal(snap.tabs[0].pinned, true);
  assert.equal(snap.tabs[0].title, 'https://a.example/');
  assert.equal(snap.tabs[0].favIconUrl, '', 'data URL の favicon は保存しない');
  assert.equal(snap.tabs[1].groupKey, 'g7');
  assert.deepEqual(snap.groups.g7, { title: '調査', color: 'blue', collapsed: true });
});

test('urlOverlap: 末尾スラッシュとフラグメントは無視、空タブは数えない', () => {
  assert.equal(urlOverlap(['https://a/x#1', 'https://b/'], ['https://a/x', 'https://b', 'chrome://newtab/']), 1);
  assert.equal(urlOverlap(['https://a'], ['chrome://newtab/']), 0);
  assert.equal(urlOverlap([], []), 0);
  assert.equal(urlOverlap(['https://a', 'https://b'], ['https://a', 'https://c', 'https://d', 'https://e']), 0.25);
});

test('matchWindowsToWorkspaces: スコアの高い順に 1 対 1 で対応付け', () => {
  const windows = [
    { windowId: 1, urls: ['https://a', 'https://b', 'https://c'] },
    { windowId: 2, urls: ['https://x', 'https://y'] },
    { windowId: 3, urls: ['chrome://newtab/'] },
  ];
  const candidates = [
    { workspaceId: 'w1', urls: ['https://a', 'https://b', 'https://c'] },
    { workspaceId: 'w2', urls: ['https://x', 'https://y', 'https://z'] },
    { workspaceId: 'w3', urls: ['https://a'] },
  ];
  const m = matchWindowsToWorkspaces(windows, candidates);
  assert.deepEqual(Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.workspaceId])), { 1: 'w1', 2: 'w2' });
  assert.equal(m[1].score, 1);
});

test('matchWindowsToWorkspaces: 共通 URL 1 件だけでは対応付けない', () => {
  const windows = [{ windowId: 1, urls: ['https://mail.google.com/mail/u/0', 'https://x', 'https://y'] }];
  const candidates = [{ workspaceId: 'w2', urls: ['https://mail.google.com/mail/u/0', 'https://app.slack.com'] }];
  assert.deepEqual(matchWindowsToWorkspaces(windows, candidates), {});
  // 保存が 1 件だけのワークスペースは、ウィンドウ側も同じ 1 件なら対応付ける
  assert.deepEqual(
    matchWindowsToWorkspaces([{ windowId: 1, urls: ['https://a', 'chrome://newtab/'] }], [{ workspaceId: 'w', urls: ['https://a'] }]),
    { 1: { workspaceId: 'w', score: 1 } },
  );
});

test('isManagerUrl: 管理パネルの拡張ページだけ', () => {
  assert.equal(isManagerUrl('chrome-extension://abc/src/ui/sidepanel.html'), true);
  assert.equal(isManagerUrl('chrome-extension://abc/src/ui/sidepanel.html?x=1'), true);
  assert.equal(isManagerUrl('chrome-extension://abc/src/ui/popup.html'), false);
  assert.equal(isManagerUrl('https://example.com/src/ui/sidepanel.html'), false);
});

test('planRestore: 前面にするタブは最後の active 印の 1 件', () => {
  const many = planRestore([
    { url: 'https://a', active: true },
    { url: 'chrome-extension://abc/ui.html', active: true },
    { url: 'https://b', active: false },
    { url: 'https://c', active: true },
  ]);
  assert.deepEqual(many.tabs.map((t) => t.url), ['https://a', 'https://b', 'https://c']);
  assert.equal(many.activeIndex, 2);

  const none = planRestore([{ url: 'https://a' }, { url: 'https://b' }]);
  assert.equal(none.activeIndex, 1, '印が無ければ末尾だけを前面にする');

  const empty = planRestore([]);
  assert.deepEqual(empty.tabs, []);
  assert.equal(empty.activeIndex, -1);
});

test('missingTabs: 現在のウィンドウに無いタブだけ返す', () => {
  const saved = [{ url: 'https://a/' }, { url: 'https://b' }];
  assert.deepEqual(missingTabs(saved, ['https://a']), [{ url: 'https://b' }]);
});

test('shouldRouteBookmark: アクティブタブと同じ URL のブックマークだけ移動', () => {
  const base = {
    node: { id: '10', parentId: '1', url: 'https://a/' },
    enabled: true, importing: false, ownIds: new Set(), targetFolderId: '99', activeTabUrl: 'https://a',
  };
  assert.equal(shouldRouteBookmark(base), true);
  assert.equal(shouldRouteBookmark({ ...base, enabled: false }), false);
  assert.equal(shouldRouteBookmark({ ...base, importing: true }), false);
  assert.equal(shouldRouteBookmark({ ...base, node: { id: '10', parentId: '1' } }), false, 'フォルダは対象外');
  assert.equal(shouldRouteBookmark({ ...base, ownIds: new Set(['10']) }), false);
  assert.equal(shouldRouteBookmark({ ...base, node: { ...base.node, parentId: '99' } }), false);
  assert.equal(shouldRouteBookmark({ ...base, activeTabUrl: 'https://other' }), false, '同期など別経路のブックマーク');
  assert.equal(shouldRouteBookmark({ ...base, targetFolderId: null }), false);
});

test('neighborWorkspace: 端でループ', () => {
  assert.equal(neighborWorkspace(['a', 'b', 'c'], 'c', 1), 'a');
  assert.equal(neighborWorkspace(['a', 'b', 'c'], 'a', -1), 'c');
  assert.equal(neighborWorkspace(['a', 'b'], 'zz', 1), 'a');
  assert.equal(neighborWorkspace([], 'a', 1), null);
});

test('normalizeState: 壊れたデータを補正', () => {
  assert.deepEqual(Object.keys(normalizeState(null).sessions), Object.keys(defaultState().sessions));
  const s = normalizeState({
    sessions: { s1: { id: 's1', name: 'S' } },
    workspaces: { w1: { id: 'w1', name: 'W', sessionId: 'missing' } },
    workspaceOrder: ['gone', 'w1'],
    lastFocusedWorkspaceId: 'gone',
    settings: { autoDiscardMinutes: 30 },
  });
  assert.deepEqual(s.sessionOrder, ['s1']);
  assert.deepEqual(s.workspaceOrder, ['w1']);
  assert.equal(s.workspaces.w1.sessionId, 's1', '存在しないセッションを使うワークスペースは先頭のセッションへ');
  assert.deepEqual(s.workspaces.w1.tabs, []);
  assert.equal(s.lastFocusedWorkspaceId, null);
  assert.equal(s.settings.autoDiscardMinutes, 30);
  assert.equal(s.settings.lazyRestore, true);
  assert.equal(s.version, 2);
});

test('normalizeState: v1（セッションが workspaceIds を持つ形）から並び順を引き継ぐ', () => {
  const s = normalizeState({
    version: 1,
    sessions: {
      s1: { id: 's1', name: '仕事', workspaceIds: ['w2', 'w1'], lastWorkspaceId: 'w1' },
      s2: { id: 's2', name: '個人', workspaceIds: ['w3'], lastWorkspaceId: null },
    },
    sessionOrder: ['s1', 's2'],
    workspaces: {
      w1: { id: 'w1', name: 'A', sessionId: 's1', tabs: [] },
      w2: { id: 'w2', name: 'B', sessionId: 's1', tabs: [] },
      w3: { id: 'w3', name: 'C', sessionId: 's2', tabs: [] },
      w4: { id: 'w4', name: 'D（どのセッションにも載っていない）', sessionId: 's2', tabs: [] },
    },
  });
  assert.deepEqual(s.workspaceOrder, ['w2', 'w1', 'w3', 'w4']);
  assert.deepEqual(s.sessions.s1, { id: 's1', name: '仕事', createdAt: s.sessions.s1.createdAt }, 'workspaceIds / lastWorkspaceId は持たない');
  assert.deepEqual(workspacesUsingSession(s, 's2'), ['w3', 'w4']);
  assert.deepEqual(workspacesUsingSession(s, 'none'), []);
});

test('matchesQuery: 空白区切りの AND 検索', () => {
  assert.equal(matchesQuery('GitHub Pull Request', 'git pull'), true);
  assert.equal(matchesQuery('GitHub', 'git lab'), false);
  assert.equal(matchesQuery('x', ''), true);
});

test('normalizeIcon: 絵文字は保持、空白入り・長すぎ・文字列以外は未設定', () => {
  assert.equal(normalizeIcon('💼'), '💼');
  assert.equal(normalizeIcon(' ✈️ '), '✈️');
  assert.equal(normalizeIcon('a b'), '');
  assert.equal(normalizeIcon('x'.repeat(17)), '');
  assert.equal(normalizeIcon(null), '');
  assert.equal(normalizeIcon(42), '');
  assert.ok(ICONS.length >= 8 && ICONS.every((i) => normalizeIcon(i) === i));
  assert.ok(ICON_GROUPS.some((g) => g.label === '開発' && g.icons.length >= 10));
  assert.equal(new Set(ICONS).size, ICONS.length, '重複なし');
});

test('normalizeState: ワークスペースの icon を正規化する', () => {
  const s = normalizeState({
    workspaces: {
      a: { name: 'A', icon: '🔥' },
      b: { name: 'B', icon: 'bad icon' },
      c: { name: 'C' },
    },
  });
  assert.equal(s.workspaces.a.icon, '🔥');
  assert.equal(s.workspaces.b.icon, '');
  assert.equal(s.workspaces.c.icon, '');
});

test('isBookmarkableUrl: http / https / file のみ保存可', () => {
  assert.equal(isBookmarkableUrl('https://example.com/a'), true);
  assert.equal(isBookmarkableUrl('http://localhost:3000/'), true);
  assert.equal(isBookmarkableUrl('file:///C:/tmp/a.html'), true);
  for (const url of ['chrome://settings/', 'chrome://newtab/', 'about:blank', 'chrome-extension://abc/src/ui/sidepanel.html',
    'devtools://devtools/x', 'javascript:alert(1)', 'data:text/html,x', 'not a url', '', null, undefined]) {
    assert.equal(isBookmarkableUrl(url), false, String(url));
  }
});

test('firstUriFromList: コメント行と空行を飛ばして最初の URL', () => {
  assert.equal(firstUriFromList('# comment\r\n\r\nhttps://a.example/\r\nhttps://b.example/'), 'https://a.example/');
  assert.equal(firstUriFromList(''), '');
  assert.equal(firstUriFromList('# only comment'), '');
});

test('parseTabDragData: 独自形式 → uri-list → text/plain の順', () => {
  const dt = (m) => (type) => m[type] || '';
  assert.deepEqual(
    parseTabDragData(dt({ [TAB_DRAG_TYPE]: JSON.stringify({ url: 'https://a/', title: 'A', tabId: 1 }), 'text/uri-list': 'https://x/' })),
    { url: 'https://a/', title: 'A' },
  );
  assert.deepEqual(parseTabDragData(dt({ [TAB_DRAG_TYPE]: JSON.stringify({ url: 'https://a/', title: '' }) })),
    { url: 'https://a/', title: 'https://a/' }, 'タイトルが空なら URL');
  assert.deepEqual(parseTabDragData(dt({ [TAB_DRAG_TYPE]: '{broken', 'text/uri-list': '#c\nhttps://u/' })),
    { url: 'https://u/', title: 'https://u/' });
  assert.deepEqual(parseTabDragData(dt({ 'text/plain': ' https://p/ ' })), { url: 'https://p/', title: 'https://p/' });
  assert.equal(parseTabDragData(dt({})), null);
  assert.equal(parseTabDragData(() => { throw new Error('protected'); }), null, 'getData が投げても null');
});

test('findBookmarkByUrl: フラグメント・末尾スラッシュを無視して重複を検出', () => {
  const items = [{ id: '1', url: 'https://a.example/x/' }, { id: '2', url: 'https://b.example/' }];
  assert.equal(findBookmarkByUrl(items, 'https://a.example/x#top')?.id, '1');
  assert.equal(findBookmarkByUrl(items, 'https://b.example')?.id, '2');
  assert.equal(findBookmarkByUrl(items, 'https://c.example/'), null);
  assert.equal(findBookmarkByUrl(items, ''), null);
  assert.equal(findBookmarkByUrl(null, 'https://a.example/x'), null);
});

test('managerPopupBounds: 対象ウィンドウの約 85% で中央に重ねる', () => {
  const b = managerPopupBounds({ left: 100, top: 50, width: 1600, height: 1000 });
  assert.deepEqual(b, { left: 220, top: 125, width: 1360, height: 850 });
  // 中心が一致する
  assert.equal(b.left + b.width / 2, 100 + 1600 / 2);
  assert.equal(b.top + b.height / 2, 50 + 1000 / 2);
});

test('managerPopupBounds: 小さいウィンドウでは最小サイズを確保しつつ対象ウィンドウからはみ出さない', () => {
  const b = managerPopupBounds({ left: 0, top: 0, width: 800, height: 500 });
  assert.deepEqual(b, { left: 40, top: 10, width: 720, height: 480 });
  const tiny = managerPopupBounds({ left: 10, top: 20, width: 500, height: 300 });
  assert.deepEqual(tiny, { left: 10, top: 20, width: 500, height: 300 });
});

test('managerPopupBounds: 負の座標（左側のモニター・最大化）でも整数で中央に置く', () => {
  const b = managerPopupBounds({ left: -1928, top: -8, width: 1936, height: 1056 });
  for (const v of Object.values(b)) assert.equal(Number.isInteger(v), true);
  assert.ok(b.left >= -1928 && b.left + b.width <= -1928 + 1936);
  assert.ok(b.top >= -8 && b.top + b.height <= -8 + 1056);
});

test('managerPopupBounds: bounds が無い・不正なら null', () => {
  assert.equal(managerPopupBounds(null), null);
  assert.equal(managerPopupBounds({ left: 0, top: 0 }), null);
  assert.equal(managerPopupBounds({ left: 0, top: 0, width: 0, height: 100 }), null);
  assert.equal(managerPopupBounds({ left: NaN, top: 0, width: 100, height: 100 }), null);
});

test('workspaceHotkey / hotkeyToIndex: 1〜9, 0 と index の対応', () => {
  assert.deepEqual([0, 1, 8, 9].map(workspaceHotkey), ['1', '2', '9', '0']);
  for (const i of [-1, 10, 1.5, NaN, undefined, '0']) assert.equal(workspaceHotkey(i), null);
  assert.deepEqual(['1', '2', '9', '0'].map(hotkeyToIndex), [0, 1, 8, 9]);
  for (const k of ['a', '10', '', null, undefined, 5, 'Enter']) assert.equal(hotkeyToIndex(k), null);
  for (let i = 0; i < 10; i++) assert.equal(hotkeyToIndex(workspaceHotkey(i)), i);
});

// ---- タブの自動クローズ ----

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 25, 12);
const acTab = (id, ageDays, extra = {}) => ({ id, url: `https://example.com/${id}`, lastAccessed: NOW - ageDays * DAY, ...extra });

test('tabsToAutoClose: days 日以上使っていないタブだけを返す（ちょうど days 日も対象）', () => {
  const tabs = [acTab(1, 0, { active: true }), acTab(2, 8), acTab(3, 7), acTab(4, 6.99)];
  assert.deepEqual(tabsToAutoClose(tabs, { now: NOW, days: 7 }).map((t) => t.id), [2, 3]);
});

test('tabsToAutoClose: アクティブ・固定・音声再生中・拡張ページ・lastAccessed なしは除外', () => {
  const tabs = [
    acTab(1, 30, { active: true }),
    acTab(2, 30, { pinned: true }),
    acTab(3, 30, { audible: true }),
    acTab(4, 30, { url: 'chrome-extension://abcdef/src/ui/sidepanel.html' }),
    acTab(5, 30, { url: '', pendingUrl: 'chrome-extension://abcdef/src/ui/guide.html' }),
    { id: 6, url: 'https://example.com/6' },
    acTab(7, 30, { lastAccessed: NaN }),
    acTab(8, 30),
    acTab(9, 30, { discarded: true }),
  ];
  assert.deepEqual(tabsToAutoClose(tabs, { now: NOW, days: 7 }).map((t) => t.id), [8, 9]);
});

test('tabsToAutoClose: ウィンドウの全タブが対象になる場合は最後に使ったタブを 1 つ残す', () => {
  const tabs = [acTab(1, 20), acTab(2, 10), acTab(3, 30)];
  assert.deepEqual(tabsToAutoClose(tabs, { now: NOW, days: 7 }).map((t) => t.id), [1, 3]);
  assert.deepEqual(tabsToAutoClose([acTab(1, 20)], { now: NOW, days: 7 }), []);
});

test('tabsToAutoClose: 日数や now が不正なら何も閉じない', () => {
  const tabs = [acTab(1, 0, { active: true }), acTab(2, 100)];
  for (const days of [NaN, -1, 0, 0.001, '', null, undefined, 'abc', Infinity]) {
    assert.deepEqual(tabsToAutoClose(tabs, { now: NOW, days }), [], String(days));
  }
  assert.deepEqual(tabsToAutoClose(tabs, { now: NaN, days: 7 }), []);
  assert.deepEqual(tabsToAutoClose(null, { now: NOW, days: 7 }), []);
  // 小数（動作確認用）は有効
  assert.deepEqual(tabsToAutoClose([acTab(1, 0, { active: true }), acTab(2, 0.02)], { now: NOW, days: 0.01 }).map((t) => t.id), [2]);
});

test('parseAutoCloseDays: 0.01 以上の有限数だけを受け付ける', () => {
  assert.equal(parseAutoCloseDays(7), 7);
  assert.equal(parseAutoCloseDays('0.5'), 0.5);
  assert.equal(parseAutoCloseDays(0.01), 0.01);
  for (const v of [0, -3, NaN, Infinity, '', ' ', 'x', null, undefined, true, {}]) assert.equal(parseAutoCloseDays(v), null, String(v));
});

test('normalizeAutoClose: 不正な項目は fallback（既定 OFF・7 日）で補う', () => {
  assert.deepEqual(normalizeAutoClose(undefined), { enabled: false, days: 7 });
  assert.deepEqual(normalizeAutoClose('x'), { enabled: false, days: 7 });
  assert.deepEqual(normalizeAutoClose({ enabled: true }), { enabled: true, days: 7 });
  assert.deepEqual(normalizeAutoClose({ enabled: 'yes', days: -1 }), { enabled: false, days: 7 });
  assert.deepEqual(normalizeAutoClose({ days: NaN }, { enabled: true, days: 3 }), { enabled: true, days: 3 });
  assert.deepEqual(normalizeAutoClose({ enabled: false, days: '14' }), { enabled: false, days: 14 });
});

test('normalizeState: 旧データ（autoClose なし）に既定値を補完し、既定値オブジェクトを共有しない', () => {
  const st = normalizeState({ settings: { lazyRestore: false }, workspaces: { w1: { name: 'A', tabs: [] } } });
  assert.deepEqual(st.settings.autoClose, { enabled: false, days: 7 });
  assert.equal(st.settings.lazyRestore, false);
  assert.equal(st.workspaces.w1.autoClose, null);
  assert.notEqual(st.settings.autoClose, DEFAULT_SETTINGS.autoClose);
  st.settings.autoClose.enabled = true;
  assert.deepEqual(DEFAULT_SETTINGS.autoClose, { enabled: false, days: 7 });
  assert.equal(Object.isFrozen(DEFAULT_SETTINGS.autoClose), true);
});

test('normalizeState: 壊れた autoClose を正規化する（グローバル・ワークスペースの上書き）', () => {
  const st = normalizeState({
    settings: { autoClose: { enabled: true, days: 'abc' } },
    workspaces: {
      a: { name: 'A', autoClose: { enabled: true, days: -5 } },
      b: { name: 'B', autoClose: 'x' },
      c: { name: 'C', autoClose: { enabled: false, days: 2 } },
      d: { name: 'D' },
    },
  });
  assert.deepEqual(st.settings.autoClose, { enabled: true, days: 7 });
  assert.deepEqual(st.workspaces.a.autoClose, { enabled: true, days: 7 });
  assert.equal(st.workspaces.b.autoClose, null);
  assert.deepEqual(st.workspaces.c.autoClose, { enabled: false, days: 2 });
  assert.equal(st.workspaces.d.autoClose, null);
  assert.deepEqual(defaultState().settings.autoClose, { enabled: false, days: 7 });
});

test('normalizeAutoCloseOverride: null はグローバルに従う、不正な日数は fallback を使う', () => {
  assert.equal(normalizeAutoCloseOverride(null), null);
  assert.equal(normalizeAutoCloseOverride(undefined), null);
  assert.deepEqual(normalizeAutoCloseOverride({ enabled: true, days: 3 }), { enabled: true, days: 3 });
  assert.deepEqual(normalizeAutoCloseOverride({ enabled: true, days: NaN }, { enabled: false, days: 2 }), { enabled: true, days: 2 });
  assert.deepEqual(normalizeAutoCloseOverride({ days: 5 }), { enabled: false, days: 5 });
});

test('effectiveAutoClose: ワークスペースの上書きがあればそれ、無ければグローバル設定', () => {
  const settings = { autoClose: { enabled: true, days: 7 } };
  assert.deepEqual(effectiveAutoClose(settings, null), { enabled: true, days: 7 });
  assert.deepEqual(effectiveAutoClose(settings, { autoClose: null }), { enabled: true, days: 7 });
  assert.deepEqual(effectiveAutoClose(settings, { autoClose: { enabled: false, days: 7 } }), { enabled: false, days: 7 });
  assert.deepEqual(effectiveAutoClose({ autoClose: { enabled: false, days: 7 } }, { autoClose: { enabled: true, days: 1 } }), { enabled: true, days: 1 });
  assert.deepEqual(effectiveAutoClose({}, undefined), { enabled: false, days: 7 });
});

test('isAutoCloseActive: グローバル ON か、いずれかのワークスペースの上書きが ON', () => {
  assert.equal(isAutoCloseActive(defaultState()), false);
  assert.equal(isAutoCloseActive({ settings: { autoClose: { enabled: true, days: 7 } }, workspaces: {} }), true);
  assert.equal(isAutoCloseActive({
    settings: { autoClose: { enabled: false, days: 7 } },
    workspaces: { a: { autoClose: null }, b: { autoClose: { enabled: true, days: 3 } } },
  }), true);
  assert.equal(isAutoCloseActive({
    settings: { autoClose: { enabled: false, days: 7 } },
    workspaces: { a: { autoClose: { enabled: false, days: 3 } } },
  }), false);
});

test('effectiveLastAccessed: 復元後に一度も前面になっていないタブは保存時の値を引き継ぐ', () => {
  const restoredAt = NOW - 1000;
  const inherited = { saved: NOW - 10 * DAY, restoredAt };
  // 作成時刻（復元時刻 + 猶予以内）のまま → 保存時の値
  assert.equal(effectiveLastAccessed({ lastAccessed: restoredAt - 50 }, inherited), NOW - 10 * DAY);
  assert.equal(effectiveLastAccessed({ lastAccessed: restoredAt + 1000 }, inherited), NOW - 10 * DAY);
  assert.equal(effectiveLastAccessed({}, inherited), NOW - 10 * DAY);
  // 復元後に前面にした → 自分の値
  assert.equal(effectiveLastAccessed({ lastAccessed: restoredAt + 1001 }, inherited), restoredAt + 1001);
  // 今アクティブなタブは使用中なので自分の値
  assert.equal(effectiveLastAccessed({ lastAccessed: restoredAt, active: true }, inherited), restoredAt);
  // 引き継ぎ情報が無い・壊れている
  assert.equal(effectiveLastAccessed({ lastAccessed: 5 }, undefined), 5);
  assert.equal(effectiveLastAccessed({ lastAccessed: 5 }, { saved: NaN, restoredAt }), 5);
  assert.equal(effectiveLastAccessed({}, undefined), null);
});

test('tabsToAutoClose: 切替で作り直したタブは保存時の最終アクセス時刻で判定する', () => {
  const restoredAt = NOW - 60_000;
  const tabs = [
    acTab(1, 0, { active: true }),
    { id: 2, url: 'https://example.com/2', lastAccessed: restoredAt }, // 作り直したまま触っていない
    { id: 3, url: 'https://example.com/3', lastAccessed: restoredAt + 30_000 }, // 作り直した後に前面にした
    { id: 4, url: 'https://example.com/4', lastAccessed: restoredAt }, // 保存時も最近だった
  ];
  const inherited = {
    2: { saved: NOW - 10 * DAY, restoredAt },
    3: { saved: NOW - 10 * DAY, restoredAt },
    4: { saved: NOW - 1 * DAY, restoredAt },
  };
  assert.deepEqual(tabsToAutoClose(tabs, { now: NOW, days: 7, inherited }).map((t) => t.id), [2]);
  assert.deepEqual(tabsToAutoClose(tabs, { now: NOW, days: 7 }), []);
});

test('tabsToAutoClose: 全タブが対象のとき残す 1 枚も引き継いだ時刻で選ぶ', () => {
  const restoredAt = NOW - 1000;
  const tabs = [
    { id: 1, url: 'https://example.com/1', lastAccessed: restoredAt },
    { id: 2, url: 'https://example.com/2', lastAccessed: restoredAt },
  ];
  const inherited = { 1: { saved: NOW - 9 * DAY, restoredAt }, 2: { saved: NOW - 20 * DAY, restoredAt } };
  assert.deepEqual(tabsToAutoClose(tabs, { now: NOW, days: 7, inherited }).map((t) => t.id), [2]);
});

test('snapshotTabs: lastAccessed を保存し、復元後に触っていないタブは引き継いだ値を保存する', () => {
  const restoredAt = NOW - 1000;
  const tabs = [
    { id: 1, index: 0, url: 'https://a.example/', lastAccessed: NOW - 3 * DAY },
    { id: 2, index: 1, url: 'https://b.example/', lastAccessed: restoredAt },
    { id: 3, index: 2, url: 'https://c.example/' },
  ];
  const snap = snapshotTabs(tabs, {}, { 2: { saved: NOW - 10 * DAY, restoredAt } });
  assert.equal(snap.tabs[0].lastAccessed, NOW - 3 * DAY);
  assert.equal(snap.tabs[1].lastAccessed, NOW - 10 * DAY);
  assert.equal('lastAccessed' in snap.tabs[2], false, '値が無ければ保存しない');
  assert.equal(snapshotTabs(tabs).tabs[1].lastAccessed, restoredAt);
});
