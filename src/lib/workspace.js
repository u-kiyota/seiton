// ワークスペースの切替・スナップショット・復元。
// ここの関数は serialize() の中から呼ばれる前提（内部で serialize を呼ばない＝デッドロック防止）。
import {
  uid, COLORS, normalizeIcon, snapshotTabs, tabUrl, isBlankUrl, isRestorableUrl, isWorkspaceTabUrl,
  matchWindowsToWorkspaces, missingTabs, planRestore, workspacesUsingSession, normalizeAutoCloseOverride, moveInOrder,
  parkedTabsForSnapshot,
} from './core.js';
import { loadState, saveState, mutate, getBindings, setBinding, clearBindings, windowForWorkspace } from './store.js';
import { enqueueDiscard, cancelDiscard } from './memory.js';
import { rememberInheritedAccess, getInheritedAccess } from './access.js';
import { createFolderForWorkspace, renameManagedFolder } from './bookmarks.js';
import { ensureCookieSession, needsCookieSwap, getCookieSessionId, isolationActive, swapCookies, forgetSessionJar } from './cookies.js';
import {
  parkedGroupsInWindow, parkedLocation, parkTabs, unparkGroup, closeParkedGroup, recoverParkedGroups, pruneParked,
} from './parked.js';

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

/** 変化があればワークスペースの保存タブを置き換える。戻り値: 変えたか */
function applySnapshot(ws, snap) {
  // 変化が無ければ書き込まない（storage.onChanged → UI 再描画の連鎖を防ぐ）
  if (JSON.stringify(snap.tabs) === JSON.stringify(ws.tabs) && JSON.stringify(snap.groups) === JSON.stringify(ws.groups)) return false;
  ws.tabs = snap.tabs;
  ws.groups = snap.groups;
  ws.updatedAt = Date.now();
  return true;
}

/**
 * ウィンドウの現在のタブを、バインドされたワークスペースに保存する。
 * 休止グループ（issue #35）のタブは、バインドされたワークスペースではなく休止中のそれぞれのワークスペースに保存する
 * （固定・元のグループ・前面は休止前の状態で）。未割り当てのウィンドウでも休止グループがあればそれは保存する
 */
