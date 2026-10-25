// ツールバー（action）のアイコンとタイトルで「このウィンドウの今のワークスペース」を示す。
// action のアイコン / タイトルはウィンドウ単位では設定できないので、ウィンドウの全タブにタブ単位で適用する。
// Chrome はメインフレームのナビゲーションでタブ単位の値を消すことがあるため、タブの作成・遷移のたびに再適用する。
// 状態は書き換えない（読み取りのみ）ので serialize() の外から呼んでよい。
import { indicatorLabel } from './core.js';
import { loadState, getBindings } from './store.js';

const SIZES = [16, 32];
const WINDOW_DEBOUNCE_MS = 100;

/** 描画結果のキャッシュ: `${emoji}|${color}|${text}` → { 16: ImageData, 32: ImageData } */
const imageCache = new Map();
const windowTimers = new Map();

/** manifest の既定アイコン。サービスワーカー（src/）からの相対解決を避けるため拡張ルートからの絶対パスにする */
function defaultIconPath() {
  const m = chrome.runtime.getManifest();
  const icons = m.action?.default_icon || m.icons || {};
  if (typeof icons === 'string') return '/' + icons.replace(/^\//, '');
  const out = {};
  for (const [size, p] of Object.entries(icons)) out[size] = '/' + String(p).replace(/^\//, '');
  return out;
}

function defaultTitle() {
  return chrome.runtime.getManifest().action?.default_title || 'seiton';
}

function drawIcon(label, size) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas の 2d context が使えません');
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = label.color;
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, size * 0.22);
  ctx.fill();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (label.emoji) {
    ctx.font = `${Math.round(size * 0.72)}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
    ctx.fillStyle = '#000';
  } else {
    ctx.font = `bold ${Math.round(size * 0.68)}px system-ui, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", sans-serif`;
    ctx.fillStyle = '#fff';
  }
  ctx.fillText(label.text, size / 2, size / 2 + size * 0.04);
  return ctx.getImageData(0, 0, size, size);
}

/** label のアイコン画像（16 / 32）。描けない環境では null（呼び出し側は既定アイコンにする）。成功時だけキャッシュする */
function iconImages(label) {
  const key = `${label.emoji ? 'e' : 't'}|${label.color}|${label.text}`;
  if (imageCache.has(key)) return imageCache.get(key);
  try {
    if (typeof OffscreenCanvas === 'undefined') return null;
    const images = {};
    for (const size of SIZES) images[size] = drawIcon(label, size);
    if (imageCache.size > 200) imageCache.clear();
    imageCache.set(key, images);
    return images;
  } catch (e) {
    console.warn('[indicator] アイコンを描画できません', e);
    return null;
  }
}

/** ウィンドウの表示内容: { title, images }（images が null なら既定アイコン）。通常ウィンドウ以外は既定のまま */
function resolveIndicator(win, state, bindings) {
  if (!win || win.type !== 'normal' || win.incognito) return { title: defaultTitle(), images: null };
  const ws = state.workspaces[bindings[win.id]];
  const label = indicatorLabel(ws || null, ws ? state.sessions[ws.sessionId]?.name : '');
  return { title: label.title, images: ws ? iconImages(label) : null };
}

/** 1 タブへ適用。タブが閉じられた直後などの失敗（No tab with id）は無視する */
async function applyToTab(tabId, { title, images }) {
  const run = (fn) => {
    try {
      return Promise.resolve(fn()).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  };
  await Promise.all([
    run(() => (images
      ? chrome.action.setIcon({ tabId, imageData: images })
      : chrome.action.setIcon({ tabId, path: defaultIconPath() }))),
    run(() => chrome.action.setTitle({ tabId, title })),
  ]);
}

async function applyWindow(win, state, bindings) {
  const ind = resolveIndicator(win, state, bindings);
  await Promise.all((win.tabs || []).map((t) => applyToTab(t.id, ind)));
}

/** そのウィンドウの全タブに再適用する（ウィンドウ単位でデバウンス。切替で大量のタブが作られても 1 回にまとめる） */
export function refreshWindowIndicator(windowId) {
  if (!Number.isFinite(windowId) || windowId === chrome.windows.WINDOW_ID_NONE) return;
  clearTimeout(windowTimers.get(windowId));
  windowTimers.set(windowId, setTimeout(() => {
    windowTimers.delete(windowId);
    (async () => {
      let win;
      try {
        win = await chrome.windows.get(windowId, { populate: true });
      } catch {
        return; // 既に閉じられた
      }
      const [state, bindings] = await Promise.all([loadState(), getBindings()]);
      await applyWindow(win, state, bindings);
    })().catch((e) => console.warn('[indicator] refresh failed', e));
  }, WINDOW_DEBOUNCE_MS));
}

/** 全ウィンドウの全タブに再適用する */
export async function refreshAllIndicators() {
  try {
    for (const t of windowTimers.values()) clearTimeout(t);
    windowTimers.clear();
    const [state, bindings, wins] = await Promise.all([
      loadState(), getBindings(), chrome.windows.getAll({ populate: true }),
    ]);
    await Promise.all(wins.map((win) => applyWindow(win, state, bindings)));
  } catch (e) {
    console.warn('[indicator] refresh all failed', e);
  }
}

/** 1 タブだけ即座に再適用する（ページ遷移・バッジ表示の後など）。windowId が分かっていれば渡すと tabs.get を省ける */
export async function refreshTabIndicator(tabId, windowId) {
  if (tabId === undefined) return;
  try {
    if (windowId === undefined) windowId = (await chrome.tabs.get(tabId)).windowId;
    const [state, bindings, win] = await Promise.all([loadState(), getBindings(), chrome.windows.get(windowId)]);
    await applyToTab(tabId, resolveIndicator(win, state, bindings));
  } catch {
    /* タブ / ウィンドウが既に閉じられた */
  }
}
