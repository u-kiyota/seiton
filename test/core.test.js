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
  isAutoCloseActive, tabsToAutoClose, autoCloseDaysFrom, autoCloseDuration, formatAutoCloseDuration, effectiveLastAccessed,
  CLOSED_TABS_MAX, trimClosedTabs, closedTabEntry, closedDayLabel, formatClockTime,
  normalizeExcludePattern, normalizeExcludePatterns, matchesExcludePattern, autoCloseExcludeMatch, excludePatternsForUrl,
  cookieUrl, cookieSetDetails, cookieRemoveDetails, cookieKey, isExpiredCookie, dedupeCookies, normalizeCookieJar, cookieHosts,
  WORKSPACE_DRAG_TYPE, parseWorkspaceDragData, moveInOrder, dropPlacement, reorderDropIndex,
  workspaceOfTab, appendSavedTabs, removeSavedTabsByUrl, takeSavedTabs, moveTabsMessage,
} from '../src/lib/core.js';

// ---- セッションごとの Cookie の分離（issue #12） ----

test('normalizeState: 旧版の cookieIsolation 設定は捨てる（権限があれば常に分ける）', () => {
  assert.equal('cookieIsolation' in DEFAULT_SETTINGS, false);
  assert.equal('cookieIsolation' in normalizeState({ settings: { cookieIsolation: true } }).settings, false);
});

test('cookieUrl: secure なら https、ドメイン Cookie の先頭の . は外し、パスを付ける', () => {
  assert.equal(cookieUrl({ domain: '.example.com', path: '/app', secure: true }), 'https://example.com/app');
  assert.equal(cookieUrl({ domain: 'example.com', path: '/', secure: false }), 'http://example.com/');
  assert.equal(cookieUrl({ domain: 'example.com' }), 'http://example.com/', 'パスが無ければ /');
});

test('cookieSetDetails: hostOnly は domain を渡さず、セッション Cookie は expirationDate を付けない', () => {
  const host = cookieSetDetails({
    name: 'sid', value: 'v', domain: 'github.com', hostOnly: true, path: '/', secure: true, httpOnly: true,
    session: false, expirationDate: 1234567890, sameSite: 'lax', storeId: '0',
  });
  assert.deepEqual(host, {
    url: 'https://github.com/', name: 'sid', value: 'v', path: '/', secure: true, httpOnly: true,
    expirationDate: 1234567890, sameSite: 'lax', storeId: '0',
  });
  const dom = cookieSetDetails({
    name: 'p', value: '', domain: '.example.com', hostOnly: false, path: '/x', secure: false, httpOnly: false, session: true,
    sameSite: 'unspecified', partitionKey: { topLevelSite: 'https://top.test' },
  });
  assert.equal(dom.domain, '.example.com');
  assert.equal('expirationDate' in dom, false);
  assert.equal(dom.url, 'http://example.com/x');
  assert.deepEqual(dom.partitionKey, { topLevelSite: 'https://top.test' });
  assert.equal(cookieSetDetails({ name: 'n', domain: 'a.test', value: undefined }).value, '', '値が無ければ空文字');
});

test('cookieRemoveDetails: url と name（と storeId / partitionKey）だけ', () => {
  assert.deepEqual(cookieRemoveDetails({ name: 'a', domain: '.x.test', path: '/', secure: true, storeId: '0' }),
    { url: 'https://x.test/', name: 'a', storeId: '0' });
  assert.deepEqual(cookieRemoveDetails({ name: 'a', domain: 'x.test', partitionKey: { topLevelSite: 'https://t.test' } }),
    { url: 'http://x.test/', name: 'a', partitionKey: { topLevelSite: 'https://t.test' } });
});

test('cookieKey / isExpiredCookie / dedupeCookies: 同じ Cookie を 1 つにまとめ、期限切れと壊れたものを除く', () => {
  const now = 1_700_000_000_000;
  const a = { name: 'a', domain: 'x.test', path: '/', storeId: '0', session: false, expirationDate: now / 1000 + 10 };
  const a2 = { ...a, value: 'newer' };
  const expired = { name: 'e', domain: 'x.test', path: '/', session: false, expirationDate: now / 1000 - 1 };
  const sess = { name: 's', domain: 'x.test', path: '/', session: true };
  const part = { ...a, name: 'a', partitionKey: { topLevelSite: 'https://t.test' } };
  assert.equal(cookieKey(a), cookieKey(a2));
  assert.notEqual(cookieKey(a), cookieKey(part), 'partitionKey が違えば別の Cookie');
  assert.equal(isExpiredCookie(expired, now), true);
  assert.equal(isExpiredCookie(sess, now), false, 'セッション Cookie は期限切れにならない');
  const out = dedupeCookies([a, a2, expired, sess, part, null, { name: 'nodomain' }, { domain: 'x.test' }], now);
  assert.deepEqual(out.map((c) => c.name), ['a', 's', 'a']);
  assert.equal(out[0].value, 'newer', '後のものが勝つ');
  assert.deepEqual(dedupeCookies(undefined), []);
});

