// 状態の永続化。書き込みはサービスワーカーだけが行い、すべて直列キューを通す。
// サービスワーカーはいつ停止してもよいように、メモリ上のキャッシュは持たない。
import { normalizeState } from './core.js';
import { setLanguage } from './i18n.js';

const STATE_KEY = 'state';
const BINDINGS_KEY = 'bindings'; // storage.session: { [windowId]: workspaceId }

let queue = Promise.resolve();

/** fn を直列に実行する（read-modify-write の競合防止） */
export function serialize(fn) {
  const run = queue.then(fn);
  queue = run.catch((e) => console.error('[workspace] task failed', e));
  return run;
}

export async function loadState() {
  const { [STATE_KEY]: raw } = await chrome.storage.local.get(STATE_KEY);
  setLanguage(raw?.settings?.language);
  return normalizeState(raw);
}

export async function saveState(state) {
  setLanguage(state.settings?.language);
  await chrome.storage.local.set({ [STATE_KEY]: state });
}

/** state を読み込み mutator で変更して保存する。必ず serialize の中から呼ぶこと */
export async function mutate(mutator) {
  const state = await loadState();
  const result = await mutator(state);
  await saveState(state);
  return result;
}

export async function getBindings() {
  const { [BINDINGS_KEY]: b } = await chrome.storage.session.get(BINDINGS_KEY);
  return b || {};
}

export async function setBinding(windowId, workspaceId) {
  const b = await getBindings();
  if (workspaceId) b[windowId] = workspaceId;
  else delete b[windowId];
  await chrome.storage.session.set({ [BINDINGS_KEY]: b });
}

export async function clearBindings() {
  await chrome.storage.session.set({ [BINDINGS_KEY]: {} });
}

export async function windowForWorkspace(workspaceId) {
  const b = await getBindings();
  const entry = Object.entries(b).find(([, ws]) => ws === workspaceId);
  return entry ? Number(entry[0]) : null;
}
