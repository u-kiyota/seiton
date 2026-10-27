// 休止（issue #35）: ワークスペースを切り替えるときに、今のタブを閉じずに折りたたんだタブグループ（「⏸ 絵文字 名前」）として
// 同じウィンドウに残す。フォームの入力途中など、URL では戻せないページ内の状態を失わないための逃げ道。
//
// - 休止中のワークスペースは「どのグループに入っているか」を storage.session の parked に持つ（グループ ID → 記録）。
//   ウィンドウは tabGroups.get で引く（ユーザーがグループを別ウィンドウへ動かしても追える）。
// - 記録には再開時に元へ戻すための情報（固定だったタブ・元のグループ・前面だったタブ）も入れる。
// - ブラウザ再起動では storage.session もグループ ID も消えるので、復元されたグループのタイトル「⏸ …」から対応付け直す
//   （元のグループ・固定の情報は失われ、平らなグループとして再開する）。
// - ここの関数は serialize() の中から呼ばれる前提（内部で serialize を呼ばない）。
import { planPark, parkedGroupProps, workspaceIdForParkedTitle, COLORS } from './core.js';
import { cancelDiscard } from './memory.js';

const PARKED_KEY = 'parked'; // storage.session: { [groupId]: { workspaceId, groups, members, pinned, activeTabId, parkedAt } }

export async function getParked() {
  const { [PARKED_KEY]: p } = await chrome.storage.session.get(PARKED_KEY);
  return p && typeof p === 'object' ? p : {};
}

async function setParked(map) {
  await chrome.storage.session.set({ [PARKED_KEY]: map });
}

export async function forgetParkedGroup(groupId) {
  const map = await getParked();
  if (!(groupId in map)) return;
  delete map[groupId];
  await setParked(map);
}

async function getGroup(groupId) {
  try {
    return await chrome.tabGroups.get(Number(groupId));
  } catch {
    return null;
  }
}

/**
 * タブが置き換えられた（discard で ID が変わった）とき、休止グループの記録の ID を追従させる。
 * 休止中のタブは遅延読み込みや Chrome のメモリセーバーで休止されることがあり、そのとき ID が変わる
 */
export async function replaceParkedTabId(removedId, addedId) {
  const map = await getParked();
  let changed = false;
  for (const record of Object.values(map)) {
    if (record.members && removedId in record.members) {
      record.members[addedId] = record.members[removedId];
      delete record.members[removedId];
      changed = true;
    }
    const i = (record.pinned || []).indexOf(removedId);
    if (i >= 0) {
      record.pinned[i] = addedId;
      changed = true;
    }
    if (record.activeTabId === removedId) {
      record.activeTabId = addedId;
      changed = true;
    }
  }
  if (changed) await setParked(map);
}

/** 既に無いグループの記録を捨てる */
export async function pruneParked() {
  const map = await getParked();
  let changed = false;
  for (const gid of Object.keys(map)) {
    if (!(await getGroup(gid))) {
      delete map[gid];
      changed = true;
    }
  }
  if (changed) await setParked(map);
  return map;
}

/**
 * ウィンドウにある休止グループ。groupsById（readWindow の結果）を渡せばそれで判定し、無ければ tabGroups.query する。
 * 戻り値: [{ groupId, record }]
 */
export async function parkedGroupsInWindow(windowId, groupsById = null) {
  const map = await getParked();
  let ids;
  if (groupsById) ids = Object.keys(groupsById).map(Number);
  else {
    try {
      ids = (await chrome.tabGroups.query({ windowId })).map((g) => g.id);
    } catch {
      return [];
    }
  }
  return ids.filter((gid) => map[gid]).map((gid) => ({ groupId: gid, record: map[gid] }));
}

/** ワークスペースが休止中なら { windowId, groupId, record }、そうでなければ null */
export async function parkedLocation(workspaceId) {
  const map = await getParked();
  for (const [gid, record] of Object.entries(map)) {
    if (record.workspaceId !== workspaceId) continue;
    const group = await getGroup(gid);
    if (group) return { windowId: group.windowId, groupId: Number(gid), record };
    await forgetParkedGroup(gid);
  }
  return null;
}

