import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  snapshotTabs, urlOverlap, matchWindowsToWorkspaces, missingTabs, shouldRouteBookmark,
  neighborWorkspace, normalizeState, defaultState, matchesQuery, planRestore, isManagerUrl,
  workspacesUsingSession, normalizeIcon, ICONS, ICON_GROUPS,
} from '../src/lib/core.js';

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
