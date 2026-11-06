// UIの翻訳漏れと、言語変更時の入力・ユーザー文字列の保持を確認する。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { messages } from '../src/ui/i18n-messages.js';
import { t, setLanguage } from '../src/lib/i18n.js';
import { uiText, textNode, setText, setTranslatedAttribute, applyLanguage, languageOnlyChange, localizedValue, commandLabel } from '../src/ui/i18n.js';

const root = new URL('../src/ui/', import.meta.url);
const placeholders = value => [...new Set(value.match(/\{\w+\}/g) || [])].sort();

test('UI辞書の英訳と補間パラメータがすべて揃う', () => {
  for (const [key, value] of Object.entries(messages)) {
    assert.equal(typeof value, 'string', key);
    assert.ok(value.length, key);
    assert.deepEqual(placeholders(value), placeholders(key), key);
    assert.doesNotMatch(value, /[\u3040-\u30ff\u3400-\u9fff]/, key);
  }
});

test('各HTMLの日本語テキストとアクセシビリティ属性に翻訳がある', () => {
  for (const name of fs.readdirSync(root).filter(name => name.endsWith('.html'))) {
    const html = fs.readFileSync(new URL(name, root), 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<style[\s\S]*?<\/style>/g, '')
      .replace(/<[^>]*translate="no"[^>]*>[\s\S]*?<\/[^>]+>/g, '');
    const keys = [...html.matchAll(/>([^<>]+)</g)].map(match => match[1].replace(/\s+/g, ' ').trim());
    keys.push(...[...html.matchAll(/(?:title|placeholder|aria-label)="([^"]+)"/g)].map(match => match[1]));
    for (const key of keys.filter(key => /[\u3040-\u30ff\u3400-\u9fff]/.test(key))) {
      assert.ok(Object.hasOwn(messages, key), `${name}: ${key}`);
    }
  }
});

test('明示的なUI文言は翻訳し、同じ文字列のユーザー名は翻訳しない', () => {
  setLanguage('en');
  const userName = '保存しました';
  assert.equal(String(uiText('保存しました')), 'Saved');
  assert.equal(String(uiText('「{p0}」を作成しました', { p0: userName })), 'Created “保存しました”');
  assert.equal(userName, '保存しました');
  assert.equal(String(uiText('設定に従う（{p0}）', { p0: uiText('無効') })), 'Use settings (Disabled)');
  setLanguage('ja');
});

test('言語だけの更新と、設定・ユーザーデータの更新を区別する', () => {
  const oldValue = { settingsAt: 1, settings: { language: 'ja', lazyRestore: true }, workspaces: { a: { name: '保存しました' } } };
  const newValue = structuredClone(oldValue);
  newValue.settings.language = 'en'; newValue.settingsAt = 2;
  assert.equal(languageOnlyChange({ oldValue, newValue }), true);
  newValue.settings.lazyRestore = false;
  assert.equal(languageOnlyChange({ oldValue, newValue }), false);
  newValue.settings.lazyRestore = true; newValue.workspaces.a.name = 'Edited';
  assert.equal(languageOnlyChange({ oldValue, newValue }), false);
  assert.equal(languageOnlyChange({ newValue }), false);
});

test('開いている画面の文言・属性だけ更新し、入力・ユーザー名・ノードを保つ', () => {
  const previous = { document: globalThis.document, CustomEvent: globalThis.CustomEvent };
  class FakeText { constructor(data) { this.data = data; this.isConnected = true; } }
  class FakeElement {
    constructor() { this.children = []; this.attributes = {}; this.isConnected = true; this.value = ''; }
    replaceChildren(...children) { for (const child of this.children) child.isConnected = false; this.children = children; }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
  }
  const html = new FakeElement();
  globalThis.document = { createTextNode: value => new FakeText(value), documentElement: html, getElementById: () => null, dispatchEvent: () => {} };
  globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options.detail; } };
  try {
    setLanguage('ja');
    const label = new FakeElement(), input = new FakeElement();
    input.value = '入力途中の名前';
    const rawName = textNode('保存しました');
    const destination = new FakeElement();
    const where = uiText('（このウィンドウ）');
    setText(destination, localizedValue(() => `🏠 保存しました${where}`));
    setText(label, uiText('保存しました'));
    setTranslatedAttribute(input, 'placeholder', uiText('名前'));
    const boundNode = label.children[0];
    const lazy = uiText('有効・{p0}', { p0: localizedValue(() => t('日')) });
    applyLanguage('en');
    assert.equal(html.lang, 'en');
    assert.equal(label.children[0], boundNode);
    assert.equal(boundNode.data, 'Saved');
    assert.equal(input.attributes.placeholder, 'Name');
    assert.equal(input.value, '入力途中の名前');
    assert.equal(rawName.data, '保存しました');
    assert.equal(destination.children[0].data, '🏠 保存しました(This window)');
    assert.equal(String(lazy), 'Enabled · days');
    assert.equal(String(commandLabel({ name: 'prev-workspace', description: 'old language' })), 'Previous workspace');
    applyLanguage('ja');
    assert.equal(boundNode.data, '保存しました');
    assert.equal(destination.children[0].data, '🏠 保存しました（このウィンドウ）');
    assert.equal(input.attributes.placeholder, '名前');
    assert.equal(input.value, '入力途中の名前');
  } finally { globalThis.document = previous.document; globalThis.CustomEvent = previous.CustomEvent; setLanguage('ja'); }
});