test('normalizeCookieJar / cookieHosts', () => {
  assert.equal(normalizeCookieJar(null), null);
  assert.equal(normalizeCookieJar('x'), null);
  const jar = normalizeCookieJar({ savedAt: 'bad', cookies: [{ name: 'a', domain: '.g.test', path: '/' }, { name: 'b', domain: 'g.test' }, { name: 'c', domain: 'h.test' }] });
  assert.equal(jar.savedAt, 0);
  assert.equal(jar.cookies.length, 3);
  assert.deepEqual(cookieHosts(jar.cookies), [{ host: 'g.test', count: 2 }, { host: 'h.test', count: 1 }], '先頭の . を外して数え、多い順・名前順');
  assert.deepEqual(cookieHosts(null), []);
});

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

test('autoCloseDaysFrom: 分 / 時間 / 日 を日数に換算し、15 分未満や不正値は null', () => {
  assert.equal(autoCloseDaysFrom(7, 'days'), 7);
  assert.equal(autoCloseDaysFrom('12', 'hours'), 0.5);
  assert.ok(Math.abs(autoCloseDaysFrom(15, 'minutes') - 15 / 1440) < 1e-12);
  assert.equal(autoCloseDaysFrom(14, 'minutes'), null, '15 分未満（0.01 日未満）');
  assert.equal(autoCloseDaysFrom(1, 'weeks'), null, '不明な単位');
  assert.equal(autoCloseDaysFrom('', 'days'), null);
  assert.equal(autoCloseDaysFrom('abc', 'days'), null);
  assert.equal(autoCloseDaysFrom(-1, 'days'), null);
});

test('autoCloseDuration / formatAutoCloseDuration: 割り切れる最大の単位で表す', () => {
  assert.deepEqual(autoCloseDuration(7), { value: 7, unit: 'days' });
  assert.deepEqual(autoCloseDuration(0.5), { value: 12, unit: 'hours' });
  assert.deepEqual(autoCloseDuration(2), { value: 2, unit: 'days' });
  assert.deepEqual(autoCloseDuration(30 / 1440), { value: 30, unit: 'minutes' });
  assert.deepEqual(autoCloseDuration(90 / 1440), { value: 90, unit: 'minutes' }, '1.5 時間は分で表す');
  assert.deepEqual(autoCloseDuration(NaN), { value: 7, unit: 'days' }, '不正値は既定の 7 日');
  assert.equal(formatAutoCloseDuration(7), '7 日');
  assert.equal(formatAutoCloseDuration(0.5), '12 時間');
  assert.equal(formatAutoCloseDuration(15 / 1440), '15 分');
  // 往復
  for (const [v, u] of [[3, 'days'], [36, 'hours'], [45, 'minutes']]) assert.deepEqual(autoCloseDuration(autoCloseDaysFrom(v, u)), { value: v, unit: u });
});

test('trimClosedTabs: 新しい順の先頭から max 件を残し、古いもの（末尾）を捨てる', () => {
  assert.equal(CLOSED_TABS_MAX, 500);
  const list = Array.from({ length: 503 }, (_, i) => ({ id: `e${i}` }));
  const out = trimClosedTabs(list);
  assert.equal(out.length, 500);
  assert.equal(out[0].id, 'e0');
  assert.equal(out[499].id, 'e499');
  assert.deepEqual(trimClosedTabs(list, 2).map((e) => e.id), ['e0', 'e1']);
  assert.equal(trimClosedTabs(list.slice(0, 3)).length, 3, '上限未満はそのまま');
  assert.deepEqual(trimClosedTabs(list, 0), []);
  assert.equal(trimClosedTabs(list, -1).length, 500, '不正な max は既定の上限');
  assert.equal(trimClosedTabs(list, NaN).length, 500);
  assert.deepEqual(trimClosedTabs(null), []);
  assert.deepEqual(trimClosedTabs({ length: 3 }), []);
});

