import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PARKED_PREFIX, parkedGroupProps, workspaceIdForParkedTitle, planPark, parkedTabsForSnapshot, switchModeFromKeys,
  snapshotTabs, WORKSPACE_TAB_PAGE,
  SWITCH_MODES, normalizeSwitchMode, resolveSwitchMode, switchKeyHints, DEFAULT_SETTINGS, normalizeState,
} from '../src/lib/core.js';

// ---- 休止（issue #35）: タブを閉じずに折りたたんだグループに残す ----

const WS_URL = `chrome-extension://abcdefghijklmnop/${WORKSPACE_TAB_PAGE}`;

test('parkedGroupProps: タイトルは「⏸ 絵文字 名前」、色はワークスペースの色', () => {
  assert.deepEqual(parkedGroupProps({ name: '案件A', icon: '💼', color: 'blue' }), { title: '⏸ 💼 案件A', color: 'blue' });
  assert.deepEqual(parkedGroupProps({ name: '調べもの', icon: '', color: 'nope' }), { title: '⏸ 調べもの', color: 'grey' });
  assert.equal(PARKED_PREFIX, '⏸ ');
});

test('workspaceIdForParkedTitle: 接頭辞付きのタイトルからワークスペースを引く（並び順で先、exclude は飛ばす）', () => {
  const workspaces = {
    a: { name: '案件A', icon: '💼', color: 'blue' },
    b: { name: '案件A', icon: '💼', color: 'red' }, // 同じタイトルになる
    c: { name: '個人', icon: '', color: 'green' },
  };
  const order = ['a', 'b', 'c'];
  assert.equal(workspaceIdForParkedTitle('⏸ 💼 案件A', workspaces, order), 'a');
  assert.equal(workspaceIdForParkedTitle('⏸ 💼 案件A', workspaces, order, new Set(['a'])), 'b');
  assert.equal(workspaceIdForParkedTitle('⏸ 個人', workspaces, order), 'c');
  assert.equal(workspaceIdForParkedTitle('💼 案件A', workspaces, order), null, '接頭辞が無いワークスペースタブのグループは対象外');
  assert.equal(workspaceIdForParkedTitle('⏸ 無い', workspaces, order), null);
  assert.equal(workspaceIdForParkedTitle(undefined, workspaces, order), null);
});

test('planPark: ワークスペースタブ・管理パネルを除き、固定・前面・元のグループを覚える', () => {
  const tabs = [
    { id: 1, index: 0, url: 'https://a/', pinned: true, groupId: -1 },
    { id: 2, index: 1, url: WS_URL, groupId: 9 }, // ワークスペースタブ
    { id: 3, index: 2, url: 'https://b/', groupId: 7 },
    { id: 4, index: 3, url: 'https://c/', groupId: 7, active: true },
    { id: 5, index: 4, url: 'chrome://newtab/', groupId: -1 },
    { id: 6, index: 5, url: 'chrome-extension://abc/src/ui/sidepanel.html', groupId: -1 },
  ];
  const plan = planPark(tabs, { 7: { title: '調査', color: 'blue', collapsed: false }, 9: { title: '💼 A', color: 'red' } });
  assert.deepEqual(plan.tabIds, [1, 3, 4, 5]);
  assert.deepEqual(plan.pinned, [1]);
  assert.equal(plan.activeTabId, 4);
  assert.deepEqual(plan.groups, { g7: { title: '調査', color: 'blue', collapsed: false } });
  assert.deepEqual(plan.members, { 3: 'g7', 4: 'g7' });
});

test('planPark: 中身のあるタブが無ければ null（閉じてよい）。固定タブはグループに入れていても元のグループを覚えない', () => {
  assert.equal(planPark([{ id: 1, index: 0, url: 'chrome://newtab/' }, { id: 2, index: 1, url: WS_URL }]), null);
  assert.equal(planPark([]), null);
  const plan = planPark([{ id: 1, index: 0, url: 'https://a/', pinned: true, groupId: 3 }], { 3: { title: 'x', color: 'blue' } });
  assert.deepEqual(plan.members, {});
  assert.deepEqual(plan.pinned, [1]);
  assert.equal(plan.activeTabId, null);
});

