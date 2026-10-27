// サービスワーカー: Chrome のイベントを受けて状態を更新する唯一の書き手。
// UI（管理パネル / ポップアップ / オプション）は runtime.sendMessage 経由でここに依頼する。
import {
  shouldRouteBookmark, neighborWorkspace, tabUrl, normalizeState, isManagerUrl, normalizeAutoClose, normalizeSwitchMode,
  isWorkspaceTabUrl, workspaceTabEnabled, normalizeExcludePattern, normalizeExcludePatterns,
} from './lib/core.js';
import { openManager, toggleManager } from './lib/manager.js';
import { serialize, loadState, saveState, mutate, getBindings } from './lib/store.js';
import {
  snapshotWindow, switchWorkspace, openInNewWindow, createWorkspace, updateWorkspace, reorderWorkspace,
  deleteWorkspace, updateWorkspaces, deleteWorkspaces, detachWindow, createSession, renameSession, deleteSession,
  openSessionWindows, reconcileWindows, onWindowFocused, onWindowRemoved, isSwitching, isNormalWindow, closeParked,
  moveTabsToWorkspace, moveSavedTabs,
} from './lib/workspace.js';
import { forgetParkedGroup, parkedByWorkspace, refreshParkedGroups, replaceParkedTabId, noteReplacedTab } from './lib/parked.js';
import {
  ownCreatedIds, setImporting, isImporting, createFolderForWorkspace, listAllFolders,
  listFolderBookmarks, saveToFolder, collectIds,
} from './lib/bookmarks.js';
import {
  AUTO_DISCARD_ALARM, configureAutoDiscard, runAutoDiscard, discardInactiveInWindow,
  onTabMaybeDiscardable, flushDiscardQueue, forgetDiscard,
} from './lib/memory.js';
import { AUTO_CLOSE_ALARM, configureAutoClose, runAutoClose } from './lib/autoclose.js';
import { forgetInheritedAccess } from './lib/access.js';
import { listClosedTabs, removeClosedTab, clearClosedTabs } from './lib/history.js';
import { cookieStatus, clearCookieJars, hasCookiePermission, adoptCookieSession } from './lib/cookies.js';
import { isBookmarkableUrl, findBookmarkByUrl, changedBindingWindows, indicatorSignature } from './lib/core.js';
import {
  refreshWindowIndicator, refreshAllIndicators, refreshTabIndicator, scheduleTabIndicator,
} from './lib/indicator.js';
import {
  ensureAllWorkspaceTabs, scheduleWorkspaceTab, scheduleAllWorkspaceTabs, forgetWorkspaceTabWindow,
} from './lib/wstab.js';
import {
  configureSync, scheduleSync, runSync, getSyncStatus, setSyncEnabled, clearSyncData, SYNC_PULL_DELAY_MS,
} from './lib/sync.js';

// ---- タブ変更 → 所属ワークスペースへのスナップショット（デバウンス） ----

const snapshotTimers = new Map();

function scheduleSnapshot(windowId) {
  if (windowId === undefined || windowId === chrome.windows.WINDOW_ID_NONE) return;
  if (isSwitching(windowId)) return;
  clearTimeout(snapshotTimers.get(windowId));
  snapshotTimers.set(windowId, setTimeout(() => {
    snapshotTimers.delete(windowId);
    serialize(() => snapshotWindow(windowId));
  }, 400));
}

/**
 * タブの変化でワークスペースタブを点検する（閉じられた・グループから外された・動かされた・別ウィンドウへ移された など）。
 * onRemoved には URL が無いので、どのタブかは問わず点検する（冪等で、正しければ何もしない）。
 * 切替中は大量のタブ操作が起きるので見送る（切替の最後に bindings が変わり、そちらで適用される）
 */
function checkWorkspaceTab(windowId) {
  if (windowId === undefined || isSwitching(windowId)) return;
  scheduleWorkspaceTab(windowId);
}

