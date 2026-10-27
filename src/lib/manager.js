// 管理パネルを、呼び出し元の通常ウィンドウ（対象ウィンドウ）の上に一時的なポップアップウィンドウとして開く。
// 対象ウィンドウの id は URL の ?windowId= で渡す。パネルは同時に 1 つだけ。
// 開いているパネルは storage に持たず、毎回 popup 型ウィンドウのタブ URL から探す（サービスワーカーが再起動しても迷子にならない）。
import { isManagerUrl, tabUrl, managerPopupBounds } from './core.js';

const PAGE = 'src/ui/sidepanel.html';

/** 開いている管理パネルのポップアップウィンドウ（{ id, focused, targetId }） */
async function findPanels() {
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['popup'] });
  const out = [];
  for (const w of wins) {
    const tab = w.tabs?.find((t) => isManagerUrl(tabUrl(t)));
    if (!tab) continue;
    let targetId = null;
    try {
      const v = Number(new URL(tabUrl(tab)).searchParams.get('windowId'));
      if (Number.isInteger(v)) targetId = v;
    } catch { /* 不正な URL */ }
    out.push({ id: w.id, focused: w.focused, targetId });
  }
  return out;
}

async function closePanels(panels) {
  for (const p of panels) await chrome.windows.remove(p.id).catch(() => {}); // blur で既に閉じていることがある
}

/** windowId が通常ウィンドウならそれを、そうでなければ最後にフォーカスした通常ウィンドウを返す */
async function resolveTarget(windowId) {
  if (windowId != null) {
    try {
      const w = await chrome.windows.get(windowId);
      if (w.type === 'normal' && !w.incognito) return w;
    } catch { /* 閉じられている */ }
  }
  return chrome.windows.getLastFocused({ windowTypes: ['normal'] });
}

async function doOpen(windowId) {
  const target = await resolveTarget(windowId);
  await closePanels(await findPanels());
  const url = chrome.runtime.getURL(`${PAGE}?windowId=${target.id}`);
  const bounds = target.state === 'minimized' ? null : managerPopupBounds(target);
  const win = await chrome.windows.create({ url, type: 'popup', focused: true, ...(bounds || {}) });
  return win.id;
}

async function doToggle(fromWindowId) {
  const panels = await findPanels();
  // パネル自身から押された / パネルが前面 / 同じウィンドウのパネルが開いている → 閉じる
  if (panels.some((p) => p.focused || p.id === fromWindowId || (fromWindowId != null && p.targetId === fromWindowId))) {
    await closePanels(panels);
    return null;
  }
  return doOpen(fromWindowId);
}

// 連打で 2 つ開かないよう、開閉だけを直列にする（ワークスペース切替の直列キューとは別。切替中でもすぐ開けるように）
let chain = Promise.resolve();
function queue(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

/** 管理パネルを開く（既に開いていれば閉じて、windowId 用に開き直す）。windowId は対象の通常ウィンドウ */
export function openManager(windowId) {
  return queue(() => doOpen(windowId));
}

/** ショートカット用: 開いていれば閉じ、開いていなければ開く。fromWindowId は押したときのウィンドウ（パネル自身のこともある） */
export function toggleManager(fromWindowId) {
  return queue(() => doToggle(fromWindowId));
}
