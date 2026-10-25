import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS, normalizeState, snapshotTabs, isWorkspaceTabUrl, isManagerUrl, WORKSPACE_TAB_PAGE,
  workspaceTabGroupProps, workspaceTabIndex, pickWorkspaceTab, isOwnWorkspaceGroup, workspaceGroupPatch,
  workspaceTabEnabled, COLORS,
} from '../src/lib/core.js';

const WS_URL = `chrome-extension://abcdefghijklmnop/${WORKSPACE_TAB_PAGE}`;

test('isWorkspaceTabUrl: 拡張のワークスペースタブのページだけ', () => {
  assert.equal(isWorkspaceTabUrl(WS_URL), true);
  assert.equal(isWorkspaceTabUrl(`${WS_URL}?x=1`), true);
  assert.equal(isWorkspaceTabUrl(`${WS_URL}#top`), true);
  assert.equal(isWorkspaceTabUrl('chrome-extension://abc/src/ui/sidepanel.html'), false);
  assert.equal(isWorkspaceTabUrl('chrome-extension://abc/src/ui/wstab.html.bak'), false);
  assert.equal(isWorkspaceTabUrl('https://example.com/src/ui/wstab.html'), false);
  assert.equal(isWorkspaceTabUrl(''), false);
  assert.equal(isWorkspaceTabUrl(undefined), false);
  assert.equal(isManagerUrl(WS_URL), false, '管理パネルとは区別する');
});

test('workspaceTabGroupProps: タイトルは「絵文字 名前」、絵文字が無ければ名前のみ。色は tabGroups の色名', () => {
  assert.deepEqual(workspaceTabGroupProps({ name: '案件A', icon: '💼', color: 'blue' }), { title: '💼 案件A', color: 'blue' });
  assert.deepEqual(workspaceTabGroupProps({ name: ' 調べもの ', icon: '', color: 'green' }), { title: '調べもの', color: 'green' });
  assert.deepEqual(workspaceTabGroupProps({ name: 'x', icon: 'a b', color: 'nope' }), { title: 'x', color: 'grey' }, '不正なアイコン・色');
  assert.deepEqual(workspaceTabGroupProps({ name: '', icon: '🚀' }), { title: '🚀', color: 'grey' });
  for (const c of COLORS) assert.equal(workspaceTabGroupProps({ name: 'a', color: c }).color, c);
});

test('workspaceTabIndex: 固定タブの数（固定タブの直後に置く）', () => {
  assert.equal(workspaceTabIndex([]), 0);
  assert.equal(workspaceTabIndex([{ pinned: false }, { pinned: false }]), 0);
  assert.equal(workspaceTabIndex([{ pinned: true }, { pinned: true }, { pinned: false }]), 2);
  assert.equal(workspaceTabIndex(undefined), 0);
});

test('pickWorkspaceTab: グループに入っているもの → index の小さいもの を残し、残りは閉じる', () => {
  assert.deepEqual(pickWorkspaceTab([{ id: 1, index: 0, url: 'https://a/' }]), { keep: null, close: [] });
  const tabs = [
    { id: 1, index: 0, url: 'https://a/' },
    { id: 2, index: 1, url: WS_URL, groupId: -1 },
    { id: 3, index: 4, url: WS_URL, groupId: 9 },
    { id: 4, index: 3, pendingUrl: WS_URL },
  ];
  const r = pickWorkspaceTab(tabs);
  assert.equal(r.keep.id, 3, 'グループに入っているものを優先');
  assert.deepEqual(r.close.map((t) => t.id), [2, 4]);
  const r2 = pickWorkspaceTab([{ id: 5, index: 2, url: WS_URL, groupId: -1 }, { id: 6, index: 1, pendingUrl: WS_URL }]);
  assert.equal(r2.keep.id, 6, 'どれもグループ外なら index が小さいもの（作成直後の pendingUrl も対象）');
  assert.deepEqual(r2.close.map((t) => t.id), [5]);
});

