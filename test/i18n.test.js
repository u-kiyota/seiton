// 言語判定・保存データの移行・表示文言に含まれるユーザー入力の保全を検証する。
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLanguage, resolveLanguage, setLanguage, getLanguage, t, translateText, registerMessages } from '../src/lib/i18n.js';
import { defaultState, normalizeState, indicatorLabel, moveTabsMessage, closedDayLabel } from '../src/lib/core.js';

afterEach(() => setLanguage('auto'));

test('言語設定: 自動判定は日本語の地域別タグに対応し、それ以外は英語。明示指定を優先する', () => {
  assert.equal(normalizeLanguage(undefined), 'auto');
  assert.equal(normalizeLanguage('fr'), 'auto');
  assert.equal(resolveLanguage('auto', 'ja-JP'), 'ja');
  assert.equal(resolveLanguage('auto', 'JA_jp'), 'ja');
  assert.equal(resolveLanguage('auto', 'en-US'), 'en');
  assert.equal(resolveLanguage('auto', 'de-DE'), 'en');
  assert.equal(resolveLanguage('en', 'ja'), 'en');
  assert.equal(resolveLanguage('ja', 'en'), 'ja');
});

test('辞書は完全一致のみ翻訳し、埋め込み値・未知の文言・未指定の変数を保つ', () => {
  setLanguage('en');
  assert.equal(getLanguage(), 'en');
  assert.equal(t('ワークスペースが見つかりません'), 'Workspace not found');
  registerMessages({ 'テスト {name}': 'Test {name}' });
  assert.equal(t('テスト {name}', { name: 'デフォルト <b>今日</b> {other}' }), 'Test デフォルト <b>今日</b> {other}');
  assert.equal(t('テスト {name}'), 'Test {name}');
  assert.equal(t('未知の文言'), '未知の文言');
  assert.equal(translateText('今日', 'en'), 'Today');
  assert.equal(translateText('今日', 'ja'), '今日');
  setLanguage('ja');
  assert.equal(t('テスト {name}', { name: 'A' }), 'テスト A');
});

test('旧データの言語設定を補い、既存の名前と英語設定を保つ', () => {
  const raw = defaultState('ja');
  delete raw.settings.language;
  raw.sessions.sess_default.name = 'デフォルト';
  raw.workspaces.w = { name: '今日', sessionId: 'sess_default', tabs: [] };
  assert.equal(normalizeState(raw).settings.language, 'auto');
  setLanguage('en');
  raw.settings.language = 'en';
  const next = normalizeState(raw);
  assert.equal(next.settings.language, 'en');
  assert.equal(next.sessions.sess_default.name, 'デフォルト');
  assert.equal(next.workspaces.w.name, '今日');
  raw.settings.language = 'invalid';
  assert.equal(normalizeState(raw).settings.language, 'auto');
  assert.equal(defaultState('en').sessions.sess_default.name, 'Default');
});

test('日付・移動結果・未割り当ての表示を選択言語にし、名前は翻訳しない', () => {
  setLanguage('en');
  assert.equal(closedDayLabel(Date.now()), 'Today');
  assert.equal(indicatorLabel(null).title, 'seiton — Unassigned (Quick palette)');
  assert.equal(indicatorLabel({ name: '今日', color: 'grey' }, 'デフォルト').title, 'seiton — 今日 (デフォルト)');
  assert.equal(moveTabsMessage({ moved: 2, skipped: 1, mode: 'saved', workspaceName: '今日' }), 'Added 2 tabs to the saved tabs for “今日” (1 excluded)');
});

test('storage 読み込みはサービスワーカー再起動後も選択言語を復元する', async () => {
  const previous = globalThis.chrome;
  let raw = { settings: { language: 'en' } };
  globalThis.chrome = { i18n: { getUILanguage: () => 'ja' }, storage: { local: { get: async () => ({ state: raw }), set: async (data) => { raw = data.state; } } } };
  try {
    const { loadState, saveState } = await import('../src/lib/store.js');
    const state = await loadState();
    assert.equal(getLanguage(), 'en');
    assert.equal(state.sessions.sess_default.name, 'Default');
    state.settings.language = 'ja';
    await saveState(state);
    assert.equal(getLanguage(), 'ja');
    assert.equal(raw.settings.language, 'ja');
    raw.settings.language = 'auto';
    await loadState();
    assert.equal(getLanguage(), 'ja');
  } finally {
    if (previous === undefined) delete globalThis.chrome;
    else globalThis.chrome = previous;
  }
});
