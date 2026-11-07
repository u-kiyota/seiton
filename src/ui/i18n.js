// 表示文言だけをバインドし、言語変更で入力欄やユーザーデータを描き直さない。
import { t, translateText, getLanguage, setLanguage, registerMessages } from '../lib/i18n.js';
import { messages } from './i18n-messages.js';
registerMessages(messages);
const bindings = new Set();

export class LocalizedValue {
  constructor(render) { this.render = render; }
  toString() { return String(this.render()); }
  [Symbol.toPrimitive]() { return this.toString(); }
}
export const localizedValue = render => new LocalizedValue(render);

export class LocalizedText extends String {
  constructor(key, params = {}) { super(t(key, params)); this.key = key; this.params = params; }
  toString() { return t(this.key, Object.fromEntries(Object.entries(this.params).map(([k, v]) => [k, isLocalizedText(v) ? v.toString() : v]))); }
  valueOf() { return this.toString(); }
  [Symbol.toPrimitive]() { return this.toString(); }
}
export const uiText = (key, params) => new LocalizedText(key, params);
export const isLocalizedText = (value) => value instanceof LocalizedText || value instanceof LocalizedValue;

function bind(node, update) { const binding = { node: new WeakRef(node), update }; bindings.add(binding); update(node); }
export function textNode(value) {
  const node = document.createTextNode(String(value));
  if (isLocalizedText(value)) bind(node, target => { target.data = String(value); });
  return node;
}
export function setText(element, value) {
  element.replaceChildren(textNode(value));
}
export function replaceChildren(element, ...values) {
  element.replaceChildren(...values.map(value => isLocalizedText(value) ? textNode(value) : value));
}
export function setTranslatedAttribute(element, name, value) {
  if (isLocalizedText(value)) bind(element, target => target.setAttribute(name, String(value)));
  else element.setAttribute(name, String(value));
}

// 静的HTMLはスクリプトが動的な内容を追加する前に一度だけ登録する。
function bindStaticHtml() {
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (node.parentElement.closest('script, style, textarea, [translate="no"]')) continue;
    const original = node.data;
    const key = original.replace(/\s+/g, ' ').trim();
    if (!Object.hasOwn(messages, key)) continue;
    const leading = original.match(/^\s*/)[0];
    const trailing = original.match(/\s*$/)[0];
    bind(node, target => { target.data = leading + t(key) + trailing; });
  }
  for (const element of document.querySelectorAll('[title], [placeholder], [aria-label]')) {
    for (const name of ['title', 'placeholder', 'aria-label']) {
      const key = element.getAttribute(name);
      if (key && Object.hasOwn(messages, key)) setTranslatedAttribute(element, name, uiText(key));
    }
  }
}

export function applyLanguage(value) {
  setLanguage(value);
  document.documentElement.lang = getLanguage();
  document.documentElement.removeAttribute('data-i18n-pending');
  for (const binding of bindings) {
    const node = binding.node.deref();
    if (!node?.isConnected) bindings.delete(binding);
    else binding.update(node);
  }
  const select = document.getElementById('language');
  if (select) select.value = value || 'auto';
  document.dispatchEvent(new CustomEvent('languagechange', { detail: { language: getLanguage() } }));
}

export function languageOnlyChange(change) {
  if (!change?.oldValue || !change?.newValue) return false;
  const strip = state => {
    const { settingsAt, settings, ...rest } = state;
    const { language, ...otherSettings } = settings || {};
    return { ...rest, settings: otherSettings };
  };
  return JSON.stringify(strip(change.oldValue)) === JSON.stringify(strip(change.newValue));
}

export async function initializeI18n() {
  bindStaticHtml();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.state) applyLanguage(changes.state.newValue?.settings?.language);
  });
  try {
    const response = await chrome.runtime.sendMessage({ type: 'getState' });
    applyLanguage(response?.data?.state?.settings?.language);
  } catch { applyLanguage('auto'); }
}
export { translateText, getLanguage };

const COMMAND_KEYS = {
  '_execute_action': 'クイックパレットを開く',
  'open-side-panel': '管理パネルを開く',
  'save-bookmark': '現在のタブをブックマークに保存',
  'next-workspace': '次のワークスペースへ',
  'prev-workspace': '前のワークスペースへ',
};
export const commandLabel = command => COMMAND_KEYS[command.name] ? uiText(COMMAND_KEYS[command.name]) : command.description;
