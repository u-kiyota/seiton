// UI → サービスワーカーへの呼び出しと、DOM 生成の小さなヘルパー。
import { COLOR_HEX } from '../lib/core.js';

export async function call(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res) throw new Error('サービスワーカーから応答がありません');
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

/** h('div', { class: 'x', onclick: fn }, child1, 'text') */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** favicon 権限経由でページの favicon URL を得る */
export function faviconUrl(pageUrl) {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', pageUrl || '');
  u.searchParams.set('size', '16');
  return u.toString();
}

// 色の hex 表は core.js に一本化（サービスワーカーのツールバーアイコン描画と共用）。既存の import 元を変えないよう再 export する
export { COLOR_HEX };

/**
 * ワークスペースのアイコン要素。icon（絵文字）があれば色の薄い背景にアイコン、無ければ色のドット。
 * size: 'sm'（一覧・パレット） / 'lg'（詳細ヘッダー）
 */
export function wsIcon(ws, size = 'sm') {
  const color = COLOR_HEX[ws?.color] || COLOR_HEX.grey;
  if (!ws?.icon) return h('span', { class: `dot dot-${size}`, style: { background: color } });
  return h('span', {
    class: `ws-icon ws-icon-${size}`,
    style: { background: `color-mix(in srgb, ${color} 22%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 45%, transparent)` },
  }, ws.icon);
}

export function toast(msg, isError = false) {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast' });
    document.body.append(el);
  }
  el.textContent = msg;
  el.className = isError ? 'show error' : 'show';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.className = ''), 2500);
}

/** 非同期処理を実行し、失敗したらトーストを出す */
export async function attempt(fn) {
  try {
    return await fn();
  } catch (e) {
    toast(e.message || String(e), true);
    return undefined;
  }
}