test('closedTabEntry: タブとワークスペースから履歴エントリを作る', () => {
  const tab = { id: 5, url: 'https://example.com/a', title: 'A', favIconUrl: 'https://example.com/favicon.ico' };
  const e = closedTabEntry(tab, { id: 'ws1', name: '案件A' }, 1000);
  assert.equal(typeof e.id, 'string');
  assert.ok(e.id.length > 0);
  assert.deepEqual({ ...e, id: undefined }, {
    id: undefined, url: 'https://example.com/a', title: 'A', favIconUrl: 'https://example.com/favicon.ico',
    closedAt: 1000, workspaceId: 'ws1', workspaceName: '案件A', reason: 'auto',
  });
  assert.notEqual(closedTabEntry(tab, null, 1000).id, e.id, 'id は毎回別');
});

test('closedTabEntry: 未割り当て・data: の favicon・pendingUrl', () => {
  const e = closedTabEntry({ pendingUrl: 'https://p.example/', favIconUrl: 'data:image/png;base64,AAAA' }, null, 5);
  assert.equal(e.url, 'https://p.example/');
  assert.equal(e.title, '');
  assert.equal(e.favIconUrl, '', 'data: の favicon は保存しない');
  assert.equal(e.workspaceId, null);
  assert.equal(e.workspaceName, '');
  assert.equal(e.reason, 'auto');
});

test('closedDayLabel: 今日 / 昨日 / M/D（ローカル時刻の暦日）', () => {
  const now = new Date(2026, 9, 25, 0, 30).getTime();
  assert.equal(closedDayLabel(new Date(2026, 9, 25, 0, 0).getTime(), now), '今日');
  assert.equal(closedDayLabel(new Date(2026, 9, 24, 23, 59).getTime(), now), '昨日', '日付が変わっていれば 1 分前でも昨日');
  assert.equal(closedDayLabel(new Date(2026, 9, 23, 12, 0).getTime(), now), '10/23');
  assert.equal(closedDayLabel(new Date(2025, 11, 31, 12, 0).getTime(), new Date(2026, 0, 1, 9, 0).getTime()), '昨日', '年をまたぐ');
  assert.equal(closedDayLabel(new Date(2026, 2, 1, 12, 0).getTime(), new Date(2026, 2, 3, 9, 0).getTime()), '3/1');
});

test('formatClockTime: HH:mm（ゼロ埋め）', () => {
  assert.equal(formatClockTime(new Date(2026, 9, 25, 9, 5).getTime()), '09:05');
  assert.equal(formatClockTime(new Date(2026, 9, 25, 23, 59).getTime()), '23:59');
});

// ---- 自動クローズの除外 URL（issue #20） ----

test('normalizeExcludePatterns: 空白を除き、空と重複を捨て、順序は保つ。配列でなければ空', () => {
  assert.deepEqual(normalizeExcludePatterns([' github.com ', 'github.com', '', '  ', 3, null, 'example.com/a']), ['github.com', 'example.com/a']);
  assert.deepEqual(normalizeExcludePatterns('github.com'), []);
  assert.deepEqual(normalizeExcludePatterns(undefined), []);
  assert.equal(normalizeExcludePattern('  a  '), 'a');
  assert.equal(normalizeExcludePattern(3), '');
});

test('matchesExcludePattern: ホストだけならサブドメインも含めて一致（大小は無視、似た別ホストには当てない）', () => {
  assert.equal(matchesExcludePattern('https://github.com/a/b', 'github.com'), true);
  assert.equal(matchesExcludePattern('https://api.github.com/x', 'github.com'), true);
  assert.equal(matchesExcludePattern('https://GitHub.com/x', 'github.com'), true);
  assert.equal(matchesExcludePattern('https://notgithub.com/', 'github.com'), false);
  assert.equal(matchesExcludePattern('https://github.com.evil.example/', 'github.com'), false);
  assert.equal(matchesExcludePattern('http://localhost:3000/x', 'localhost:3000'), true);
  assert.equal(matchesExcludePattern('http://localhost:4000/x', 'localhost:3000'), false);
  assert.equal(matchesExcludePattern('http://localhost:3000/x', 'localhost'), true);
});

