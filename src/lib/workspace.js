// ワークスペースの切替・スナップショット・復元。
// ここの関数は serialize() の中から呼ばれる前提（内部で serialize を呼ばない＝デッドロック防止）。
import {
  uid, COLORS, normalizeIcon, snapshotTabs, tabUrl, isBlankUrl, isRestorableUrl, isManagerUrl,
  matchWindowsToWorkspaces, missingTabs, planRestore, workspacesUsingSession,
} from './core.js';
import { loadState, saveState, mutate, getBindings, setBinding, clearBindings, windowForWorkspace } from './store.js';
import { enqueueDiscard, cancelDiscard } from './memory.js';
import { createFolderForWorkspace, renameManagedFolder } from './bookmarks.js';

// 自分でタブを作成・削除している最中のウィンドウ。この間のスナップショットは抑止する
const switchingWindows = new Set();

export function isSwitching(windowId) {
  return switchingWindows.has(windowId);
}

async function isNormalWindow(windowId) {
  try {
    const w = await chrome.windows.get(windowId);
    return w.type === 'normal' && !w.incognito;
  } catch {
    return false;
  }
}

async function readWindow(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  const groupsById = {};
  try {
    for (const g of await chrome.tabGroups.query({ windowId })) groupsById[g.id] = g;
  } catch { /* tabGroups 非対応環境 */ }
  return { tabs, groupsById };
}

/** ウィンドウの現在のタブを、バインドされたワークスペースに保存する */
export async function snapshotWindow(windowId) {
  if (switchingWindows.has(windowId)) return;
  const bindings = await getBindings();
  const wsId = bindings[windowId];
  if (!wsId) return;
  let data;
  try {
    data = await readWindow(windowId);
  } catch {
    return; // ウィンドウが既に閉じられている
  }
  if (!data.tabs.length) return; // 閉じる途中のウィンドウで空保存しない
  const state = await loadState();
  const ws = state.workspaces[wsId];
  if (!ws) return;
  const snap = snapshotTabs(data.tabs, data.groupsById);
  // 変化が無ければ書き込まない（storage.onChanged → UI 再描画の連鎖を防ぐ）
  if (JSON.stringify(snap.tabs) === JSON.stringify(ws.tabs) && JSON.stringify(snap.groups) === JSON.stringify(ws.groups)) return;
  ws.tabs = snap.tabs;
  ws.groups = snap.groups;
  ws.updatedAt = Date.now();
  await saveState(state);
}

/** 復元中、新しいタブが前面を奪ってもアンカーへすぐ戻す */
async function holdAnchor(windowId, anchorId) {
  if (anchorId == null) return;
  try {
    const [front] = await chrome.tabs.query({ windowId, active: true });
    if (front && front.id !== anchorId) await chrome.tabs.update(anchorId, { active: true });
  } catch { /* アンカーが既に閉じられている */ }
}

async function createInactiveTab(windowId, props, anchorId) {
  const tab = await chrome.tabs.create({ windowId, active: false, ...props });
  await holdAnchor(windowId, anchorId);
  return tab;
}

function isManagerTab(tab) {
  return isManagerUrl(tabUrl(tab));
}

/**
 * 保存されたタブをウィンドウに作る。前面になるのは planRestore が選んだ 1 件だけ。
 * anchorId を渡すと、作成中はそのタブを前面に固定する（呼び出し側が後で閉じる）。
 * 渡さなければ空白タブを一時的に前面へ置き、最後に閉じる。
 * reveal が false のときは、選んだタブを読み込むだけで前面には出さない（管理パネルを開いたまま切り替えるため）。
 */