test('isOwnWorkspaceGroup: ワークスペースタブだけ・前回のグループ・期待タイトルなら自分のもの', () => {
  const group = { id: 9, title: '💼 案件A' };
  const ws = { id: 1 };
  const user = { id: 2 };
  assert.equal(isOwnWorkspaceGroup({ group, members: [ws], wsTabId: 1 }), true);
  assert.equal(isOwnWorkspaceGroup({ group: { id: 9, title: '調査' }, members: [ws, user], wsTabId: 1, expectedTitle: '💼 案件A' }), false,
    'ユーザーのグループに入れられた');
  assert.equal(isOwnWorkspaceGroup({ group: { id: 9, title: '調査' }, members: [ws, user], wsTabId: 1, knownGroupId: 9 }), true);
  assert.equal(isOwnWorkspaceGroup({ group, members: [ws, user], wsTabId: 1, expectedTitle: '💼 案件A' }), true, '他のタブが紛れ込んだだけ');
  assert.equal(isOwnWorkspaceGroup({ group: null, members: [ws], wsTabId: 1 }), false);
});

test('workspaceGroupPatch: 違うプロパティだけ。同じなら null（自分の更新イベントでループしない）', () => {
  const props = { title: '💼 案件A', color: 'blue' };
  assert.equal(workspaceGroupPatch({ title: '💼 案件A', color: 'blue', collapsed: false }, props), null);
  assert.equal(workspaceGroupPatch({ title: '💼 案件A', color: 'blue', collapsed: true }, props, { collapse: true }), null);
  assert.deepEqual(workspaceGroupPatch({ title: '💼 案件A', color: 'blue', collapsed: false }, props, { collapse: true }), { collapsed: true });
  assert.deepEqual(workspaceGroupPatch({ title: '旧', color: 'red', collapsed: true }, props), { title: '💼 案件A', color: 'blue' });
  assert.deepEqual(workspaceGroupPatch(null, props, { collapse: true }), { title: '💼 案件A', color: 'blue', collapsed: true });
});

test('DEFAULT_SETTINGS.workspaceTab は true。normalizeState は既存データに補い、OFF は保つ', () => {
  assert.equal(DEFAULT_SETTINGS.workspaceTab, true);
  assert.equal(normalizeState({ settings: { lazyRestore: false } }).settings.workspaceTab, true, '既存データに無ければ既定値');
  assert.equal(normalizeState({ settings: { workspaceTab: false } }).settings.workspaceTab, false);
  assert.equal(normalizeState(null).settings.workspaceTab, true);
});

test('workspaceTabEnabled: storage の生データから設定値（未設定なら既定）', () => {
  assert.equal(workspaceTabEnabled(undefined), true);
  assert.equal(workspaceTabEnabled({ settings: {} }), true);
  assert.equal(workspaceTabEnabled({ settings: { workspaceTab: false } }), false);
});

test('snapshotTabs: ワークスペースタブとそのグループは保存しない（含めたタブのグループだけを記録）', () => {
  const tabs = [
    { index: 0, url: WS_URL, title: '💼 案件A', groupId: 9 },
    { index: 1, url: 'https://a.example/', title: 'A', groupId: 7, active: true },
    { index: 2, url: 'https://b.example/', title: 'B', groupId: -1 },
  ];
  const groups = { 9: { title: '💼 案件A', color: 'blue', collapsed: true }, 7: { title: '調査', color: 'red', collapsed: false } };
  const snap = snapshotTabs(tabs, groups);
  assert.deepEqual(snap.tabs.map((t) => t.url), ['https://a.example/', 'https://b.example/']);
  assert.deepEqual(Object.keys(snap.groups), ['g7']);
  assert.equal(snap.groups.g9, undefined);
  assert.deepEqual(snapshotTabs([tabs[0]], groups), { tabs: [], groups: {} }, 'ワークスペースタブだけなら空（呼び出し側は上書きしない）');
});