chrome.tabs.onCreated.addListener((tab) => {
  scheduleSnapshot(tab.windowId);
  refreshWindowIndicator(tab.windowId);
  // ワークスペースタブのグループの隣で開いたタブがグループに入ってしまった場合などに外す
  if (tab.groupId !== undefined && tab.groupId !== -1) checkWorkspaceTab(tab.windowId);
});
chrome.tabs.onUpdated.addListener((id, info, tab) => {
  // ページ遷移でタブ単位のアイコン / タイトルが消えることがあるので、その都度「今のワークスペース」を再適用する
  if (info.status === 'loading' || info.status === 'complete' || info.url) scheduleTabIndicator(id, tab.windowId);
  // title 単体の変化（チャットの未読数など）では保存しない。タイトルは読み込み完了時に拾う
  if ('url' in info || 'pinned' in info || 'groupId' in info || info.status === 'complete') {
    scheduleSnapshot(tab.windowId);
  }
  // グループの出入り・固定、グループ内のタブの遷移（ワークスペースタブが別ページへ移動した等）でワークスペースタブを点検する
  if ('groupId' in info || 'pinned' in info || ('url' in info && (isWorkspaceTabUrl(tabUrl(tab)) || tab.groupId !== -1))) {
    checkWorkspaceTab(tab.windowId);
  }
  if (info.url || info.status === 'complete' || info.audible === false) onTabMaybeDiscardable(id).catch(() => {});
});
chrome.tabs.onMoved.addListener((_id, info) => {
  scheduleSnapshot(info.windowId);
  checkWorkspaceTab(info.windowId);
});
chrome.tabs.onAttached.addListener((_id, info) => {
  scheduleSnapshot(info.newWindowId);
  refreshWindowIndicator(info.newWindowId);
  checkWorkspaceTab(info.newWindowId);
});
chrome.tabs.onDetached.addListener((_id, info) => {
  scheduleSnapshot(info.oldWindowId);
  checkWorkspaceTab(info.oldWindowId);
});
chrome.tabs.onRemoved.addListener((id, info) => {
  forgetDiscard(id).catch(() => {});
  forgetInheritedAccess(id).catch(() => {});
  // ウィンドウごと閉じる時はスナップショットを更新しない（ワークスペースが空で上書きされるのを防ぐ）
  if (info.isWindowClosing) return;
  scheduleSnapshot(info.windowId);
  // ワークスペースタブが閉じられたら作り直す（割り当て済みのウィンドウのみ。ensure 側で判定）
  checkWorkspaceTab(info.windowId);
});
chrome.tabs.onActivated.addListener(() => { flushDiscardQueue().catch(() => {}); });
chrome.tabs.onReplaced.addListener(async (addedTabId) => {
  try {
    const tab = await chrome.tabs.get(addedTabId);
    scheduleSnapshot(tab.windowId);
    refreshWindowIndicator(tab.windowId);
  } catch { /* 既に閉じられた */ }
});
// 休止グループ（issue #35）のタブが discard で置き換わったら、記録の ID を追従させる
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  noteReplacedTab(removedTabId, addedTabId);
  serialize(() => replaceParkedTabId(removedTabId, addedTabId));
});
chrome.tabGroups.onUpdated.addListener((group) => scheduleSnapshot(group.windowId));
// 休止グループ（issue #35）が消えた（最後のタブが閉じられた・グループから外された）ら記録を捨てる
chrome.tabGroups.onRemoved.addListener((group) => { serialize(() => forgetParkedGroup(group.id)); });

chrome.windows.onRemoved.addListener((windowId) => {
  clearTimeout(snapshotTimers.get(windowId));
  snapshotTimers.delete(windowId);
  forgetWorkspaceTabWindow(windowId);
  serialize(() => onWindowRemoved(windowId));
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  serialize(() => onWindowFocused(windowId));
});

// ---- ツールバーのアイコン / タイトル（今のワークスペース表示） ----
// bindings を書き換える箇所は多数あるので、storage の変更をこの 1 箇所で拾って再適用する。
// 再適用は読み取りのみなので serialize() の外で行う（切替処理の後ろで待たされないように）

