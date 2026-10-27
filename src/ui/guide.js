// 使い方ページ。ショートカットの実際の割り当てを表示し、chrome:// ページや管理パネルへのボタンを動かす。
import { call, h, attempt } from './api.js';

const $ = (id) => document.getElementById(id);

const COMMAND_LABELS = {
  _execute_action: 'クイックパレットを開く',
};

async function renderShortcuts() {
  const commands = await chrome.commands.getAll();
  // 本文中の <span data-key="..."> も実際の割り当てに置き換える
  for (const c of commands) {
    for (const el of document.querySelectorAll(`[data-key="${c.name}"]`)) {
      el.replaceChildren(c.shortcut ? h('kbd', {}, c.shortcut) : h('span', { class: 'muted' }, '（未設定）'));
    }
  }
  $('commands').replaceChildren(...commands.map((c) => h('tr', {},
    h('td', {}, c.shortcut ? h('kbd', {}, c.shortcut) : h('span', { class: 'muted' }, '未設定')),
    h('td', {}, COMMAND_LABELS[c.name] || c.description))));
}

const openUrl = (url) => chrome.tabs.create({ url });

$('openManager').addEventListener('click', () => attempt(() => call('openManager')));
$('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('openShortcuts').addEventListener('click', () => openUrl('chrome://extensions/shortcuts'));
$('openShortcuts2').addEventListener('click', () => openUrl('chrome://extensions/shortcuts'));
$('openPerf').addEventListener('click', () => openUrl('chrome://settings/performance'));

attempt(renderShortcuts);