/** UI 用: { [workspaceId]: { windowId, groupId } } */
export async function parkedByWorkspace() {
  const map = await getParked();
  const out = {};
  for (const [gid, record] of Object.entries(map)) {
    const group = await getGroup(gid);
    if (group) out[record.workspaceId] = { windowId: group.windowId, groupId: Number(gid) };
  }
  return out;
}

/**
 * ウィンドウのタブ（tabs）を ws の休止グループにまとめる。前面のタブは呼び出し側がグループ外（空白タブなど）にしておくこと
 * （前面のタブを含むグループは折りたためない）。
 * 戻り値: グループ ID。休止する中身が無い・グループにできないときは null（呼び出し側は閉じる方式にする）
 */
export async function parkTabs(windowId, ws, tabs, groupsById) {
  const plan = planPark(tabs, groupsById);
  if (!plan) return null;
  // 固定タブはグループに入れられないので固定を外す（再開時に戻す）
  for (const id of plan.pinned) await chrome.tabs.update(id, { pinned: false }).catch(() => {});
  let groupId;
  try {
    groupId = await chrome.tabs.group({ tabIds: plan.tabIds, createProperties: { windowId } });
  } catch (e) {
    console.warn('[parked] グループにできません', e);
    for (const id of plan.pinned) await chrome.tabs.update(id, { pinned: true }).catch(() => {});
    return null;
  }
  const props = parkedGroupProps(ws);
  try {
    await chrome.tabGroups.update(groupId, { title: props.title, color: props.color, collapsed: true });
  } catch (e) {
    console.warn('[parked] グループを折りたためません', e);
    await chrome.tabGroups.update(groupId, { title: props.title, color: props.color }).catch(() => {});
  }
  const map = await getParked();
  map[groupId] = {
    workspaceId: ws.id, groups: plan.groups, members: plan.members, pinned: plan.pinned,
    activeTabId: plan.activeTabId, parkedAt: Date.now(),
  };
  await setParked(map);
  return groupId;
}

/** 置き換えられたタブの ID（removed → added）。discard は記録の更新（replaceParkedTabId）が直列キューで遅れるので、メモリでも即時に持つ */
const replacedIds = new Map();

/** tabs.onReplaced で即時に呼ぶ（記録の更新は replaceParkedTabId で直列に行う） */
export function noteReplacedTab(removedId, addedId) {
  replacedIds.set(removedId, addedId);
  if (replacedIds.size > 500) replacedIds.delete(replacedIds.keys().next().value);
}

/** 記録に残っている ID を、置き換え後の今生きている ID にたどる（無ければ null） */
function resolveTabId(id, alive) {
  let cur = id;
  for (let i = 0; i < 8 && cur != null && !alive.has(cur); i++) cur = replacedIds.get(cur);
  return cur != null && alive.has(cur) ? cur : null;
}

/**
 * 休止グループを解いて元の構成（固定・グループ）に戻す。グループは最後のタブが抜けた時点で Chrome が消す。
 * 戻り値: { tabIds, activeTabId }（前面にすべきタブ。休止時に前面だったタブが残っていればそれ、無ければ先頭）
 */