let indicatorAllTimer;
function scheduleAllIndicators() {
  clearTimeout(indicatorAllTimer);
  indicatorAllTimer = setTimeout(() => { refreshAllIndicators(); }, 200);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.bindings) {
    for (const wid of changedBindingWindows(changes.bindings.oldValue, changes.bindings.newValue)) {
      refreshWindowIndicator(wid);
      // ワークスペースタブ: 割り当て済みなら置く / グループのタイトル・色を新しいワークスペースにする。
      // 未割り当てになったなら閉じる（prune）。どちらにするかは実行時点の bindings で決める
      scheduleWorkspaceTab(wid, { prune: true });
    }
  }
  if (area === 'local' && changes.state) {
    const { oldValue, newValue } = changes.state;
    // state はタブの変化のたびに保存されるので、名前・色・アイコン・セッション名が変わったときだけ全体を再適用する
    const labelChanged = indicatorSignature(oldValue) !== indicatorSignature(newValue);
    if (labelChanged) scheduleAllIndicators();
    // ワークスペースタブ: グループのタイトル・色の更新、設定の ON / OFF（OFF なら全ウィンドウで閉じる）
    if (labelChanged || workspaceTabEnabled(oldValue) !== workspaceTabEnabled(newValue)) scheduleAllWorkspaceTabs();
    // 休止グループ（issue #35）のタイトル・色も追従させる（ワークスペースが消えたら普通のグループにする）
    if (labelChanged) serialize(async () => refreshParkedGroups(await loadState())).catch(() => {});
    // 同期（issue #4）: ローカルの変化を少し待ってまとめて同期ストレージへ書く（書き込み回数の上限に収める）
    if (newValue?.settings?.syncEnabled) scheduleSync();
  }
  // 他の端末の書き込みが届いた。分割された項目が揃うのを少し待ってから取り込む。
  // 自分の書き込みの通知も区別せず予約する（直後に届いた他の端末の変更を取りこぼさないため。内容が同じなら何も書かない）
  if (area === 'sync') scheduleSync(SYNC_PULL_DELAY_MS);
});

// 同期でリモートの設定・ワークスペースを取り込んだ後: アラームとワークスペースタブ・ツールバー表示を今の設定に合わせる
configureSync({
  onApplied: async (state) => {
    await configureAutoDiscard(state.settings);
    await configureAutoClose(state);
    refreshAllIndicators();
    scheduleAllWorkspaceTabs({ prune: true });
  },
});

// サービスワーカーの起動（再起動・再読み込み）時にも一度適用する。
// ワークスペースタブは未割り当てウィンドウのものを閉じない（ブラウザ起動直後は bindings が空で、
// Chrome が復元したワークスペースタブを対応付け前に閉じてしまうため。対応付け後に prune 付きで適用する）
refreshAllIndicators();
serialize(() => ensureAllWorkspaceTabs({ prune: false })).catch(() => {});

// ---- 起動・インストール ----

const GUIDE_PAGE = 'src/ui/guide.html';

chrome.runtime.onStartup.addListener(() => {
  serialize(async () => {
    const state = await loadState();
    await configureAutoDiscard(state.settings);
    await configureAutoClose(state);
    await flushDiscardQueue();
    await reconcileWindows({ restoreLastIfBlank: true });
  }).finally(() => {
    refreshAllIndicators();
    // 対応付けが済んだので、割り当て済みのウィンドウにはワークスペースタブを置き（復元されたものは再利用）、
    // 対応付けられなかったウィンドウに復元された古いワークスペースタブは閉じる
    scheduleAllWorkspaceTabs({ prune: true });
    // 起動中に他の端末が書いた分を取り込む（同期が OFF なら何もしない）
    scheduleSync(SYNC_PULL_DELAY_MS);
  });
});

chrome.runtime.onInstalled.addListener((details) => {
  // 初回インストール時だけ使い方ページを開く（更新・再読み込み時は開かない）
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL(GUIDE_PAGE) }).catch((e) => console.warn(e));
  }
  serialize(async () => {
    const { state: raw } = await chrome.storage.local.get('state');
    const state = normalizeState(raw);
    await saveState(state);
    await configureAutoDiscard(state.settings);
    await configureAutoClose(state);
    await flushDiscardQueue();
    // 拡張の再読み込み・更新時は storage.session が消えるので、ウィンドウとの対応付けをやり直す
    await reconcileWindows({ restoreLastIfBlank: false });
  }).finally(() => {
    refreshAllIndicators();
    scheduleAllWorkspaceTabs({ prune: true });
    scheduleSync(SYNC_PULL_DELAY_MS);
  });
});