test('parkedTabsForSnapshot → snapshotTabs: 休止前の固定・前面・グループで保存される（休止グループ自体は保存しない）', () => {
  const record = {
    workspaceId: 'a', pinned: [1], activeTabId: 4,
    groups: { g7: { title: '調査', color: 'blue', collapsed: false } },
    members: { 3: 'g7', 4: 'g7' },
  };
  // 休止中: 全部が休止グループ 42 に入っていて、固定は外れ、前面でもない
  const tabs = [
    { id: 1, index: 3, url: 'https://a/', title: 'A', pinned: false, active: false, groupId: 42 },
    { id: 3, index: 4, url: 'https://b/', title: 'B', pinned: false, active: false, groupId: 42 },
    { id: 4, index: 5, url: 'https://c/', title: 'C', pinned: false, active: false, groupId: 42 },
    { id: 5, index: 6, url: 'https://d/', title: 'D', pinned: false, active: false, groupId: 42 },
  ];
  const view = parkedTabsForSnapshot(tabs, record);
  const snap = snapshotTabs(view.tabs, view.groupsById);
  assert.deepEqual(snap.tabs.map((t) => [t.url, t.pinned, t.active, t.groupKey]), [
    ['https://a/', true, false, null],
    ['https://b/', false, false, 'g-1000'],
    ['https://c/', false, true, 'g-1000'],
    ['https://d/', false, false, null],
  ]);
  assert.deepEqual(snap.groups, { 'g-1000': { title: '調査', color: 'blue', collapsed: false } });
  // 再起動後の復旧で記録が空でも落ちない（平らなグループとして保存）
  const flat = parkedTabsForSnapshot(tabs, { workspaceId: 'a', groups: {}, members: {}, pinned: [], activeTabId: null });
  assert.deepEqual(snapshotTabs(flat.tabs, flat.groupsById).groups, {});
  assert.ok(snapshotTabs(flat.tabs, flat.groupsById).tabs.every((t) => !t.pinned && !t.active && t.groupKey === null));
});

test('switchModeFromKeys: Ctrl / ⌘ = 休止して切替、Shift = 新しいウィンドウ、それ以外 = 切替', () => {
  assert.equal(switchModeFromKeys({}), 'switch');
  assert.equal(switchModeFromKeys({ shiftKey: true }), 'window');
  assert.equal(switchModeFromKeys({ ctrlKey: true }), 'park');
  assert.equal(switchModeFromKeys({ metaKey: true }), 'park');
  assert.equal(switchModeFromKeys({ ctrlKey: true, shiftKey: true }), 'park', 'Ctrl が優先');
  assert.equal(switchModeFromKeys(), 'switch');
});

// ---- 既定の切替方法（issue #37） ----

test('normalizeSwitchMode / DEFAULT_SETTINGS / normalizeState: 不正な値は switch', () => {
  assert.deepEqual(SWITCH_MODES, ['switch', 'park', 'window']);
  assert.equal(DEFAULT_SETTINGS.switchMode, 'switch');
  assert.equal(normalizeSwitchMode('park'), 'park');
  assert.equal(normalizeSwitchMode('window'), 'window');
  assert.equal(normalizeSwitchMode('nope'), 'switch');
  assert.equal(normalizeSwitchMode(undefined), 'switch');
  assert.equal(normalizeState({ settings: { switchMode: 'nope' } }).settings.switchMode, 'switch');
  assert.equal(normalizeState({ settings: { switchMode: 'park' } }).settings.switchMode, 'park');
  assert.equal(normalizeState({}).settings.switchMode, 'switch');
});

test('resolveSwitchMode: 修飾キー無しは既定、Ctrl は休止との入れ替え、Shift は新しいウィンドウとの入れ替え', () => {
  assert.equal(resolveSwitchMode({}, 'switch'), 'switch');
  assert.equal(resolveSwitchMode({ ctrlKey: true }, 'switch'), 'park');
  assert.equal(resolveSwitchMode({ shiftKey: true }, 'switch'), 'window');
  assert.equal(resolveSwitchMode({}, 'park'), 'park');
  assert.equal(resolveSwitchMode({ ctrlKey: true }, 'park'), 'switch', '既定が休止なら Ctrl で閉じる切替');
  assert.equal(resolveSwitchMode({ metaKey: true }, 'park'), 'switch');
  assert.equal(resolveSwitchMode({ shiftKey: true }, 'park'), 'window');
  assert.equal(resolveSwitchMode({}, 'window'), 'window');
  assert.equal(resolveSwitchMode({ shiftKey: true }, 'window'), 'switch', '既定が新しいウィンドウなら Shift で閉じる切替');
  assert.equal(resolveSwitchMode({ ctrlKey: true }, 'window'), 'park');
  assert.equal(resolveSwitchMode({ ctrlKey: true, shiftKey: true }, 'window'), 'park', 'Ctrl が優先');
  assert.equal(resolveSwitchMode({}, 'nope'), 'switch', '不正な既定は switch');
  assert.equal(resolveSwitchMode(undefined, undefined), 'switch');
});

test('switchKeyHints: 既定ごとの Enter / Shift / Ctrl の意味', () => {
  assert.deepEqual(switchKeyHints('switch'), { enter: 'switch', shift: 'window', ctrl: 'park' });
  assert.deepEqual(switchKeyHints('park'), { enter: 'park', shift: 'window', ctrl: 'switch' });
  assert.deepEqual(switchKeyHints('window'), { enter: 'window', shift: 'switch', ctrl: 'park' });
});
