// ワークスペースタブ: ワークスペースに割り当てられた通常ウィンドウの左端（固定タブの直後）に拡張ページ
// src/ui/wstab.html のタブを 1 枚置き、そのタブだけを色付きのタブグループ（タイトル = 「絵文字 名前」、色 = ワークスペースの色）
// に入れて折りたたむ。タブ列の左端に色付きのラベルだけが常に見えるので、今のワークスペースがぱっと分かる。
//
// - ensure / remove は状態を読むだけで state / bindings は書き換えないが、タブを作る・閉じるので切替処理と競合しないよう
//   必ず serialize() の中で実行する（scheduleWorkspaceTab / scheduleAllWorkspaceTabs が直列キューに積む）。
//   ここの関数は serialize を呼ばない（serialize の中から直接呼んでもデッドロックしない）。
// - 冪等: 何度呼んでも、あるべき状態と違うところだけを直す。自分の操作で起きたタブ / グループのイベントで再実行されても、
//   2 回目は「変化なし」で何もしない（無限ループ防止）。
// - 対応先（ワークスペース / 未割り当て）と設定は、イベントの差分ではなく実行時点の bindings / settings で決める
//   （reconcileWindows は一度 bindings を空にしてから作り直すため、差分で動くと全部閉じてしまう）。
import {
  WORKSPACE_TAB_PAGE, isWorkspaceTabUrl, tabUrl, workspaceTabGroupProps, workspaceTabIndex, pickWorkspaceTab,
  isOwnWorkspaceGroup, workspaceGroupPatch,
} from './core.js';
import { serialize, loadState, getBindings } from './store.js';

const DEBOUNCE_MS = 250;

/** windowId → 前回ワークスペースタブを入れたグループ ID（ワークスペースタブが別ページへ遷移した後の後片付け用。SW 再起動で消えてよい） */
const knownGroups = new Map();
const timers = new Map();
const pendingPrune = new Set();
let allTimer = 0;
let allPrune = false;

const hasTabGroups = () => typeof chrome.tabGroups?.update === 'function' && typeof chrome.tabs.group === 'function';

async function queryTabs(windowId) {
  try {
    return await chrome.tabs.query({ windowId });
  } catch {
    return null; // ウィンドウが既に閉じられた
  }
}

async function normalWindow(windowId) {
  try {
    const w = await chrome.windows.get(windowId);
    return w.type === 'normal' && !w.incognito;
  } catch {
    return false;
  }
}

const isWsTab = (t) => isWorkspaceTabUrl(tabUrl(t));

// ユーザーがタブをドラッグしている間、Chrome はタブの移動・グループ化・削除を
// 「Tabs cannot be edited right now (user may be dragging a tab)」で拒否する。
// 失敗は握りつぶすが、その場合はドロップ後に少し待ってやり直す（回数に上限を付けてループさせない）
const DRAG_RETRY_MS = 500;
const MAX_DRAG_RETRIES = 10;
const dragRetries = new Map();
let blockedByDrag = false;

function soft(e) {
  if (/dragging|cannot be edited/i.test(String(e?.message ?? e))) blockedByDrag = true;
}

/**
 * ウィンドウのワークスペースタブを閉じる。ただしウィンドウに残っているのがワークスペースタブだけなら
 * 1 枚は閉じずに残す（閉じるとウィンドウごと閉じてしまうため）。残したタブはグループから外す（古い色ラベルを残さない）。
 * ページ側は「未割り当て」表示になる。
 */
export async function removeWorkspaceTab(windowId) {
  const tabs = await queryTabs(windowId);
  if (!tabs) return;
  knownGroups.delete(windowId);
  const wsTabs = tabs.filter(isWsTab);
  if (!wsTabs.length) return;
  const onlyWs = wsTabs.length === tabs.length;
  const { keep, close } = pickWorkspaceTab(tabs);
  const toClose = onlyWs ? close : wsTabs;
  if (toClose.length) await chrome.tabs.remove(toClose.map((t) => t.id)).catch(soft);
  if (onlyWs && keep && keep.groupId !== undefined && keep.groupId !== -1) {
    await chrome.tabs.ungroup(keep.id).catch(soft);
  }
}