// ---- ブックマーク ----

chrome.bookmarks.onImportBegan.addListener(() => setImporting(true));
chrome.bookmarks.onImportEnded.addListener(() => setImporting(false));

chrome.bookmarks.onCreated.addListener((id, node) => {
  serialize(async () => {
    const state = await loadState();
    let win;
    try {
      win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    } catch {
      return;
    }
    const wsId = (await getBindings())[win.id];
    const ws = wsId && state.workspaces[wsId];
    if (!ws) return;
    const [active] = await chrome.tabs.query({ windowId: win.id, active: true });
    const ok = shouldRouteBookmark({
      node,
      enabled: state.settings.routeBookmarks,
      importing: isImporting(),
      ownIds: ownCreatedIds,
      targetFolderId: ws.bookmarkFolderId,
      activeTabUrl: active ? tabUrl(active) : '',
    });
    if (!ok) return;
    try {
      await chrome.bookmarks.move(id, { parentId: ws.bookmarkFolderId });
    } catch (e) {
      console.warn('[workspace] failed to route bookmark', e);
    }
  });
});

chrome.bookmarks.onRemoved.addListener((_id, info) => {
  const removed = new Set(collectIds(info.node));
  serialize(() => mutate((state) => {
    for (const ws of Object.values(state.workspaces)) {
      if (ws.bookmarkFolderId && removed.has(ws.bookmarkFolderId)) {
        ws.bookmarkFolderId = null;
        ws.bookmarkFolderManaged = false;
      }
    }
  }));
});

// ---- ショートカット ----

/** 操作対象の通常ウィンドウ。管理パネルのポップアップなどから押された場合は、最後にフォーカスした通常ウィンドウ */
async function normalWindowId(windowId) {
  if (windowId !== undefined && await isNormalWindow(windowId)) return windowId;
  return (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id;
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'open-side-panel') {
    // トグル: 管理パネルが開いていれば閉じ、無ければこのウィンドウ用に開く
    toggleManager(tab?.windowId).catch((e) => console.warn(e));
    return;
  }
  if (command === 'save-bookmark') {
    serialize(async () => saveCurrentTab(await normalWindowId(tab?.windowId))).catch((e) => {
      // フォルダ未接続などで保存できなかったことをバッジで知らせる（理由はツールチップに表示）
      console.warn(e);
      flashBadge(tab?.id, '!', e.message);
    });
    return;
  }
  if (command === 'next-workspace' || command === 'prev-workspace') {
    serialize(async () => {
      const windowId = await normalWindowId(tab?.windowId);
      const state = await loadState();
      const current = (await getBindings())[windowId];
      const target = neighborWorkspace(state.workspaceOrder, current, command === 'next-workspace' ? 1 : -1);
      if (target && target !== current) await switchWorkspace(windowId, target);
    }).catch((e) => console.warn(e));
  }
});

async function saveCurrentTab(windowId) {
  if (windowId === undefined) windowId = (await chrome.windows.getLastFocused()).id;
  const state = await loadState();
  const ws = state.workspaces[(await getBindings())[windowId]];
  if (!ws) throw new Error('このウィンドウはワークスペースに割り当てられていません');
  if (!ws.bookmarkFolderId) throw new Error(`「${ws.name}」にブックマークフォルダが接続されていません`);
  const [active] = await chrome.tabs.query({ windowId, active: true });
  if (!active) throw new Error('アクティブなタブがありません');
  const res = await saveToFolder(ws.bookmarkFolderId, { url: tabUrl(active), title: active.title });
  flashBadge(active.id, res.duplicated ? '=' : '+', res.duplicated ? '保存済みです' : 'ブックマークに保存しました');
  return res;
}

