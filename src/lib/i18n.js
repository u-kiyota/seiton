// 日本語・英語の表示文言と、ブラウザ言語・明示設定の解決を共有する。
const messages = {
  "一般": "General",
  "開発": "Development",
  "デフォルト": "Default",
  "セッション": "Session",
  "ワークスペース {number}": "Workspace {number}",
  "セッション {number}": "Session {number}",
  "未整理 {date}": "Unsorted {date}",
  "このウィンドウはワークスペースに割り当てられていません": "This window is not assigned to a workspace",
  "「{name}」にブックマークフォルダが接続されていません": "No bookmark folder is connected to “{name}”",
  "アクティブなタブがありません": "No active tab",
  "保存済みです": "Already saved",
  "ブックマークに保存しました": "Bookmark saved",
  "ワークスペースが見つかりません": "Workspace not found",
  "このワークスペースにはブックマークフォルダが接続されていません": "No bookmark folder is connected to this workspace",
  "このページはブックマークに保存できません": "This page cannot be bookmarked",
  "「{name}」の接続フォルダが見つかりません": "The connected folder for “{name}” was not found",
  "このページは置き場に登録できません": "This page cannot be added to the shelf",
  "除外する URL を入力してください": "Enter a URL to exclude",
  "Cookie を読み書きする権限が許可されていません": "Permission to read and write cookies has not been granted",
  "OffscreenCanvas が使えません": "OffscreenCanvas is unavailable",
  "OffscreenCanvas の 2d context が使えません": "OffscreenCanvas 2D context is unavailable",
  "休止グループが見つかりません": "Parked group not found",
  "blob が空です": "The blob is empty",
  "項目の上限が小さすぎます": "The item size limit is too small",
  "IndexedDB がブロックされています": "IndexedDB is blocked",
  "IndexedDB のトランザクションが中断されました": "The IndexedDB transaction was aborted",
  "暗号化された形式ではありません": "The data is not encrypted",
  "このブラウザでは chrome.storage.sync が使えません": "chrome.storage.sync is unavailable in this browser",
  "切り替え先のウィンドウが見つかりません": "The destination window was not found",
  "セッションが変わる切替では休止できません（Cookie を入れ替えるため、今のタブを残せません）": "Parking is unavailable when switching sessions because cookies must be replaced",
  "移動先のワークスペースが見つかりません": "The destination workspace was not found",
  "ローカルファイル（file://）のタブは移動できません。chrome://extensions で「ファイルの URL へのアクセスを許可する」を ON にすると扱えます": "Local file (file://) tabs cannot be moved. Enable “Allow access to file URLs” in chrome://extensions to use them",
  "選んだタブは既にそのワークスペースにあります": "The selected tabs are already in that workspace",
  "移動するタブがありません": "No tabs to move",
  "同じワークスペースです": "This is the same workspace",
  "開いているワークスペースのタブは、開いているタブの一覧から選んで移動してください": "Select tabs from the open tab list to move tabs from an open workspace",
  "移動するタブがありません（一覧が古くなっています）": "No tabs to move (the list is out of date)",
  "今日": "Today",
  "昨日": "Yesterday",
  "(名前なし)": "(Unnamed)",
  "seiton — 未割り当て（クイックパレット）": "seiton — Unassigned (Quick palette)",
  "seiton (クイックパレット)": "seiton (Quick palette)",
  "未知の形式: {format}": "Unknown format: {format}",
  "同期データが新しい版（v{version}）です。seiton を更新してください": "Sync data uses a newer version (v{version}). Update seiton",
  "設定・セッション・並び順が 1 項目の上限（{limit} バイト）を超えています（{bytes} バイト）。ワークスペースかセッションを減らしてください": "Settings, sessions and ordering exceed the per-item limit ({limit} bytes): {bytes} bytes. Reduce workspaces or sessions",
  "同期ストレージの容量（{limit} バイト）に収まりません（{bytes} バイト）": "Sync storage capacity ({limit} bytes) is exceeded ({bytes} bytes)",
  "{count} 個のタブを「{name}」のウィンドウへ移しました": "Moved {count} tabs to the window for “{name}”",
  "{count} 個のタブを「{name}」の休止グループへ移しました": "Moved {count} tabs to the parked group for “{name}”",
  "{count} 個のタブを「{name}」の保存タブに加えました": "Added {count} tabs to the saved tabs for “{name}”",
  "{message}（{count} 個は対象外）": "{message} ({count} excluded)"
};

let language = 'auto';

export function normalizeLanguage(value) {
  return value === 'ja' || value === 'en' ? value : 'auto';
}

function browserLanguage() {
  if (typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage) return chrome.i18n.getUILanguage();
  if (typeof window !== 'undefined' && typeof navigator !== 'undefined') return navigator.language;
  return 'ja';
}

export function resolveLanguage(value = 'auto', browser = browserLanguage()) {
  const selected = normalizeLanguage(value);
  if (selected !== 'auto') return selected;
  return /^ja(?:[-_]|$)/i.test(String(browser)) ? 'ja' : 'en';
}

export function setLanguage(value) { language = normalizeLanguage(value); return getLanguage(); }
export function getLanguage() { return resolveLanguage(language); }

// UI 専用辞書は UI 側から登録し、サービスワーカーには読み込まない。
export function registerMessages(entries) { Object.assign(messages, entries); }

export function t(key, params = {}) {
  const text = getLanguage() === 'en' && Object.hasOwn(messages, key) ? messages[key] : key;
  return String(text).replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name]) : match);
}

export function translateText(text, selected = getLanguage()) {
  return resolveLanguage(selected) === 'en' && Object.hasOwn(messages, text) ? messages[text] : text;
}
