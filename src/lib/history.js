// 自動クローズで閉じたタブの履歴（issue #18）。
// storage.local の closedTabs キーに新しい順で保存する（タブ変化のたびに保存される state を肥大化させないため別キー）。
// 書き込みはこのモジュールの直列キューで read-modify-write する。自動クローズは store.js の serialize の中から
// 呼ばれるので、そのキューを使うと待ち合わせで止まる。ここでは別のキューにする
import { CLOSED_TABS_MAX, trimClosedTabs } from './core.js';

const CLOSED_TABS_KEY = 'closedTabs';

let queue = Promise.resolve();

function serializeHistory(fn) {
  const run = queue.then(fn);
  queue = run.catch((e) => console.error('[seiton] closed tab history failed', e));
  return run;
}

/** 新しい順の履歴（壊れた値なら空） */
export async function listClosedTabs() {
  const { [CLOSED_TABS_KEY]: list } = await chrome.storage.local.get(CLOSED_TABS_KEY);
  return Array.isArray(list) ? list : [];
}

/** entries（新しい順）を先頭に追加し、上限を超えた古いものを捨てる */
export function addClosedTabs(entries) {
  if (!Array.isArray(entries) || !entries.length) return Promise.resolve();
  return serializeHistory(async () => {
    const list = trimClosedTabs([...entries, ...await listClosedTabs()], CLOSED_TABS_MAX);
    await chrome.storage.local.set({ [CLOSED_TABS_KEY]: list });
  });
}

export function removeClosedTab(id) {
  return serializeHistory(async () => {
    const list = await listClosedTabs();
    const next = list.filter((e) => e?.id !== id);
    if (next.length !== list.length) await chrome.storage.local.set({ [CLOSED_TABS_KEY]: next });
  });
}

export function clearClosedTabs() {
  return serializeHistory(() => chrome.storage.local.set({ [CLOSED_TABS_KEY]: [] }));
}