async function restoreTabs(windowId, ws, settings, anchorId = null, { reveal = true } = {}) {
  const plan = planRestore(ws.tabs);
  let ownAnchor = null;
  if (anchorId == null) {
    const anchor = await chrome.tabs.create({ windowId, url: 'about:blank', active: true });
    ownAnchor = anchor.id;
    anchorId = anchor.id;
  }

  const groupMembers = {};
  let activeTabId = null;
  let lastId = null;
  for (let i = 0; i < plan.tabs.length; i++) {
    const t = plan.tabs[i];
    try {
      const tab = await createInactiveTab(windowId, { url: t.url, pinned: !!t.pinned }, anchorId);
      lastId = tab.id;
      if (i === plan.activeIndex) activeTabId = tab.id;
      if (t.groupKey && !t.pinned) (groupMembers[t.groupKey] ||= []).push(tab.id);
      // 前面にしないタブは URL 確定後に休止する。確定前はキューに残る
      if (settings.lazyRestore && i !== plan.activeIndex) await enqueueDiscard([tab.id]);
    } catch (e) {
      console.warn('[workspace] failed to restore tab', t.url, e);
    }
  }
  for (const [key, tabIds] of Object.entries(groupMembers)) {
    try {
      const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
      const g = ws.groups?.[key] || {};
      await chrome.tabGroups.update(groupId, {
        title: g.title || '',
        color: COLORS.includes(g.color) ? g.color : 'grey',
        collapsed: !!g.collapsed,
      });
    } catch (e) {
      console.warn('[workspace] failed to restore group', e);
    }
  }
  await holdAnchor(windowId, anchorId);

  let created = lastId != null;
  if (!lastId) {
    // 復元できるタブが無い。呼び出し側の空タブがあればそれを残し、無ければ 1 枚作る
    if (ownAnchor == null && anchorId != null) {
      activeTabId = anchorId;
      created = false;
    } else {
      const tab = await createInactiveTab(windowId, {}, anchorId);
      activeTabId = tab.id;
      created = true;
    }
  }
  activeTabId ??= lastId;
  await cancelDiscard(activeTabId);
  if (reveal) await chrome.tabs.update(activeTabId, { active: true }).catch(() => {});
  else await holdAnchor(windowId, anchorId);
  if (ownAnchor != null && ownAnchor !== activeTabId) await chrome.tabs.remove(ownAnchor).catch(() => {});
  return { activeTabId, created };
}

function rememberOpened(state, windowWsId) {
  const ws = state.workspaces[windowWsId];
  if (!ws) return;
  state.lastFocusedWorkspaceId = ws.id;
  ws.lastOpenedAt = Date.now();
}

/**
 * windowId のウィンドウを targetId のワークスペースに切り替える。
 * 現在のタブは元のワークスペースに保存して閉じ、対象ワークスペースのタブを開く。
 */
