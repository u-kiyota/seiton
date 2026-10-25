// 管理パネルを、今のウィンドウのタブとして開く（同じウィンドウに既にあればそれを前面にする）。

const PAGE = 'src/ui/sidepanel.html';

export async function openManager(windowId) {
  if (windowId == null) {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    windowId = win.id;
  }
  const url = chrome.runtime.getURL(PAGE);
  const existing = (await chrome.tabs.query({ url })).find((t) => t.windowId === windowId);
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(windowId, { focused: true });
    return existing.id;
  }
  const tab = await chrome.tabs.create({ windowId, url, active: true });
  return tab.id;
}