/** 割り当て済みウィンドウにワークスペースタブを 1 枚だけ、正しい位置・グループで置く */
async function applyWorkspaceTab(windowId, ws) {
  let tabs = await queryTabs(windowId);
  if (!tabs) return;
  const props = workspaceTabGroupProps(ws);
  let { keep, close } = pickWorkspaceTab(tabs);
  let changed = false;
  if (close.length) {
    await chrome.tabs.remove(close.map((t) => t.id)).catch(soft);
    changed = true;
  }
  if (!keep) {
    try {
      keep = await chrome.tabs.create({
        windowId, url: chrome.runtime.getURL(WORKSPACE_TAB_PAGE), index: workspaceTabIndex(tabs), active: false,
      });
    } catch (e) {
      soft(e);
      console.warn('[wstab] ワークスペースタブを作れません', e);
      return;
    }
    changed = true;
  } else if (keep.pinned) {
    // 固定タブはグループに入れられないので固定を外す
    await chrome.tabs.update(keep.id, { pinned: false }).catch(soft);
    changed = true;
  }
  if (changed) {
    tabs = await queryTabs(windowId);
    keep = tabs?.find((t) => t.id === keep.id);
    if (!keep) return;
  }

  let groupId = -1;
  if (hasTabGroups()) {
    groupId = keep.groupId ?? -1;
    let group = null;
    let fresh = false;
    if (groupId !== -1) {
      group = await chrome.tabGroups.get(groupId).catch(() => null);
      const members = tabs.filter((t) => t.groupId === groupId);
      if (group && !isOwnWorkspaceGroup({
        group, members, wsTabId: keep.id, knownGroupId: knownGroups.get(windowId), expectedTitle: props.title,
      })) {
        groupId = -1; // ユーザーのグループに入れられた → 自分だけの新しいグループに入れ直す
      } else if (group) {
        // 自分のグループに紛れ込んだ他のタブは外す（保存時に「💼 名前」のグループとして記録されないように）
        const others = members.filter((t) => t.id !== keep.id);
        if (others.length) await chrome.tabs.ungroup(others.map((t) => t.id)).catch(soft);
      }
      // group が取れない（API の一時的な失敗）ときは作り直さない（作り直し → groupId 変化 → 再実行のループを避ける）
    }
    // 以前のグループに、別ページへ遷移した元ワークスペースタブなどが残っていれば外す
    const known = knownGroups.get(windowId);
    if (known != null && known !== groupId) {
      const stray = tabs.filter((t) => t.groupId === known && t.id !== keep.id);
      if (stray.length) await chrome.tabs.ungroup(stray.map((t) => t.id)).catch(soft);
    }
    if (groupId === -1) {
      try {
        groupId = await chrome.tabs.group({ tabIds: [keep.id], createProperties: { windowId } });
        group = null;
        fresh = true;
      } catch (e) {
        soft(e);
        console.warn('[wstab] グループにできません（グループ無しのワークスペースタブで続行）', e);
        groupId = -1;
      }
    }
    if (groupId !== -1) {
      knownGroups.set(windowId, groupId);
      // 折りたたむのはグループを作ったとき・ワークスペースが変わった（タイトルが変わる）ときだけ。
      // ユーザーがラベルをクリックして開いたのを閉じ直さない（開かないとページにたどり着けないため）。
      // アクティブなタブを含むグループは Chrome が折りたためないので、ワークスペースタブが前面のときは折りたたまない
      const retitled = !group || (group.title ?? '') !== props.title;
      const patch = workspaceGroupPatch(group, props, { collapse: (fresh || retitled) && !keep.active });
      if (patch) {
        try {
          await chrome.tabGroups.update(groupId, patch);
        } catch (e) {
          soft(e);
          console.warn('[wstab] グループを更新できません', e);
        }
      }
    }
  }

  // 位置: 固定タブの直後（固定タブが無ければ左端）
  let cur;
  try {
    cur = await chrome.tabs.get(keep.id);
    tabs = await chrome.tabs.query({ windowId });
  } catch {
    return;
  }
  const target = workspaceTabIndex(tabs);
  if (cur.index === target) return;
  try {
    // グループに入ったタブを tabs.move で動かすとグループから外れることがあるので、グループごと動かす
    if (groupId !== -1 && cur.groupId === groupId) await chrome.tabGroups.move(groupId, { index: target });
    else await chrome.tabs.move(keep.id, { index: target });
  } catch (e) {
    soft(e);
    console.warn('[wstab] ワークスペースタブを移動できません', e);
  }
}