export async function switchWorkspace(windowId, targetId) {
  const state = await loadState();
  if (!state.workspaces[targetId]) throw new Error('ワークスペースが見つかりません');
  let bindings = await getBindings();
  if (bindings[windowId] === targetId) return { windowId };

  // 既に別ウィンドウで開いている場合はそのウィンドウにフォーカスする
  const otherWindow = await windowForWorkspace(targetId);
  if (otherWindow !== null) {
    try {
      await chrome.windows.update(otherWindow, { focused: true });
      return { windowId: otherWindow, focused: true };
    } catch {
      await setBinding(otherWindow, null); // 残骸のバインドを掃除
    }
  }

  // 未割り当てウィンドウに中身のあるタブがある場合は、失わないよう自動で新しいワークスペースとして保存する
  if (!bindings[windowId]) {
    const current = await chrome.tabs.query({ windowId });
    if (current.some((t) => isRestorableUrl(tabUrl(t)) && !isBlankUrl(tabUrl(t)))) {
      const d = new Date();
      const name = `未整理 ${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
      await createWorkspace({ name, sessionId: state.workspaces[targetId].sessionId, fromWindowId: windowId });
      bindings = await getBindings();
    }
  }
  await snapshotWindow(windowId);
  switchingWindows.add(windowId);
  try {
    const oldTabs = await chrome.tabs.query({ windowId });
    // 管理パネルを開いたまま切り替えるときは、パネルを前面に固定したまま新しいタブを後ろに作る
    const managerWasFront = oldTabs.some((t) => t.active && isManagerTab(t));
    const anchorId = oldTabs.find((t) => t.active)?.id ?? oldTabs[0]?.id ?? null;
    const fresh = await loadState();
    // 先に新しいタブを作り、最後に古いタブを消す（最後のタブを消すとウィンドウが閉じるため）
    const { created } = await restoreTabs(windowId, fresh.workspaces[targetId], fresh.settings, anchorId, { reveal: !managerWasFront });
    const oldIds = oldTabs.filter((t) => !isManagerTab(t)).map((t) => t.id);
    // 空のワークスペースでは、閉じる前に新しいタブを 1 枚足す
    if (!created) await chrome.tabs.create({ windowId, active: !managerWasFront });
    if (oldIds.length) await chrome.tabs.remove(oldIds).catch(() => {});
    const manager = (await chrome.tabs.query({ windowId })).find(isManagerTab);
    if (manager) {
      const rest = await chrome.tabs.query({ windowId });
      await chrome.tabs.move(manager.id, { index: rest.length - 1 }).catch(() => {});
    }
    await setBinding(windowId, targetId);
    rememberOpened(fresh, targetId);
    await saveState(fresh);
  } finally {
    switchingWindows.delete(windowId);
  }
  await snapshotWindow(windowId);
  return { windowId };
}

/** 新しいウィンドウでワークスペースを開く */
export async function openInNewWindow(targetId) {
  const existing = await windowForWorkspace(targetId);
  if (existing !== null) {
    try {
      await chrome.windows.update(existing, { focused: true });
      return { windowId: existing, focused: true };
    } catch {
      await setBinding(existing, null);
    }
  }
  const win = await chrome.windows.create({ focused: true });
  switchingWindows.add(win.id);
  try {
    let placeholder = win.tabs?.[0]?.id;
    if (placeholder == null) {
      const [front] = await chrome.tabs.query({ windowId: win.id, active: true });
      placeholder = front?.id;
    }
    const state = await loadState();
    const { activeTabId } = await restoreTabs(win.id, state.workspaces[targetId], state.settings, placeholder ?? null);
    // 初期の空タブは、復元したタブが別にできたときだけ閉じる
    if (placeholder != null && activeTabId != null && placeholder !== activeTabId) {
      await chrome.tabs.remove(placeholder).catch(() => {});
    }
    await setBinding(win.id, targetId);
    rememberOpened(state, targetId);
    await saveState(state);
  } finally {
    switchingWindows.delete(win.id);
  }
  await snapshotWindow(win.id);
  return { windowId: win.id };
}

/**
 * ワークスペースを作成。sessionId はこのワークスペースが使うセッション（省略時は先頭のセッション）。
 * fromWindowId を渡すとそのウィンドウの現在のタブをそのまま新ワークスペースにする。
 * ブックマークは createFolder（新規作成して接続）か bookmarkFolderId（既存フォルダを接続）のどちらか
 */
export async function createWorkspace({ name, sessionId, color, icon, fromWindowId, createFolder, bookmarkFolderId }) {
  const id = uid('ws_');
  const state = await loadState();
  const sid = state.sessions[sessionId] ? sessionId : state.sessionOrder[0];
  const ws = {
    id,
    name: (name || '').trim() || `ワークスペース ${Object.keys(state.workspaces).length + 1}`,
    color: COLORS.includes(color) ? color : COLORS[Object.keys(state.workspaces).length % COLORS.length],
    icon: normalizeIcon(icon),
    sessionId: sid,
    tabs: [],
    groups: {},
    bookmarkFolderId: null,
    bookmarkFolderManaged: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  if (bookmarkFolderId) {
    // 既存フォルダを接続（存在しなければ未接続のまま）
    try {
      const [node] = await chrome.bookmarks.get(String(bookmarkFolderId));
      if (node && !node.url) ws.bookmarkFolderId = node.id;
    } catch (e) {
      console.warn('[workspace] bookmark folder not found', e);
    }
  } else if (createFolder) {
    try {
      ws.bookmarkFolderId = await createFolderForWorkspace(ws.name, state.settings);
      ws.bookmarkFolderManaged = true;
    } catch (e) {
      console.warn('[workspace] failed to create bookmark folder', e);
    }
  }
  state.workspaces[id] = ws;
  state.workspaceOrder.push(id);
  await saveState(state);

  if (fromWindowId !== undefined && fromWindowId !== null) {
    const bindings = await getBindings();
    if (!bindings[fromWindowId]) {
      // 未割り当てウィンドウを、そのままこのワークスペースとして保存
      await setBinding(fromWindowId, id);
      await mutate((s) => rememberOpened(s, id));
      await snapshotWindow(fromWindowId);
    }
  }
  return { workspaceId: id };
}

export async function updateWorkspace(id, patch) {
  let renamed = null;
  await mutate((state) => {
    const ws = state.workspaces[id];
    if (!ws) return;
    if (typeof patch.name === 'string' && patch.name.trim()) {
      ws.name = patch.name.trim();
      if (ws.bookmarkFolderManaged && ws.bookmarkFolderId) renamed = { folderId: ws.bookmarkFolderId, name: ws.name };
    }
    if (patch.color && COLORS.includes(patch.color)) ws.color = patch.color;
    if ('icon' in patch) ws.icon = normalizeIcon(patch.icon);
    if ('bookmarkFolderId' in patch) {
      ws.bookmarkFolderId = patch.bookmarkFolderId || null;
      ws.bookmarkFolderManaged = !!patch.bookmarkFolderManaged;
    }
    // 使うセッションの付け替え（ワークスペースの並び順は変わらない）
    if (patch.sessionId && state.sessions[patch.sessionId]) ws.sessionId = patch.sessionId;
  });
  if (renamed) await renameManagedFolder(renamed.folderId, renamed.name);
}

/** 全体の並び順の中で位置を変える */
export async function reorderWorkspace(id, toIndex) {
  await mutate((state) => {
    if (!state.workspaces[id]) return;
    const list = state.workspaceOrder.filter((w) => w !== id);
    list.splice(Math.max(0, Math.min(toIndex, list.length)), 0, id);
    state.workspaceOrder = list;
  });
}

/** ワークスペースを削除。開いているウィンドウのタブは閉じずに「未割り当て」にする。ブックマークは消さない */
export async function deleteWorkspace(id) {
  const win = await windowForWorkspace(id);
  if (win !== null) await setBinding(win, null);
  await mutate((state) => {
    if (!state.workspaces[id]) return;
    state.workspaceOrder = state.workspaceOrder.filter((w) => w !== id);
    if (state.lastFocusedWorkspaceId === id) state.lastFocusedWorkspaceId = null;
    delete state.workspaces[id];
  });
}

/** ウィンドウのワークスペース割り当てを解除（タブはそのまま残る） */
export async function detachWindow(windowId) {
  await snapshotWindow(windowId);
  await setBinding(windowId, null);
}

// ---- セッション（ワークスペースが「どのアカウント / ログイン状態で使うか」を表すラベル。ワークスペース側が参照する） ----

export async function createSession(name) {
  const id = uid('sess_');
  await mutate((state) => {
    state.sessions[id] = {
      id,
      name: (name || '').trim() || `セッション ${state.sessionOrder.length + 1}`,
      createdAt: Date.now(),
    };
    state.sessionOrder.push(id);
  });
  return { sessionId: id };
}

export async function renameSession(id, name) {
  await mutate((state) => {
    if (state.sessions[id] && name && name.trim()) state.sessions[id].name = name.trim();
  });
}

/** セッションを削除。このセッションを使っていたワークスペースは移動先セッションを使うように付け替える（ワークスペースは消さない） */
export async function deleteSession(id, moveToId) {
  await mutate((state) => {
    if (state.sessionOrder.length <= 1 || !state.sessions[id]) return;
    const dest = state.sessions[moveToId] && moveToId !== id ? moveToId : state.sessionOrder.find((s) => s !== id);
    for (const ws of Object.values(state.workspaces)) {
      if (ws.sessionId === id) ws.sessionId = dest;
    }
    delete state.sessions[id];
    state.sessionOrder = state.sessionOrder.filter((s) => s !== id);
  });
}

/** セッションを使っている全ワークスペースをそれぞれ別ウィンドウで開く */
export async function openSessionWindows(sessionId) {
  const state = await loadState();
  if (!state.sessions[sessionId]) return;
  for (const wid of workspacesUsingSession(state, sessionId)) await openInNewWindow(wid);
}

// ---- 起動時の復元 ----

async function waitForWindows() {
  for (let i = 0; i < 10; i++) {
    const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
    const normal = wins.filter((w) => !w.incognito);
    if (normal.length) {
      // Chrome 自身のセッション復元がタブを作り終えるのを少し待つ
      await new Promise((r) => setTimeout(r, 1500));
      return (await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] })).filter((w) => !w.incognito);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return [];
}

/**
 * 起動時（および拡張の再読み込み時）に、開いているウィンドウとワークスペースを対応付け直す。
 * - Chrome が前回のタブを復元していれば URL の重なりで対応付け、不足しているタブだけ追加する
 * - タブが復元されていない（新しいタブだけ）なら、最後に使っていたワークスペースを開く
 * - ユーザーのタブは絶対に閉じない（空タブを除く）
 */
export async function reconcileWindows({ restoreLastIfBlank }) {
  const wins = await waitForWindows();
  const state = await loadState();
  const existing = await getBindings();
  const alive = new Set(wins.map((w) => w.id));
  await clearBindings();
  // 拡張の再読み込み直後など、storage.session が生きていれば既存のバインドを優先する
  const bindings = {};
  for (const [wid, wsId] of Object.entries(existing)) {
    if (alive.has(Number(wid)) && state.workspaces[wsId]) bindings[wid] = wsId;
  }
  const boundWs = new Set(Object.values(bindings));
  const unbound = wins.filter((w) => !bindings[w.id]);
  const candidates = Object.values(state.workspaces)
    .filter((ws) => !boundWs.has(ws.id))
    .map((ws) => ({ workspaceId: ws.id, urls: ws.tabs.map((t) => t.url) }));
  const matched = matchWindowsToWorkspaces(
    unbound.map((w) => ({ windowId: w.id, urls: w.tabs.map(tabUrl) })),
    candidates,
  );
  for (const [wid, m] of Object.entries(matched)) bindings[wid] = m.workspaceId;
  for (const [wid, wsId] of Object.entries(bindings)) await setBinding(Number(wid), wsId);

  // ほぼ確実に同じワークスペースと言えるウィンドウにだけ、保存済みで欠けているタブを補う
  for (const [wid, { workspaceId: wsId, score }] of Object.entries(matched)) {
    if (score < 0.8) continue;
    const windowId = Number(wid);
    const win = wins.find((w) => w.id === windowId);
    const lacking = missingTabs(state.workspaces[wsId].tabs, win.tabs.map(tabUrl));
    if (!lacking.length) continue;
    switchingWindows.add(windowId);
    try {
      const [front] = await chrome.tabs.query({ windowId, active: true });
      const anchorId = front?.id ?? null;
      const added = [];
      for (const t of lacking) {
        try {
          const tab = await createInactiveTab(windowId, { url: t.url, pinned: !!t.pinned }, anchorId);
          added.push(tab.id);
        } catch { /* 開けない URL は飛ばす */ }
      }
      // 起動時の補完は既存の前面タブを維持し、足したタブは読み込まない
      if (state.settings.lazyRestore) await enqueueDiscard(added);
      if (anchorId != null) await holdAnchor(windowId, anchorId);
    } finally {
      switchingWindows.delete(windowId);
    }
  }

  // タブが復元されなかった（空タブだけの）ウィンドウには、最後に使っていたワークスペースを開く
  if (restoreLastIfBlank && state.lastFocusedWorkspaceId && !Object.values(bindings).includes(state.lastFocusedWorkspaceId)) {
    const blankWin = wins.find((w) => !bindings[w.id] && w.tabs.every((t) => isBlankUrl(tabUrl(t))));
    if (blankWin) await switchWorkspace(blankWin.id, state.lastFocusedWorkspaceId);
  }
  for (const wid of Object.keys(bindings)) await snapshotWindow(Number(wid));
}

export async function onWindowFocused(windowId) {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const bindings = await getBindings();
  const wsId = bindings[windowId];
  if (!wsId) return;
  const state = await loadState();
  if (!state.workspaces[wsId] || state.lastFocusedWorkspaceId === wsId) return;
  rememberOpened(state, wsId);
  await saveState(state);
}

export async function onWindowRemoved(windowId) {
  // タブのスナップショットは閉じる直前までの内容が残っているのでそのまま。割り当てだけ外す
  switchingWindows.delete(windowId);
  await setBinding(windowId, null);
}

export { isNormalWindow };
