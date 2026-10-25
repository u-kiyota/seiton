// 復元したタブが引き継ぐ「最終アクセス時刻」（タブの自動クローズ用、issue #5）。
// ワークスペースの切替はタブを閉じて開き直すため、作り直したタブの tab.lastAccessed は作成時刻になってしまう。
// そこで復元時に「保存されていた lastAccessed」と「復元した時刻」を storage.session に覚えておき、
// 復元後に一度も前面になっていないタブは保存時の値で判定・保存する（core.js の effectiveLastAccessed）。
// storage.session はブラウザ（または拡張）の再起動で消える。

const KEY = 'inheritedAccess'; // { [tabId]: { saved, restoredAt } }
let chain = Promise.resolve();

/** read-modify-write を直列にする（onRemoved / onActivated は serialize() の外から呼ばれるため） */
function update(fn) {
  const run = chain.then(async () => {
    const { [KEY]: map = {} } = await chrome.storage.session.get(KEY);
    if (fn(map) === false) return;
    await chrome.storage.session.set({ [KEY]: map });
  });
  chain = run.catch((e) => console.warn('[seiton] inheritedAccess', e));
  return run;
}

/** 復元したタブに、保存されていた最終アクセス時刻を引き継がせる */
export function rememberInheritedAccess(tabId, saved, restoredAt = Date.now()) {
  if (tabId == null || !Number.isFinite(saved)) return Promise.resolve();
  return update((map) => { map[tabId] = { saved, restoredAt }; });
}

export async function getInheritedAccess() {
  await chain.catch(() => {});
  const { [KEY]: map = {} } = await chrome.storage.session.get(KEY);
  return map;
}

/** タブを閉じたときに忘れる（前面にした後は effectiveLastAccessed が tab.lastAccessed を使うので残っていてよい） */
export function forgetInheritedAccess(tabId) {
  return update((map) => {
    if (!(tabId in map)) return false;
    delete map[tabId];
    return true;
  });
}
