// ワークスペースとブックマークフォルダの接続。
import { normalizeUrlForMatch } from './core.js';

// 自分で作成したブックマーク ID（onCreated での自動移動対象から外す）
export const ownCreatedIds = new Set();
let importing = false;

export function setImporting(v) {
  importing = v;
}
export function isImporting() {
  return importing;
}

/** 「その他のブックマーク」フォルダ ID を取得 */
async function otherBookmarksId() {
  const [root] = await chrome.bookmarks.getTree();
  const folders = root.children || [];
  // 通常 [0] がブックマークバー、[1] がその他のブックマーク
  return (folders[1] || folders[0]).id;
}

/** ワークスペース用の親フォルダ（既定名 "Workspaces"）を取得、無ければ作る */
export async function ensureRootFolder(settings) {
  const parentId = await otherBookmarksId();
  const name = settings.bookmarkRootName || 'Workspaces';
  const children = await chrome.bookmarks.getChildren(parentId);
  const found = children.find((c) => !c.url && c.title === name);
  if (found) return found.id;
  const created = await chrome.bookmarks.create({ parentId, title: name });
  ownCreatedIds.add(created.id);
  return created.id;
}

export async function createFolderForWorkspace(name, settings) {
  const rootId = await ensureRootFolder(settings);
  const folder = await chrome.bookmarks.create({ parentId: rootId, title: name });
  ownCreatedIds.add(folder.id);
  return folder.id;
}

export async function renameManagedFolder(folderId, name) {
  try {
    await chrome.bookmarks.update(folderId, { title: name });
  } catch { /* 既に削除されている */ }
}

/** 接続先に選べるフォルダ一覧（パス付き、フラット） */
export async function listAllFolders() {
  const [root] = await chrome.bookmarks.getTree();
  const out = [];
  const walk = (node, path) => {
    for (const c of node.children || []) {
      if (c.url) continue;
      const p = path ? `${path} / ${c.title}` : c.title;
      out.push({ id: c.id, path: p });
      walk(c, p);
    }
  };
  walk(root, '');
  return out;
}

/** フォルダ配下のブックマークを再帰的に取得（サブフォルダはパス付きで平坦化） */
export async function listFolderBookmarks(folderId) {
  let sub;
  try {
    [sub] = await chrome.bookmarks.getSubTree(folderId);
  } catch {
    return null; // フォルダが存在しない
  }
  const out = [];
  const walk = (node, path) => {
    for (const c of node.children || []) {
      if (c.url) out.push({ id: c.id, title: c.title || c.url, url: c.url, path });
      else walk(c, path ? `${path} / ${c.title}` : c.title);
    }
  };
  walk(sub, '');
  return { title: sub.title, items: out };
}

/** タブをフォルダに保存。同じ URL が既にあれば作らない */
export async function saveToFolder(folderId, { url, title }) {
  const children = await chrome.bookmarks.getChildren(folderId);
  const dup = children.find((c) => c.url && normalizeUrlForMatch(c.url) === normalizeUrlForMatch(url));
  if (dup) return { bookmarkId: dup.id, duplicated: true };
  const node = await chrome.bookmarks.create({ parentId: folderId, title: title || url, url });
  ownCreatedIds.add(node.id);
  return { bookmarkId: node.id, duplicated: false };
}

/** 削除されたノード（とその子孫）の ID 一覧 */
export function collectIds(node) {
  const ids = [node.id];
  for (const c of node.children || []) ids.push(...collectIds(c));
  return ids;
}