export async function unparkGroup(groupId, record) {
  const tabs = (await chrome.tabs.query({ groupId: Number(groupId) })).sort((a, b) => a.index - b.index);
  await forgetParkedGroup(groupId);
  if (!tabs.length) return { tabIds: [], activeTabId: null };
  const ids = tabs.map((t) => t.id);
  // 遅延読み込みの discard 待ちがあると、この途中でタブが置き換わって ID が変わる（グループに戻せない）ので止める
  for (const id of ids) await cancelDiscard(id);
  const windowId = tabs[0].windowId;
  const liveIds = async () => new Set((await chrome.tabs.query({ windowId })).map((t) => t.id));
  let alive = await liveIds();
  await chrome.tabs.ungroup(ids).catch((e) => console.warn('[parked] ungroup failed', e));
  const pinned = new Set();
  for (const id of record?.pinned || []) {
    const cur = resolveTabId(id, alive);
    if (cur == null) continue;
    pinned.add(cur);
    await chrome.tabs.update(cur, { pinned: true }).catch(() => {});
  }
  const activeTabId = resolveTabId(record?.activeTabId, alive) ?? resolveTabId(ids[0], alive) ?? ids[0];
  // 元のグループに戻す（残っているタブがあるものだけ）。前面にするタブを含むグループは折りたたまない。
  // 途中で discard によりタブが置き換わって失敗したら、生きている ID で一度だけやり直す
  const membersOf = (key) => Object.entries(record?.members || {})
    .filter(([, k]) => k === key)
    .map(([tid]) => resolveTabId(Number(tid), alive))
    .filter((id) => id != null && !pinned.has(id));
  for (const key of [...new Set(Object.values(record?.members || {}))]) {
    const g = record?.groups?.[key] || {};
    const regroup = async (tabIds) => {
      const gid = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
      await chrome.tabGroups.update(gid, {
        title: g.title || '',
        color: COLORS.includes(g.color) ? g.color : 'grey',
        collapsed: !!g.collapsed && !tabIds.includes(activeTabId),
      });
    };
    let tabIds = membersOf(key);
    if (!tabIds.length) continue;
    try {
      await regroup(tabIds);
    } catch (e) {
      alive = await liveIds();
      tabIds = membersOf(key);
      if (!tabIds.length) continue;
      try {
        await regroup(tabIds);
      } catch (e2) {
        console.warn('[parked] failed to restore group', e2);
      }
    }
  }
  return { tabIds: ids, activeTabId };
}

/** 休止グループのタブをすべて閉じる（記録も消す）。閉じた枚数を返す */
export async function closeParkedGroup(groupId) {
  const tabs = await chrome.tabs.query({ groupId: Number(groupId) });
  await forgetParkedGroup(groupId);
  if (tabs.length) await chrome.tabs.remove(tabs.map((t) => t.id)).catch(() => {});
  return tabs.length;
}

/** 名前・アイコン・色が変わったとき、休止グループのタイトル・色を追従させる。ワークスペースが消えていれば接頭辞を外して普通のグループにする */
export async function refreshParkedGroups(state) {
  const map = await getParked();
  for (const [gid, record] of Object.entries(map)) {
    const group = await getGroup(gid);
    if (!group) {
      await forgetParkedGroup(gid);
      continue;
    }
    const ws = state.workspaces[record.workspaceId];
    if (!ws) {
      await forgetParkedGroup(gid);
      await chrome.tabGroups.update(group.id, { title: (group.title || '').replace(/^⏸ /, '') }).catch(() => {});
      continue;
    }
    const props = parkedGroupProps(ws);
    const patch = {};
    if ((group.title || '') !== props.title) patch.title = props.title;
    if (group.color !== props.color) patch.color = props.color;
    if (Object.keys(patch).length) await chrome.tabGroups.update(group.id, patch).catch(() => {});
  }
}

/**
 * 起動時・拡張の再読み込み時: Chrome が復元した「⏸ …」のグループを休止中のワークスペースとして登録し直す。
 * 既に記録があるグループはそのまま。taken（他のウィンドウに割り当て済みのワークスペース）は対象外。
 * 戻り値: { workspaceIds: Set, tabIdsByWindow: { [windowId]: Set<tabId> } }
 */
export async function recoverParkedGroups(windows, state, taken = new Set()) {
  const map = await pruneParked();
  const used = new Set([...taken, ...Object.values(map).map((r) => r.workspaceId)]);
  const workspaceIds = new Set(Object.values(map).map((r) => r.workspaceId));
  const tabIdsByWindow = {};
  for (const w of windows) {
    let groups = [];
    try {
      groups = await chrome.tabGroups.query({ windowId: w.id });
    } catch {
      continue;
    }
    for (const g of groups) {
      let wsId = map[g.id]?.workspaceId;
      if (!wsId) {
        wsId = workspaceIdForParkedTitle(g.title, state.workspaces, state.workspaceOrder, used);
        if (!wsId) continue;
        map[g.id] = { workspaceId: wsId, groups: {}, members: {}, pinned: [], activeTabId: null, parkedAt: Date.now() };
        used.add(wsId);
      }
      workspaceIds.add(wsId);
      const set = (tabIdsByWindow[w.id] ||= new Set());
      for (const t of w.tabs || []) if (t.groupId === g.id) set.add(t.id);
    }
  }
  await setParked(map);
  return { workspaceIds, tabIdsByWindow };
}
