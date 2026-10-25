// メモリ管理。
// 基本方針: ワークスペース切替でタブを閉じること自体が最大の節約になり、
// ワークスペース内のタブは Chrome 標準の「メモリセーバー」に任せる。
// ここでは (1) 復元時の遅延読み込み と (2) 任意の自動 discard（既定オフ）だけを提供する。
//
// 遅延読み込みは「URL が確定したタブだけを discard する」。確定前に discard すると
// about:blank に化けるため、キューを storage.session に置き、サービスワーカーが
// 止まっても tabs.onUpdated で再開できるようにする。

export const AUTO_DISCARD_ALARM = 'auto-discard';

const DISCARD_KEY = 'discardQueue';
let queueLoaded = false;
let queue = new Set();
let persistChain = Promise.resolve();
let loadingQueue = null;

async function ensureQueue() {
  if (queueLoaded) return;
  if (!loadingQueue) {
    loadingQueue = chrome.storage.session.get(DISCARD_KEY).then((stored) => {
      queue = new Set(stored[DISCARD_KEY] || []);
      queueLoaded = true;
    });
  }
  await loadingQueue;
}

function persistQueue() {
  persistChain = persistChain.then(() => chrome.storage.session.set({ [DISCARD_KEY]: [...queue] }));
  return persistChain;
}

/** タブを discard する。読み込み直後・アクティブ・音声再生中などで失敗しても無視する */
export async function discardSafely(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.active || tab.audible || tab.discarded || tab.autoDiscardable === false) return false;
    await chrome.tabs.discard(tabId);
    return true;
  } catch {
    return false;
  }
}

/**
 * 復元した非前面タブを、URL 確定後に discard する対象として覚える。
 * 確定前・前面にある間・音声再生中はキューに残し、後続の onUpdated / onActivated で再試行する。
 */
export async function enqueueDiscard(tabIds) {
  const ids = [...new Set(tabIds.filter((id) => id != null))];
  if (!ids.length) return;
  await ensureQueue();
  for (const id of ids) queue.add(id);
  await persistQueue();
  for (const id of ids) await discardIfQueued(id);
}

/** 前面にしたタブを遅延 discard の対象から外す */
export async function cancelDiscard(tabId) {
  await ensureQueue();
  if (!queue.delete(tabId)) return;
  await persistQueue();
}

export async function forgetDiscard(tabId) {
  await cancelDiscard(tabId);
}

/** キューにあるタブのうち、今すぐ休止できるものを休止する */
export async function flushDiscardQueue() {
  await ensureQueue();
  for (const id of [...queue]) await discardIfQueued(id);
}

/** onUpdated から呼ぶ。キューに無ければ何もしない */
export async function onTabMaybeDiscardable(tabId) {
  await ensureQueue();
  if (!queue.has(tabId)) return;
  await discardIfQueued(tabId);
}

async function discardIfQueued(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    queue.delete(tabId);
    await persistQueue();
    return;
  }
  if (tab.discarded || tab.autoDiscardable === false) {
    queue.delete(tabId);
    await persistQueue();
    return;
  }
  // URL 未確定の discard は about:blank になる。前面・音声再生中は休止できないので残す
  if (!tab.url || tab.url === 'about:blank' || tab.pendingUrl) return;
  if (tab.active || tab.audible) return;
  if (await discardSafely(tabId)) {
    queue.delete(tabId);
    await persistQueue();
  }
}

export async function configureAutoDiscard(settings) {
  await chrome.alarms.clear(AUTO_DISCARD_ALARM);
  if (settings.autoDiscardMinutes > 0) {
    await chrome.alarms.create(AUTO_DISCARD_ALARM, { periodInMinutes: 1 });
  }
}

/** 最後にアクティブになってから minutes 分以上経過したタブを discard する */
export async function runAutoDiscard(minutes) {
  if (!(minutes > 0)) return 0;
  const threshold = Date.now() - minutes * 60_000;
  const tabs = await chrome.tabs.query({ active: false, discarded: false, audible: false, windowType: 'normal' });
  let count = 0;
  for (const t of tabs) {
    if (t.pinned) continue;
    if (!t.lastAccessed || t.lastAccessed > threshold) continue;
    if (await discardSafely(t.id)) count++;
  }
  return count;
}

/** 現在の全タブのうち非アクティブなものを即座に discard する（手動ボタン用） */
export async function discardInactiveInWindow(windowId) {
  const tabs = await chrome.tabs.query({ windowId, active: false, discarded: false });
  let count = 0;
  for (const t of tabs) if (await discardSafely(t.id)) count++;
  return count;
}