/** ツールバーアイコンのバッジとツールチップで結果を一瞬知らせる */
function flashBadge(tabId, text, title) {
  if (tabId === undefined) return;
  chrome.action.setBadgeText({ text, tabId }).catch(() => {});
  chrome.action.setTitle({ title: `seiton: ${title}`, tabId }).catch(() => {});
  setTimeout(() => {
    chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
    // ツールチップは manifest の既定ではなく、このタブのウィンドウの「今のワークスペース」表示に戻す
    refreshTabIndicator(tabId);
  }, text === '!' ? 4000 : 1500);
}

// ---- メモリ ----

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === AUTO_DISCARD_ALARM) {
    const state = await loadState();
    await runAutoDiscard(state.settings.autoDiscardMinutes);
  } else if (alarm.name === AUTO_CLOSE_ALARM) {
    // ワークスペース切替と交互に走らないよう直列キューを通す
    await serialize(async () => runAutoClose(await loadState())).catch((e) => console.warn(e));
  }
});

// ---- UI からのメッセージ ----

async function getPalette(windowId) {
  const state = await loadState();
  const bindings = await getBindings();
  const wsId = bindings[windowId];
  const ws = wsId ? state.workspaces[wsId] : null;
  const tabs = (await chrome.tabs.query({ windowId }))
    .filter((t) => !isManagerUrl(tabUrl(t)) && !isWorkspaceTabUrl(tabUrl(t)))
    .map((t) => ({
      id: t.id, title: t.title, url: tabUrl(t), active: t.active, discarded: t.discarded, pinned: t.pinned,
    }));
  const bookmarks = ws?.bookmarkFolderId ? await listFolderBookmarks(ws.bookmarkFolderId) : null;
  return { state, bindings, workspaceId: wsId || null, tabs, bookmarks };
}

// 読み取り専用の処理は直列キューを通さずに即応答する
const readOnly = {
  // parked: 休止中のワークスペース（issue #35）→ { windowId, groupId }
  getState: async () => ({ state: await loadState(), bindings: await getBindings(), parked: await parkedByWorkspace() }),
  getPalette: ({ windowId }) => getPalette(windowId),
  listFolders: () => listAllFolders(),
  // 管理パネルの開閉は状態を書き換えないので直列キューを通さない（切替中でもすぐ開く。開閉自体は manager.js 内で直列化）
  openManager: ({ windowId }) => openManager(windowId),
  listFolderBookmarks: ({ folderId }) => listFolderBookmarks(folderId),
  // 全ワークスペースの接続フォルダのブックマーク（管理パネルの横断検索用）
  listWorkspaceBookmarks: async () => {
    const state = await loadState();
    const out = [];
    for (const id of state.workspaceOrder) {
      const ws = state.workspaces[id];
      if (!ws?.bookmarkFolderId) continue;
      const bm = await listFolderBookmarks(ws.bookmarkFolderId);
      if (bm) out.push({ workspaceId: id, folderId: ws.bookmarkFolderId, title: bm.title, items: bm.items });
    }
    return out;
  },
  // 自動クローズで閉じたタブの履歴（新しい順）
  listClosedTabs: () => listClosedTabs(),
  // Cookie の分離の状態（権限・今の Cookie のセッション・各セッションの退避 Cookie の件数）
  getCookieStatus: async ({ live = true } = {}) => cookieStatus(await loadState(), { live }),
  // 同期の状態（ON / OFF・最終同期・使用量・タブを省略したワークスペース・エラー）
  getSyncStatus: () => getSyncStatus(),
};