test('matchesExcludePattern: ホスト + パスはパスの先頭（境界付き）に一致', () => {
  assert.equal(matchesExcludePattern('https://mail.google.com/mail/u/0/', 'mail.google.com/mail'), true);
  assert.equal(matchesExcludePattern('https://mail.google.com/mail', 'mail.google.com/mail'), true);
  assert.equal(matchesExcludePattern('https://mail.google.com/mail?x=1', 'mail.google.com/mail'), true);
  assert.equal(matchesExcludePattern('https://mail.google.com/mailbox', 'mail.google.com/mail'), false);
  assert.equal(matchesExcludePattern('https://mail.google.com/', 'mail.google.com/'), true);
  assert.equal(matchesExcludePattern('https://example.com/?q=1', 'example.com/?q'), true);
  // 正規表現の特殊文字はそのまま文字として扱う
  assert.equal(matchesExcludePattern('https://example.com/a.b/c', 'example.com/a.b'), true);
  assert.equal(matchesExcludePattern('https://example.com/aXb/c', 'example.com/a.b'), false);
});

test('matchesExcludePattern: スキーム付きは URL 全体の前方一致（フラグメント・末尾スラッシュは無視）', () => {
  assert.equal(matchesExcludePattern('https://example.com/a/b/c', 'https://example.com/a/b'), true);
  assert.equal(matchesExcludePattern('https://example.com/a/b?x=1#frag', 'https://example.com/a/b'), true);
  assert.equal(matchesExcludePattern('https://example.com/a/b/', 'https://example.com/a/b'), true);
  assert.equal(matchesExcludePattern('https://example.com/a/bc', 'https://example.com/a/b'), false);
  assert.equal(matchesExcludePattern('https://example.com', 'https://example.com/'), true);
  assert.equal(matchesExcludePattern('https://example.community/', 'https://example.com'), false);
  assert.equal(matchesExcludePattern('http://example.com/', 'https://example.com'), false);
  assert.equal(matchesExcludePattern('file:///C:/docs/x.html', 'file:///C:/docs'), true);
});

test('matchesExcludePattern: * は任意の文字列', () => {
  assert.equal(matchesExcludePattern('https://foo.example.com/', '*.example.com'), true);
  assert.equal(matchesExcludePattern('https://example.com/', '*.example.com'), false);
  assert.equal(matchesExcludePattern('https://example.com/1/edit', 'example.com/*/edit'), true);
  assert.equal(matchesExcludePattern('https://example.com/1/view', 'example.com/*/edit'), false);
  assert.equal(matchesExcludePattern('https://a.example.com/x', 'https://*.example.com/'), true);
});

test('matchesExcludePattern: 空・不正な入力には当てない', () => {
  assert.equal(matchesExcludePattern('https://example.com/', ''), false);
  assert.equal(matchesExcludePattern('https://example.com/', '   '), false);
  assert.equal(matchesExcludePattern('https://example.com/', null), false);
  assert.equal(matchesExcludePattern('', 'example.com'), false);
  assert.equal(matchesExcludePattern(undefined, 'example.com'), false);
  assert.equal(matchesExcludePattern('about:blank', 'example.com'), false);
  assert.equal(matchesExcludePattern('not a url', 'example.com'), false);
});

test('autoCloseExcludeMatch: 当てはまる最初のパターンを返す', () => {
  const patterns = ['github.com', 'example.com/docs'];
  assert.equal(autoCloseExcludeMatch('https://api.github.com/', patterns), 'github.com');
  assert.equal(autoCloseExcludeMatch('https://example.com/docs/1', patterns), 'example.com/docs');
  assert.equal(autoCloseExcludeMatch('https://example.com/blog', patterns), null);
  assert.equal(autoCloseExcludeMatch('https://github.com/', null), null);
  assert.equal(autoCloseExcludeMatch('', patterns), null);
});

test('tabsToAutoClose: 除外パターンに当てはまるタブは閉じない（残る 1 枚の計算にも影響しない）', () => {
  const tabs = [acTab(1, 30, { url: 'https://github.com/a' }), acTab(2, 30, { url: 'https://example.com/x' }), acTab(3, 30, { url: 'https://docs.example.com/y' })];
  assert.deepEqual(tabsToAutoClose(tabs, { now: NOW, days: 7, exclude: ['github.com'] }).map((t) => t.id), [2, 3]);
  // 除外した方が残るので、他の全タブを閉じてもウィンドウは消えない
  assert.deepEqual(tabsToAutoClose(tabs, { now: NOW, days: 7, exclude: ['example.com'] }).map((t) => t.id), [1]);
  // 除外が無ければ全タブが対象なので、最後に使ったタブ（同時刻なら先頭）を 1 つ残す
  assert.deepEqual(tabsToAutoClose(tabs, { now: NOW, days: 7, exclude: [] }).map((t) => t.id), [2, 3]);
  assert.deepEqual(tabsToAutoClose(tabs, { now: NOW, days: 7 }).map((t) => t.id), [2, 3]);
});