export async function snapshotWindow(windowId) {
  if (switchingWindows.has(windowId)) return;
  const bindings = await getBindings();
  const wsId = bindings[windowId];
  let data;
  try {
    data = await readWindow(windowId);
  } catch {
    return; // ウィンドウが既に閉じられている
  }
  if (!data.tabs.length) return; // 閉じる途中のウィンドウで空保存しない
  const parked = await parkedGroupsInWindow(windowId, data.groupsById);
  if (!wsId && !parked.length) return;
  const state = await loadState();
  const inherited = await getInheritedAccess();
  let changed = false;
  const parkedIds = new Set();
  for (const { groupId, record } of parked) {
    const tabs = data.tabs.filter((t) => t.groupId === groupId);
    for (const t of tabs) parkedIds.add(t.id);
    const target = state.workspaces[record.workspaceId];
    if (!target || !tabs.length) continue;
    const view = parkedTabsForSnapshot(tabs, record);
    const snap = snapshotTabs(view.tabs, view.groupsById, inherited);
    if (snap.tabs.length && applySnapshot(target, snap)) changed = true;
  }
  const ws = state.workspaces[wsId];
  if (ws) {
    const snap = snapshotTabs(data.tabs.filter((t) => !parkedIds.has(t.id)), data.groupsById, inherited);
    // 保存できるタブが 1 枚も無い（ワークスペースタブなど拡張ページだけが残った）ときは上書きしない。
    // ワークスペースタブがあると、タブを 1 枚ずつ閉じていってもウィンドウが閉じず isWindowClosing にならないため
    if (snap.tabs.length && applySnapshot(ws, snap)) changed = true;
  }
  if (changed) await saveState(state);
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

/**
 * 保存されたタブをウィンドウに作る。前面になるのは planRestore が選んだ 1 件だけ。
 * anchorId を渡すと、作成中はそのタブを前面に固定する（呼び出し側が後で閉じる）。
 * 渡さなければ空白タブを一時的に前面へ置き、最後に閉じる。
 */
async function restoreTabs(windowId, ws, settings, anchorId = null) {
  const plan = planRestore(ws.tabs);
  let ownAnchor = null;
  if (anchorId == null) {
    const anchor = await chrome.tabs.create({ windowId, url: 'about:blank', active: true });
    ownAnchor = anchor.id;
    anchorId = anchor.id;
  }

  const groupMembers = {};
  const toDiscard = [];
  let activeTabId = null;
  let lastId = null;
  for (let i = 0; i < plan.tabs.length; i++) {
    const t = plan.tabs[i];
    try {
      const tab = await createInactiveTab(windowId, { url: t.url, pinned: !!t.pinned }, anchorId);
      lastId = tab.id;
      if (i === plan.activeIndex) activeTabId = tab.id;
      if (t.groupKey && !t.pinned) (groupMembers[t.groupKey] ||= []).push(tab.id);
      // 前面にしないタブは、保存時の最終アクセス時刻を引き継ぐ（自動クローズの判定用）
      if (i !== plan.activeIndex) await rememberInheritedAccess(tab.id, t.lastAccessed);
      // 前面にしないタブは URL 確定後に discard する（確定前はキューに残る）。
      // discard するとタブの ID が変わるので、グループに入れ終えてからキューに積む（読み込みの速いページが先に discard されてグループ化に失敗しないように）
      if (settings.lazyRestore && i !== plan.activeIndex) toDiscard.push(tab.id);
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
  if (toDiscard.length) await enqueueDiscard(toDiscard);
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
  await chrome.tabs.update(activeTabId, { active: true }).catch(() => {});
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
 * 既定（park: false）は現在のタブを元のワークスペースに保存して閉じ、対象ワークスペースのタブを開く。
 * park: true（休止。issue #35）は現在のタブを閉じずに、折りたたんだグループ「⏸ 絵文字 名前」にまとめて同じウィンドウに残す。
 * 切替先が休止中なら（このウィンドウでも別ウィンドウでも）そのグループを解いて再開する（別ウィンドウならグループごとこのウィンドウへ移す）。
 * セッションが変わる（Cookie を入れ替える）切替では休止できず、このウィンドウの休止グループも閉じる（別セッションのページを生かしたままにできないため）
 */
export async function switchWorkspace(windowId, targetId, { park = false } = {}) {
  const state = await loadState();
  if (!state.workspaces[targetId]) throw new Error('ワークスペースが見つかりません');
  // 管理パネルのポップアップなど、通常ウィンドウ以外をワークスペースにしない
  if (!(await isNormalWindow(windowId))) throw new Error('切り替え先のウィンドウが見つかりません');
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

  const swap = await needsCookieSwap(state, state.workspaces[targetId].sessionId);
  if (park && swap) throw new Error('セッションが変わる切替では休止できません（Cookie を入れ替えるため、今のタブを残せません）');

  // 未割り当てウィンドウに中身のあるタブがある場合は、失わないよう自動で新しいワークスペースとして保存する
  if (!bindings[windowId]) {
    const current = await chrome.tabs.query({ windowId });
    if (current.some((t) => isRestorableUrl(tabUrl(t)) && !isBlankUrl(tabUrl(t)))) {
      const d = new Date();
      const name = `未整理 ${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
      // Cookie の入れ替えはこの後の切替で行う（ここで入れ替えると、閉じる直前のタブを読み込み直すことになる）
      await createWorkspace({ name, sessionId: state.workspaces[targetId].sessionId, fromWindowId: windowId, adoptCookies: false });
      bindings = await getBindings();
    }
  }
  await snapshotWindow(windowId);
  switchingWindows.add(windowId);
  let cookieSession = null;
  let parked = false;
  let resumed = false;
  try {
    const { tabs: current, groupsById } = await readWindow(windowId);
    const parkedHere = await parkedGroupsInWindow(windowId, groupsById);
    const parkedGroupIds = new Set(parkedHere.map((p) => p.groupId));
    // 今のワークスペースのタブ。ワークスペースタブは閉じずに残す（切替後にグループのタイトル / 色だけが新しいワークスペースのものになる）。
    // 休止グループ（他のワークスペースのタブ）も触らない
    const oldTabs = current.filter((t) => !isWorkspaceTabUrl(tabUrl(t)) && !parkedGroupIds.has(t.groupId));
    const oldIds = oldTabs.map((t) => t.id);
    const fresh = await loadState();
    const target = fresh.workspaces[targetId];
    const currentWs = fresh.workspaces[bindings[windowId]] || null;
    const parkedAt = await parkedLocation(targetId);

    // 切替先を開く: 休止中なら（Cookie を入れ替えない限り）グループを解いて再開、そうでなければ保存した URL から開く。
    // 戻り値: 前面にするタブができたか
    const openTarget = async (anchorId) => {
      if (parkedAt && !swap) {
        if (parkedAt.windowId !== windowId) await chrome.tabGroups.move(parkedAt.groupId, { windowId, index: -1 });
        const { activeTabId } = await unparkGroup(parkedAt.groupId, parkedAt.record);
        resumed = activeTabId != null;
        if (resumed) await chrome.tabs.update(activeTabId, { active: true }).catch(() => {});
        return resumed;
      }
      const { created } = await restoreTabs(windowId, target, fresh.settings, anchorId);
      return created;
    };

    if (swap) {
      // セッションが変わるとき（Cookie の分離が ON）: 前のセッションのページが Cookie を書き足して切替先に混ざらないよう、
      // 古いタブ（このウィンドウの休止グループも）を先に閉じてから Cookie を入れ替え、それから切替先のタブを開く。ウィンドウは空白タブで保つ。
      // 切替先が別ウィンドウで休止中でも、同じ理由でそのグループは閉じて URL から開き直す
      const blank = await chrome.tabs.create({ windowId, url: 'about:blank', active: true });
      if (oldIds.length) await chrome.tabs.remove(oldIds).catch(() => {});
      for (const p of parkedHere) await closeParkedGroup(p.groupId);
      if (parkedAt && !parkedGroupIds.has(parkedAt.groupId)) await closeParkedGroup(parkedAt.groupId);
      cookieSession = await ensureCookieSession(fresh, target.sessionId);
      const created = await openTarget(blank.id);
      if (!created) await chrome.tabs.create({ windowId, active: true });
      await chrome.tabs.remove(blank.id).catch(() => {});
    } else if (park) {
      // 休止: 前面のタブを含むグループは折りたためないので、先に空白タブを前面に置いてからグループにする
      const blank = await chrome.tabs.create({ windowId, url: 'about:blank', active: true });
      const groupId = currentWs && oldTabs.length ? await parkTabs(windowId, currentWs, oldTabs, groupsById) : null;
      parked = groupId != null;
      const created = await openTarget(blank.id);
      if (!created) await chrome.tabs.create({ windowId, active: true });
      // 休止する中身が無い（空タブだけ）・グループにできないときは従来どおり閉じる
      if (!parked && oldIds.length) await chrome.tabs.remove(oldIds).catch(() => {});
      await chrome.tabs.remove(blank.id).catch(() => {});
    } else {
      // 先に新しいタブを作り、最後に古いタブを消す（最後のタブを消すとウィンドウが閉じるため）。
      // アンカーは今前面のタブ（ワークスペースタブのページから切り替えたならそれ）。前面が無ければ普通のタブを優先する
      // （折りたたんだワークスペースタブを前面に固定するとグループが開いてしまうため）
      const anchorId = current.find((t) => t.active)?.id ?? oldTabs[0]?.id ?? current[0]?.id ?? null;
      const created = await openTarget(anchorId);
      // 空のワークスペースでは、閉じる前に新しいタブを 1 枚足す
      if (!created) await chrome.tabs.create({ windowId, active: true });
      if (oldIds.length) await chrome.tabs.remove(oldIds).catch(() => {});
    }
    await setBinding(windowId, targetId);
    rememberOpened(fresh, targetId);
    await saveState(fresh);
  } finally {
    switchingWindows.delete(windowId);
  }
  await snapshotWindow(windowId);
  return { windowId, cookieSession, parked, resumed };
}

/** 休止中のワークスペースのタブを閉じる（閉じる直前の内容を保存してから）。戻り値: 閉じた枚数 */
export async function closeParked(workspaceId) {
  const at = await parkedLocation(workspaceId);
  if (!at) return { closed: 0 };
  await snapshotWindow(at.windowId);
  switchingWindows.add(at.windowId);
  try {
    return { closed: await closeParkedGroup(at.groupId) };
  } finally {
    switchingWindows.delete(at.windowId);
  }
}

/**
 * 新しいウィンドウでワークスペースを開く。休止中（issue #35）なら、そのグループごと新しいウィンドウへ移して再開する（タブを生かしたまま）。
 * ただしセッションが変わる（Cookie を入れ替える）ときはグループを閉じて URL から開き直す
 */
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
  let cookieSession = null;
  try {
    let placeholder = win.tabs?.[0]?.id;
    if (placeholder == null) {
      const [front] = await chrome.tabs.query({ windowId: win.id, active: true });
      placeholder = front?.id;
    }
    const state = await loadState();
    const target = state.workspaces[targetId];
    const parkedAt = await parkedLocation(targetId);
    const swap = await needsCookieSwap(state, target.sessionId);
    // 別セッションのページを生かしたままにできないので、Cookie を入れ替える前に閉じる（保存は休止中も更新されている）
    if (parkedAt && swap) await closeParkedGroup(parkedAt.groupId);
    // 切替先のセッションの Cookie に入れ替えてからタブを開く（新しいウィンドウには前のセッションのページが無い）
    cookieSession = await ensureCookieSession(state, target.sessionId);
    let activeTabId = null;
    if (parkedAt && !swap) {
      await chrome.tabGroups.move(parkedAt.groupId, { windowId: win.id, index: -1 });
      ({ activeTabId } = await unparkGroup(parkedAt.groupId, parkedAt.record));
      if (activeTabId != null) await chrome.tabs.update(activeTabId, { active: true }).catch(() => {});
    } else {
      ({ activeTabId } = await restoreTabs(win.id, target, state.settings, placeholder ?? null));
    }
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
  return { windowId: win.id, cookieSession };
}

/**
 * 開いているウィンドウのワークスペースが使うセッションを変えたとき（✎ での変更・今のタブからの作成）に、
 * 今の Cookie をそのセッションのものに入れ替え、開いているページを読み込み直す（新しいログイン状態を反映する）。
 * 分離が OFF、または既にそのセッションの Cookie なら何もしない
 */
async function adoptSessionInWindow(windowId, state, sessionId) {
  const res = await ensureCookieSession(state, sessionId);
  if (!res) return null;
  try {
    for (const t of await chrome.tabs.query({ windowId })) {
      // 休止中のタブは次に開いたときに読み込まれる。拡張のページ（ワークスペースタブ等）は Cookie を使わない
      if (t.discarded || isWorkspaceTabUrl(tabUrl(t)) || !isRestorableUrl(tabUrl(t))) continue;
      await chrome.tabs.reload(t.id).catch(() => {});
    }
  } catch { /* ウィンドウが閉じられた */ }
  return res;
}

/**
 * ワークスペースを作成。sessionId はこのワークスペースが使うセッション（省略時は先頭のセッション）。
 * fromWindowId を渡すとそのウィンドウの現在のタブをそのまま新ワークスペースにする（adoptCookies: false で Cookie の入れ替えを省く）。
 * ブックマークは createFolder（新規作成して接続）か bookmarkFolderId（既存フォルダを接続）のどちらか
 */
export async function createWorkspace({ name, sessionId, color, icon, fromWindowId, createFolder, bookmarkFolderId, adoptCookies = true }) {
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
  state.orderAt = Date.now();
  await saveState(state);

  let cookieSession = null;
  if (fromWindowId !== undefined && fromWindowId !== null) {
    const bindings = await getBindings();
    if (!bindings[fromWindowId]) {
      // 未割り当てウィンドウを、そのままこのワークスペースとして保存
      await setBinding(fromWindowId, id);
      await mutate((s) => rememberOpened(s, id));
      await snapshotWindow(fromWindowId);
      // 「今開いているタブをこのワークスペースにする」で別のセッションを選んだときは、Cookie もそのセッションのものにして読み込み直す
      if (adoptCookies) cookieSession = await adoptSessionInWindow(fromWindowId, state, sid);
    }
  }
  return { workspaceId: id, cookieSession };
}

export async function updateWorkspace(id, patch) {
  let renamed = null;
  let sessionChanged = null;
  const state = await mutate((state) => {
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
      delete ws.bookmarkFolderPath; // 同期で受け取った未解決のパスより、ここで選んだフォルダを優先する
    }
    // 使うセッションの付け替え（ワークスペースの並び順は変わらない）
    if (patch.sessionId && state.sessions[patch.sessionId] && ws.sessionId !== patch.sessionId) {
      ws.sessionId = patch.sessionId;
      sessionChanged = patch.sessionId;
    }
    // タブの自動クローズの上書き（null = グローバル設定に従う）。日数が不正なら今の値を保つ
    if ('autoClose' in patch) {
      ws.autoClose = normalizeAutoCloseOverride(patch.autoClose, ws.autoClose || state.settings.autoClose);
    }
    ws.updatedAt = Date.now(); // 同期の衝突（両方の端末で変えた）で新しい方を採るため
    return state;
  });
  if (renamed) await renameManagedFolder(renamed.folderId, renamed.name);
  // 開いているワークスペースのセッションを変えたら、今の Cookie もそのセッションのものに入れ替える（分離が ON のとき）
  let cookieSession = null;
  if (sessionChanged) {
    const win = await windowForWorkspace(id);
    if (win !== null) cookieSession = await adoptSessionInWindow(win, state, sessionChanged);
  }
  return { cookieSession };
}

/** 全体の並び順の中で位置を変える（toIndex は id を除いた並びでの位置） */
export async function reorderWorkspace(id, toIndex) {
  await mutate((state) => {
    if (!state.workspaces[id]) return;
    state.workspaceOrder = moveInOrder(state.workspaceOrder, id, toIndex);
    state.orderAt = Date.now();
  });
}

/**
 * 複数のワークスペースに同じ変更をまとめて適用する（管理ダイアログの一括変更。issue #25）。
 * 1 件ずつ updateWorkspace を通すので、名前変更によるフォルダ名の追従やセッション変更時の Cookie 入れ替えも同じように働く。
 * 戻り値: 適用した件数と、Cookie を入れ替えた場合はその最後の結果
 */
export async function updateWorkspaces(ids, patch) {
  let count = 0;
  let cookieSession = null;
  for (const id of [...new Set(ids || [])]) {
    const state = await loadState();
    if (!state.workspaces[id]) continue;
    const res = await updateWorkspace(id, patch);
    count++;
    if (res?.cookieSession) cookieSession = res.cookieSession;
  }
  return { count, cookieSession };
}

/** 複数のワークスペースをまとめて削除する（管理ダイアログ。issue #25）。戻り値: 削除した件数 */
export async function deleteWorkspaces(ids) {
  let count = 0;
  for (const id of [...new Set(ids || [])]) {
    const state = await loadState();
    if (!state.workspaces[id]) continue;
    await deleteWorkspace(id);
    count++;
  }
  return { count };
}

/** ワークスペースを削除。開いているウィンドウのタブは閉じずに「未割り当て」にする。ブックマークは消さない */
export async function deleteWorkspace(id) {
  const win = await windowForWorkspace(id);
  if (win !== null) await setBinding(win, null);
  await mutate((state) => {
    if (!state.workspaces[id]) return;
    state.workspaceOrder = state.workspaceOrder.filter((w) => w !== id);
    state.orderAt = Date.now();
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
      updatedAt: Date.now(),
    };
    state.sessionOrder.push(id);
    state.orderAt = Date.now();
  });
  return { sessionId: id };
}

export async function renameSession(id, name) {
  await mutate((state) => {
    if (state.sessions[id] && name && name.trim()) {
      state.sessions[id].name = name.trim();
      state.sessions[id].updatedAt = Date.now();
    }
  });
}

/** セッションを削除。このセッションを使っていたワークスペースは移動先セッションを使うように付け替える（ワークスペースは消さない） */
export async function deleteSession(id, moveToId) {
  const before = await loadState();
  if (before.sessionOrder.length <= 1 || !before.sessions[id]) return { cookieSession: null };
  const dest = before.sessions[moveToId] && moveToId !== id ? moveToId : before.sessionOrder.find((s) => s !== id);
  // 今の Cookie が消すセッションのものなら、移動先セッションの Cookie に入れ替えてから消す（消したセッションの Cookie は捨てる）
  let cookieSession = null;
  if (await isolationActive() && await getCookieSessionId() === id) {
    const res = await swapCookies(id, dest);
    cookieSession = { ...res, fromName: before.sessions[id].name, toName: before.sessions[dest].name };
  }
  await mutate((state) => {
    if (!state.sessions[id] || !state.sessions[dest]) return;
    for (const ws of Object.values(state.workspaces)) {
      if (ws.sessionId === id) {
        ws.sessionId = dest;
        ws.updatedAt = Date.now();
      }
    }
    delete state.sessions[id];
    state.sessionOrder = state.sessionOrder.filter((s) => s !== id);
    state.orderAt = Date.now();
  });
  await forgetSessionJar(id);
  return { cookieSession };
}

/** セッションを使っている全ワークスペースをそれぞれ別ウィンドウで開く */
export async function openSessionWindows(sessionId) {
  const state = await loadState();
  if (!state.sessions[sessionId]) return { cookieSession: null };
  // 先に Cookie をこのセッションのものにしてから開く（各ウィンドウでは入れ替え不要になる）
  const cookieSession = await ensureCookieSession(state, sessionId);
  for (const wid of workspacesUsingSession(state, sessionId)) await openInNewWindow(wid);
  return { cookieSession };
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
  // 休止グループ（issue #35）: 記録が残っていればそれを、無ければ復元された「⏸ …」のタイトルから対応付け直し、照合と候補から外す
  const parked = await recoverParkedGroups(wins, state, boundWs);
  const unbound = wins.filter((w) => !bindings[w.id]);
  const candidates = Object.values(state.workspaces)
    .filter((ws) => !boundWs.has(ws.id) && !parked.workspaceIds.has(ws.id))
    .map((ws) => ({ workspaceId: ws.id, urls: ws.tabs.map((t) => t.url) }));
  // Chrome が復元したワークスペースタブは保存 URL に含まれないので、照合から外す（重なり率が不当に下がらないように）。休止グループのタブも外す
  const urlsOf = (w) => w.tabs.filter((t) => !parked.tabIdsByWindow[w.id]?.has(t.id)).map(tabUrl).filter((u) => !isWorkspaceTabUrl(u));
  const matched = matchWindowsToWorkspaces(
    unbound.map((w) => ({ windowId: w.id, urls: urlsOf(w) })),
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
          await rememberInheritedAccess(tab.id, t.lastAccessed);
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
  if (restoreLastIfBlank && state.lastFocusedWorkspaceId && !Object.values(bindings).includes(state.lastFocusedWorkspaceId)
    && !parked.workspaceIds.has(state.lastFocusedWorkspaceId)) {
    const blankWin = wins.find((w) => !bindings[w.id] && urlsOf(w).every(isBlankUrl));
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
  await pruneParked(); // そのウィンドウにあった休止グループの記録を捨てる
}

export { isNormalWindow };