const mutating = {
  // park: 今のタブを閉じずに休止グループに残して切り替える（issue #35）
  switchWorkspace: ({ windowId, workspaceId, park }) => switchWorkspace(windowId, workspaceId, { park: !!park }),
  openInNewWindow: ({ workspaceId }) => openInNewWindow(workspaceId),
  createWorkspace: async (msg) => {
    const res = await createWorkspace(msg);
    if (msg.switchTo && msg.windowId !== undefined) await switchWorkspace(msg.windowId, res.workspaceId, { park: !!msg.park });
    return res;
  },
  // 休止中のワークスペースのタブを閉じる（休止を終了）
  closeParked: ({ workspaceId }) => closeParked(workspaceId),
  // 管理パネルで選んだタブを別のワークスペースへ移す（issue #33）。開いているタブは tabIds、開いていないワークスペースの保存タブは picks（[{ index, url }]）
  moveTabs: ({ tabIds, workspaceId }) => moveTabsToWorkspace(tabIds, workspaceId),
  moveSavedTabs: ({ fromWorkspaceId, picks, workspaceId }) => moveSavedTabs(fromWorkspaceId, picks, workspaceId),
  updateWorkspace: async ({ id, patch }) => {
    const res = await updateWorkspace(id, patch);
    if (patch && 'autoClose' in patch) await configureAutoClose(await loadState());
    return res;
  },
  reorderWorkspace: ({ id, toIndex }) => reorderWorkspace(id, toIndex),
  deleteWorkspace: ({ id }) => deleteWorkspace(id),
  // 管理ダイアログの一括変更 / 一括削除（issue #25）
  updateWorkspaces: async ({ ids, patch }) => {
    const res = await updateWorkspaces(ids, patch);
    if (patch && 'autoClose' in patch) await configureAutoClose(await loadState());
    return res;
  },
  deleteWorkspaces: ({ ids }) => deleteWorkspaces(ids),
  detachWindow: ({ windowId }) => detachWindow(windowId),
  createSession: ({ name }) => createSession(name),
  renameSession: ({ id, name }) => renameSession(id, name),
  deleteSession: ({ id, moveToId }) => deleteSession(id, moveToId),
  openSessionWindows: ({ sessionId }) => openSessionWindows(sessionId),
  createFolderFor: async ({ workspaceId }) => {
    const state = await loadState();
    const ws = state.workspaces[workspaceId];
    if (!ws) throw new Error('ワークスペースが見つかりません');
    const folderId = await createFolderForWorkspace(ws.name, state.settings);
    await updateWorkspace(workspaceId, { bookmarkFolderId: folderId, bookmarkFolderManaged: true });
    return { folderId };
  },
  // 管理パネルでタブをワークスペース（の接続フォルダ）へドロップした時の登録
  addBookmarkToWorkspace: async ({ workspaceId, url, title }) => {
    const state = await loadState();
    const ws = state.workspaces[workspaceId];
    if (!ws) throw new Error('ワークスペースが見つかりません');
    if (!ws.bookmarkFolderId) throw new Error('このワークスペースにはブックマークフォルダが接続されていません');
    if (!isBookmarkableUrl(url)) throw new Error('このページはブックマークに保存できません');
    // サブフォルダも含めて同じ URL があれば作らない（一覧はサブフォルダも平坦化して表示しているため）
    const existing = await listFolderBookmarks(ws.bookmarkFolderId);
    if (!existing) throw new Error(`「${ws.name}」の接続フォルダが見つかりません`);
    const dup = findBookmarkByUrl(existing.items, url);
    if (dup) return { created: false, bookmarkId: dup.id, workspaceName: ws.name };
    const res = await saveToFolder(ws.bookmarkFolderId, { url, title });
    return { created: !res.duplicated, bookmarkId: res.bookmarkId, workspaceName: ws.name };
  },
  linkFolder: ({ workspaceId, folderId }) =>
    updateWorkspace(workspaceId, { bookmarkFolderId: folderId || null, bookmarkFolderManaged: false }),
  saveCurrentTab: ({ windowId }) => saveCurrentTab(windowId),
  discardInactive: ({ windowId }) => discardInactiveInWindow(windowId),
  removeClosedTab: ({ id }) => removeClosedTab(id),
  clearClosedTabs: () => clearClosedTabs(),
  updateSettings: async ({ patch }) => {
    const state = await mutate((state) => {
      const prevAutoClose = state.settings.autoClose;
      // 同期の ON / OFF は setSyncEnabled（初回同期を伴う）で変える。端末ごとの設定なので更新時刻も動かさない
      const { syncEnabled: _ignored, ...rest } = patch || {};
      Object.assign(state.settings, rest);
      state.settingsAt = Date.now();
      state.settings.autoDiscardMinutes = Math.max(0, Number(state.settings.autoDiscardMinutes) || 0);
      state.settings.workspaceTab = state.settings.workspaceTab !== false;
      state.settings.switchMode = normalizeSwitchMode(state.settings.switchMode);
      // 一部の項目だけの patch も受け付け、不正な日数（NaN・負など）は今の値を保つ
      if (patch && 'autoClose' in patch) {
        state.settings.autoClose = normalizeAutoClose({ ...prevAutoClose, ...patch.autoClose }, prevAutoClose);
      }
      // 除外 URL は配列ごと置き換える（空・重複を除く）。1 件ずつの追加 / 削除は addAutoCloseExclude / removeAutoCloseExclude
      state.settings.autoCloseExclude = normalizeExcludePatterns(state.settings.autoCloseExclude);
      return state;
    });
    await configureAutoDiscard(state.settings);
    await configureAutoClose(state);
    return state.settings;
  },
  // 自動クローズの除外 URL を 1 件追加（管理パネルの「自動クローズから除外」・設定画面の「追加」）。既にあれば added: false
  addAutoCloseExclude: ({ pattern }) => mutate((state) => {
    const p = normalizeExcludePattern(pattern);
    if (!p) throw new Error('除外する URL を入力してください');
    const list = state.settings.autoCloseExclude;
    const added = !list.includes(p);
    if (added) {
      state.settings.autoCloseExclude = [...list, p];
      state.settingsAt = Date.now();
    }
    return { added, pattern: p, patterns: state.settings.autoCloseExclude };
  }),
  // 自動クローズの除外 URL を 1 件削除（無ければ何もしない）
  removeAutoCloseExclude: ({ pattern }) => mutate((state) => {
    const p = normalizeExcludePattern(pattern);
    const list = state.settings.autoCloseExclude;
    state.settings.autoCloseExclude = list.filter((x) => x !== p);
    const removed = list.length !== state.settings.autoCloseExclude.length;
    if (removed) state.settingsAt = Date.now();
    return { removed, patterns: state.settings.autoCloseExclude };
  }),
  /**
   * Cookie の分離に必要な権限が許可された直後に呼ぶ（UI 側で permissions.request してから）。
   * sessionId: 権限を求めたウィンドウのワークスペースのセッション。「今の Cookie のセッション」が未定ならこれにする
   */
  grantCookieIsolation: async ({ sessionId }) => {
    if (!(await hasCookiePermission())) throw new Error('Cookie を読み書きする権限が許可されていません');
    return adoptCookieSession(await loadState(), sessionId);
  },
  // 退避した Cookie をすべて削除（今 Chrome に入っている Cookie は消さない）
  clearCookieJars: () => clearCookieJars(),
  // 同期（issue #4）: ON にすると初回同期（ローカルとリモートの和集合）を行う。OFF は止めるだけ（同期ストレージは残す）
  setSyncEnabled: ({ enabled }) => setSyncEnabled(!!enabled),
  // 今すぐ取り込み → 書き出し（同期が OFF なら何もしない）
  syncNow: () => runSync(),
  // 同期ストレージを空にして OFF にする（他の端末のローカルデータは消えない）
  clearSyncData: () => clearSyncData(),
  importData: async ({ data }) => {
    const prev = await loadState();
    const state = normalizeState(data);
    // 同期の ON / OFF は端末ごとの設定なので、インポートしたファイルの値ではなく今の値を保つ
    state.settings.syncEnabled = prev.settings.syncEnabled;
    // インポートした内容を「最新」として扱う（同期で他の端末の設定・並び順より優先される）
    state.settingsAt = Date.now();
    state.orderAt = Date.now();
    await saveState(state);
    await configureAutoDiscard(state.settings);
    await configureAutoClose(state);
    await reconcileWindows({ restoreLastIfBlank: false });
    await ensureAllWorkspaceTabs({ prune: true });
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = readOnly[msg?.type] || mutating[msg?.type];
  if (!handler) return false;
  const run = readOnly[msg.type] ? handler(msg) : serialize(() => handler(msg));
  Promise.resolve(run).then(
    (data) => sendResponse({ ok: true, data }),
    (e) => sendResponse({ ok: false, error: e?.message || String(e) }),
  );
  return true;
});
