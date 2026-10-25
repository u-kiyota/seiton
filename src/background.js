// サービスワーカー: Chrome のイベントを受けて状態を更新する唯一の書き手。
// UI（管理パネル / ポップアップ / オプション）は runtime.sendMessage 経由でここに依頼する。
import { shouldRouteBookmark, neighborWorkspace, tabUrl, normalizeState, isManagerUrl, normalizeAutoClose } from './lib/core.js';
import { openManager, toggleManager } from './lib/manager.js';
import { serialize, loadState, saveState, mutate, getBindings } from './lib/store.js';
import {
  snapshotWindow, switchWorkspace, openInNewWindow, createWorkspace, updateWorkspace, reorderWorkspace,
  deleteWorkspace, detachWindow, createSession, renameSession, deleteSession,
  openSessionWindows, reconcileWindows, onWindowFocused, onWindowRemoved, isSwitching, isNormalWindow,
} from './lib/workspace.js';
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
import { isBookmarkableUrl, findBookmarkByUrl, changedBindingWindows, indicatorSignature } from './lib/core.js';
import {
  refreshWindowIndicator, refreshAllIndicators, refreshTabIndicator, scheduleTabIndicator,
} from './lib/indicator.js';

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

chrome.tabs.onCreated.addListener((tab) => {
  scheduleSnapshot(tab.windowId);
  refreshWindowIndicator(tab.windowId);
});
chrome.tabs.onUpdated.addListener((id, info, tab) => {
  // ページ遷移でタブ単位のアイコン / タイトルが消えることがあるので、その都度「今のワークスペース」を再適用する
  if (info.status === 'loading' || info.status === 'complete' || info.url) scheduleTabIndicator(id, tab.windowId);
  // title 単体の変化（チャットの未読数など）では保存しない。タイトルは読み込み完了時に拾う
  if ('url' in info || 'pinned' in info || 'groupId' in info || info.status === 'complete') {
    scheduleSnapshot(tab.windowId);
  }
  if (info.url || info.status === 'complete' || info.audible === false) onTabMaybeDiscardable(id).catch(() => {});
});
chrome.tabs.onMoved.addListener((_id, info) => scheduleSnapshot(info.windowId));
chrome.tabs.onAttached.addListener((_id, info) => {
  scheduleSnapshot(info.newWindowId);
  refreshWindowIndicator(info.newWindowId);
});
chrome.tabs.onDetached.addListener((_id, info) => scheduleSnapshot(info.oldWindowId));
chrome.tabs.onRemoved.addListener((id, info) => {
  forgetDiscard(id).catch(() => {});
  forgetInheritedAccess(id).catch(() => {});
  // ウィンドウごと閉じる時はスナップショットを更新しない（ワークスペースが空で上書きされるのを防ぐ）
  if (info.isWindowClosing) return;
  scheduleSnapshot(info.windowId);
});
chrome.tabs.onActivated.addListener(() => { flushDiscardQueue().catch(() => {}); });
chrome.tabs.onReplaced.addListener(async (addedTabId) => {
  try {
    const tab = await chrome.tabs.get(addedTabId);
    scheduleSnapshot(tab.windowId);
    refreshWindowIndicator(tab.windowId);
  } catch { /* 既に閉じられた */ }
});
chrome.tabGroups.onUpdated.addListener((group) => scheduleSnapshot(group.windowId));

chrome.windows.onRemoved.addListener((windowId) => {
  clearTimeout(snapshotTimers.get(windowId));
  snapshotTimers.delete(windowId);
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
    }
  }
  // state はタブの変化のたびに保存されるので、名前・色・アイコン・セッション名が変わったときだけ全体を再適用する
  if (area === 'local' && changes.state
    && indicatorSignature(changes.state.oldValue) !== indicatorSignature(changes.state.newValue)) {
    scheduleAllIndicators();
  }
});

// サービスワーカーの起動（再起動・再読み込み）時にも一度適用する
refreshAllIndicators();

// ---- 起動・インストール ----

const GUIDE_PAGE = 'src/ui/guide.html';

chrome.runtime.onStartup.addListener(() => {
  serialize(async () => {
    const state = await loadState();
    await configureAutoDiscard(state.settings);
    await configureAutoClose(state);
    await flushDiscardQueue();
    await reconcileWindows({ restoreLastIfBlank: true });
  }).finally(() => refreshAllIndicators());
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
  }).finally(() => refreshAllIndicators());
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
    .filter((t) => !isManagerUrl(tabUrl(t)))
    .map((t) => ({
      id: t.id, title: t.title, url: tabUrl(t), active: t.active, discarded: t.discarded, pinned: t.pinned,
    }));
  const bookmarks = ws?.bookmarkFolderId ? await listFolderBookmarks(ws.bookmarkFolderId) : null;
  return { state, bindings, workspaceId: wsId || null, tabs, bookmarks };
}

// 読み取り専用の処理は直列キューを通さずに即応答する
const readOnly = {
  getState: async () => ({ state: await loadState(), bindings: await getBindings() }),
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
};

const mutating = {
  switchWorkspace: ({ windowId, workspaceId }) => switchWorkspace(windowId, workspaceId),
  openInNewWindow: ({ workspaceId }) => openInNewWindow(workspaceId),
  createWorkspace: async (msg) => {
    const res = await createWorkspace(msg);
    if (msg.switchTo && msg.windowId !== undefined) await switchWorkspace(msg.windowId, res.workspaceId);
    return res;
  },
  updateWorkspace: async ({ id, patch }) => {
    await updateWorkspace(id, patch);
    if (patch && 'autoClose' in patch) await configureAutoClose(await loadState());
  },
  reorderWorkspace: ({ id, toIndex }) => reorderWorkspace(id, toIndex),
  deleteWorkspace: ({ id }) => deleteWorkspace(id),
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
  updateSettings: async ({ patch }) => {
    const state = await mutate((state) => {
      const prevAutoClose = state.settings.autoClose;
      Object.assign(state.settings, patch);
      state.settings.autoDiscardMinutes = Math.max(0, Number(state.settings.autoDiscardMinutes) || 0);
      // 一部の項目だけの patch も受け付け、不正な日数（NaN・負など）は今の値を保つ
      if (patch && 'autoClose' in patch) {
        state.settings.autoClose = normalizeAutoClose({ ...prevAutoClose, ...patch.autoClose }, prevAutoClose);
      }
      return state;
    });
    await configureAutoDiscard(state.settings);
    await configureAutoClose(state);
    return state.settings;
  },
  importData: async ({ data }) => {
    const state = normalizeState(data);
    await saveState(state);
    await configureAutoDiscard(state.settings);
    await configureAutoClose(state);
    await reconcileWindows({ restoreLastIfBlank: false });
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