test('excludePatternsForUrl: このページ（フラグメント・末尾スラッシュ抜き）とサイト全体（ホスト）', () => {
  assert.deepEqual(excludePatternsForUrl('https://example.com/a/#f'), { page: 'https://example.com/a', site: 'example.com' });
  assert.deepEqual(excludePatternsForUrl('http://localhost:3000/'), { page: 'http://localhost:3000', site: 'localhost:3000' });
  assert.deepEqual(excludePatternsForUrl('about:blank'), { page: 'about:blank', site: null });
  assert.deepEqual(excludePatternsForUrl(''), { page: '', site: null });
});

test('normalizeState: autoCloseExclude の欠損・壊れた値を補い、既定の配列を共有しない', () => {
  const a = normalizeState({ settings: {} });
  assert.deepEqual(a.settings.autoCloseExclude, []);
  a.settings.autoCloseExclude.push('x');
  assert.deepEqual(normalizeState({ settings: {} }).settings.autoCloseExclude, []);
  assert.deepEqual(DEFAULT_SETTINGS.autoCloseExclude, []);
  assert.deepEqual(normalizeState({ settings: { autoCloseExclude: 'github.com' } }).settings.autoCloseExclude, []);
  assert.deepEqual(normalizeState({ settings: { autoCloseExclude: [' a ', 'a', 1, ''] } }).settings.autoCloseExclude, ['a']);
});

// ---- ワークスペースの並び替え（管理ダイアログ・ドラッグ＆ドロップ。issue #25） ----

