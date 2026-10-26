// タブの自動クローズ（issue #5）。
// 最後に使ってから N 日以上経ったタブを chrome.alarms で定期的に閉じる。
// 判定は core.js の tabsToAutoClose / effectiveAutoClose（純粋関数）に任せ、ここでは chrome API の呼び出しだけを行う。
// settings.autoCloseExclude（除外 URL のパターン。issue #20）に当てはまるタブは閉じない。
// 閉じたタブは通常の tabs.onRemoved → スナップショットでワークスペースの保存内容からも外れる。
// 閉じたタブは history.js の履歴（storage.local の closedTabs）にも残す（issue #18）。
import { effectiveAutoClose, isAutoCloseActive, tabsToAutoClose, closedTabEntry } from './core.js';
import { addClosedTabs } from './history.js';
import { getBindings } from './store.js';
import { getInheritedAccess } from './access.js';
import { isSwitching } from './workspace.js';

export const AUTO_CLOSE_ALARM = 'auto-close';
const PERIOD_MINUTES = 15;

/** グローバル設定かいずれかのワークスペースの上書きが ON のときだけアラームを張る（clear → create で冪等） */
export async function configureAutoClose(state) {
  await chrome.alarms.clear(AUTO_CLOSE_ALARM);
  if (isAutoCloseActive(state)) {
    // 有効化した直後にも一度確認できるよう、初回は 1 分後
    await chrome.alarms.create(AUTO_CLOSE_ALARM, { delayInMinutes: 1, periodInMinutes: PERIOD_MINUTES });
  }
}

/** 通常ウィンドウごとに、割り当てられたワークスペースの設定（未割り当てはグローバル設定）で古いタブを閉じる */
export async function runAutoClose(state, now = Date.now()) {
  if (!isAutoCloseActive(state)) {
    await chrome.alarms.clear(AUTO_CLOSE_ALARM);
    return 0;
  }
  const bindings = await getBindings();
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'], populate: true });
  // 切替で作り直したタブは、保存時の最終アクセス時刻を引き継いで判定する
  const inherited = await getInheritedAccess();
  let count = 0;
  for (const win of windows) {
    // 切替中のウィンドウはタブを閉じて開き直している最中なので触らない
    if (isSwitching(win.id)) continue;
    const ws = state.workspaces[bindings[win.id]] || null;
    const { enabled, days } = effectiveAutoClose(state.settings, ws);
    if (!enabled) continue;
    const targets = tabsToAutoClose(win.tabs || [], { now, days, inherited, exclude: state.settings.autoCloseExclude });
    if (!targets.length) continue;
    // 閉じる直前に履歴へ記録する（管理パネルの「閉じたタブ」から開き直せるように）。
    // 記録に失敗しても自動クローズ自体は止めない
    try {
      await addClosedTabs(targets.map((tab) => closedTabEntry(tab, ws, now)));
    } catch (e) {
      console.warn('[seiton] 閉じたタブの履歴を記録できませんでした', e);
    }
    for (const tab of targets) {
      try {
        await chrome.tabs.remove(tab.id);
        count++;
      } catch { /* 既に閉じられた */ }
    }
  }
  if (count) console.info(`[seiton] 自動クローズ: ${count} 件のタブを閉じました`);
  return count;
}