/**
 * ウィンドウのワークスペースタブを、今の割り当て・設定に合わせる。
 * - 設定 OFF: 閉じる（最後のタブなら残す）
 * - 割り当て済み: 1 枚だけ置いてグループのタイトル・色・位置を直す
 * - 未割り当て: prune のときだけ閉じる（起動直後の対応付け前に、Chrome が復元したワークスペースタブを閉じないため）
 * serialize() の中で呼ぶこと
 */
export async function ensureWorkspaceTab(windowId, { prune = false } = {}) {
  blockedByDrag = false;
  await ensureOnce(windowId, prune);
  if (!blockedByDrag) {
    dragRetries.delete(windowId);
    return;
  }
  const n = (dragRetries.get(windowId) || 0) + 1;
  if (n > MAX_DRAG_RETRIES) {
    dragRetries.delete(windowId); // 諦める（次のタブイベントで改めて点検される）
    return;
  }
  dragRetries.set(windowId, n);
  scheduleWorkspaceTab(windowId, { prune, delay: DRAG_RETRY_MS });
}

async function ensureOnce(windowId, prune) {
  if (!(await normalWindow(windowId))) return;
  const [state, bindings] = await Promise.all([loadState(), getBindings()]);
  if (!state.settings.workspaceTab) {
    await removeWorkspaceTab(windowId);
    return;
  }
  const ws = state.workspaces[bindings[windowId]];
  if (!ws) {
    if (prune) await removeWorkspaceTab(windowId);
    return;
  }
  await applyWorkspaceTab(windowId, ws);
}

/** 全通常ウィンドウに ensureWorkspaceTab を適用する。serialize() の中で呼ぶこと */
export async function ensureAllWorkspaceTabs({ prune = false } = {}) {
  let wins = [];
  try {
    wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
  } catch {
    return;
  }
  for (const w of wins) {
    if (w.incognito) continue;
    try {
      await ensureWorkspaceTab(w.id, { prune });
    } catch (e) {
      console.warn('[wstab] ensure failed', w.id, e);
    }
  }
}

/** ウィンドウ単位でデバウンスして直列キューに積む。prune は 1 回でも要求されたら次の実行で有効 */
export function scheduleWorkspaceTab(windowId, { prune = false, delay = DEBOUNCE_MS } = {}) {
  if (!Number.isFinite(windowId) || windowId === chrome.windows.WINDOW_ID_NONE) return;
  if (prune) pendingPrune.add(windowId);
  clearTimeout(timers.get(windowId));
  timers.set(windowId, setTimeout(() => {
    timers.delete(windowId);
    const p = pendingPrune.delete(windowId);
    serialize(() => ensureWorkspaceTab(windowId, { prune: p })).catch((e) => console.warn('[wstab] ensure failed', e));
  }, delay));
}

/** 全ウィンドウ分をデバウンスして直列キューに積む */
export function scheduleAllWorkspaceTabs({ prune = false } = {}) {
  if (prune) allPrune = true;
  clearTimeout(allTimer);
  allTimer = setTimeout(() => {
    const p = allPrune;
    allPrune = false;
    serialize(() => ensureAllWorkspaceTabs({ prune: p })).catch((e) => console.warn('[wstab] ensure all failed', e));
  }, DEBOUNCE_MS);
}

/** ウィンドウが閉じられたときの後片付け */
export function forgetWorkspaceTabWindow(windowId) {
  knownGroups.delete(windowId);
  dragRetries.delete(windowId);
  clearTimeout(timers.get(windowId));
  timers.delete(windowId);
  pendingPrune.delete(windowId);
}