test('moveInOrder: id を除いた並びでの toIndex に差し込む。範囲外は端に丸め、無い id は無視', () => {
  const order = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moveInOrder(order, 'a', 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveInOrder(order, 'd', 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moveInOrder(order, 'b', 1), ['a', 'b', 'c', 'd'], '同じ位置なら変わらない');
  assert.deepEqual(moveInOrder(order, 'a', 99), ['b', 'c', 'd', 'a']);
  assert.deepEqual(moveInOrder(order, 'a', -5), ['a', 'b', 'c', 'd']);
  assert.deepEqual(moveInOrder(order, 'zzz', 1), ['a', 'b', 'c', 'd'], '無い id は何もしない');
  assert.deepEqual(moveInOrder(order, 'c', undefined), ['a', 'b', 'd', 'c'], 'toIndex が無ければ末尾');
  assert.deepEqual(order, ['a', 'b', 'c', 'd'], '元の配列は変えない');
  assert.deepEqual(moveInOrder(undefined, 'a', 0), []);
});

test('dropPlacement: 行の上半分なら before、下半分なら after。高さが無ければ after', () => {
  assert.equal(dropPlacement(0, 40), 'before');
  assert.equal(dropPlacement(19, 40), 'before');
  assert.equal(dropPlacement(20, 40), 'after');
  assert.equal(dropPlacement(39, 40), 'after');
  assert.equal(dropPlacement(5, 0), 'after');
  assert.equal(dropPlacement(NaN, 40), 'after');
});

test('reorderDropIndex: 落とした行の前 / 後の index。並びが変わらない場所なら null', () => {
  const order = ['a', 'b', 'c', 'd'];
  assert.equal(reorderDropIndex(order, 'a', 'c', 'after'), 2);
  assert.deepEqual(moveInOrder(order, 'a', 2), ['b', 'c', 'a', 'd']);
  assert.equal(reorderDropIndex(order, 'a', 'c', 'before'), 1);
  assert.deepEqual(moveInOrder(order, 'a', 1), ['b', 'a', 'c', 'd']);
  assert.equal(reorderDropIndex(order, 'd', 'a', 'before'), 0);
  assert.equal(reorderDropIndex(order, 'd', 'a', 'after'), 1);
  // 自分の直後の行の前 / 直前の行の後 / 自分自身 → 並びが変わらない
  assert.equal(reorderDropIndex(order, 'a', 'b', 'before'), null);
  assert.equal(reorderDropIndex(order, 'b', 'a', 'after'), null);
  assert.equal(reorderDropIndex(order, 'b', 'b', 'after'), null);
  assert.equal(reorderDropIndex(order, 'zzz', 'a', 'after'), null, '無い id');
  assert.equal(reorderDropIndex(order, 'a', 'zzz', 'after'), null, '無い落とし先');
  assert.equal(reorderDropIndex(undefined, 'a', 'b', 'after'), null);
});

test('parseWorkspaceDragData: 独自形式の JSON から id を取り出す。他のドラッグや壊れたデータは null', () => {
  assert.equal(parseWorkspaceDragData((t) => (t === WORKSPACE_DRAG_TYPE ? JSON.stringify({ id: 'ws_1' }) : '')), 'ws_1');
  assert.equal(parseWorkspaceDragData(() => ''), null);
  assert.equal(parseWorkspaceDragData(() => '{broken'), null);
  assert.equal(parseWorkspaceDragData(() => JSON.stringify({ id: 42 })), null);
  assert.equal(parseWorkspaceDragData(() => { throw new Error('no'); }), null);
});

// ---- タブを別のワークスペースへ移動（issue #33） ----

test('workspaceOfTab: 休止グループのタブはそのワークスペース、そうでなければウィンドウのワークスペース', () => {
  const bindings = { 1: 'a', 2: 'b' };
  const parked = { 7: { workspaceId: 'c' } };
  assert.equal(workspaceOfTab({ windowId: 1, groupId: -1 }, bindings, parked), 'a');
  assert.equal(workspaceOfTab({ windowId: 1, groupId: 7 }, bindings, parked), 'c', '休止グループが優先');
  assert.equal(workspaceOfTab({ windowId: 1, groupId: 8 }, bindings, parked), 'a', '普通のグループはウィンドウのワークスペース');
  assert.equal(workspaceOfTab({ windowId: 3, groupId: -1 }, bindings, parked), null, '未割り当て');
  assert.equal(workspaceOfTab({ windowId: 3 }, bindings), null);
});

test('appendSavedTabs: 末尾に足し、同じ URL・保存できない URL は足さず、前面とグループは外す', () => {
  const base = [{ url: 'https://a/', title: 'A', active: true, groupKey: 'g1' }];
  const { tabs, added } = appendSavedTabs(base, [
    { url: 'https://b/', title: 'B', active: true, groupKey: 'g9', pinned: true, lastAccessed: 5 },
    { url: 'https://a/#x', title: 'dup' },
    { url: 'chrome-extension://abc/page.html', title: 'ext' },
    { url: 'https://b', title: 'dup2' },
  ]);
  assert.equal(added, 1);
  assert.deepEqual(tabs, [
    base[0],
    { url: 'https://b/', title: 'B', active: false, groupKey: null, pinned: true, lastAccessed: 5 },
  ]);
  assert.deepEqual(appendSavedTabs(undefined, undefined), { tabs: [], added: 0 });
});

test('removeSavedTabsByUrl: フラグメント・末尾スラッシュを無視して外す', () => {
  const tabs = [{ url: 'https://a/' }, { url: 'https://b/x' }, { url: 'https://c/' }];
  assert.deepEqual(removeSavedTabsByUrl(tabs, ['https://a', 'https://b/x#frag']), [{ url: 'https://c/' }]);
  assert.deepEqual(removeSavedTabsByUrl(tabs, []), tabs);
});

test('takeSavedTabs: 位置と URL が合うものだけ取り出し、合わないものは飛ばす', () => {
  const tabs = [{ url: 'https://a/' }, { url: 'https://b/' }, { url: 'https://c/' }];
  const { kept, taken } = takeSavedTabs(tabs, [{ index: 2, url: 'https://c' }, { index: 0, url: 'https://zzz/' }, { index: 9, url: 'https://a/' }]);
  assert.deepEqual(taken, [{ url: 'https://c/' }]);
  assert.deepEqual(kept, [{ url: 'https://a/' }, { url: 'https://b/' }]);
  assert.deepEqual(takeSavedTabs(tabs, undefined), { kept: tabs, taken: [] });
});

test('moveTabsMessage: 移動先の状態ごとの文言と対象外の件数', () => {
  assert.equal(moveTabsMessage({ moved: 2, mode: 'window', workspaceName: 'A' }), '2 個のタブを「A」のウィンドウへ移しました');
  assert.equal(moveTabsMessage({ moved: 1, mode: 'parked', workspaceName: 'A' }), '1 個のタブを「A」の休止グループへ移しました');
  assert.equal(moveTabsMessage({ moved: 3, skipped: 1, mode: 'saved', workspaceName: 'A' }), '3 個のタブを「A」の保存タブに加えました（1 個は対象外）');
});
