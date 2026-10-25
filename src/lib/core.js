// chrome API に依存しない純粋ロジック。node --test でテストできるようにここへ集約する。

export const STATE_VERSION = 2;

export const DEFAULT_SETTINGS = {
  // 復元時、アクティブ以外のタブを即座に破棄（discard）して読み込みを遅延させる
  lazyRestore: true,
  // N 分以上アクティブになっていないタブを自動 discard（0 = 無効。基本は Chrome のメモリセーバーに任せる）
  autoDiscardMinutes: 0,
  // Ctrl+D 等で作成されたブックマークを、ワークスペースのフォルダへ自動移動する
  routeBookmarks: true,
  // ワークスペース用ブックマークフォルダを作る親フォルダ名
  bookmarkRootName: 'Workspaces',
};

export const COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

/** ワークスペースのアイコン候補（絵文字）をグループ分けしたもの。これ以外の絵文字も入力できる。未設定なら色のドットを表示 */
export const ICON_GROUPS = [
  { label: '一般', icons: ['💼', '🏠', '📚', '🎨', '💬', '📊', '🌐', '🛒', '🎮', '✈️', '🎵', '🧠', '⭐', '🔥'] },
  { label: '開発', icons: ['💻', '🖥️', '⌨️', '🚀', '🐛', '🔧', '🛠️', '⚙️', '🧪', '🗄️', '☁️', '🐳', '🔐', '📦', '🧰', '🌿', '🔀', '🤖', '📝', '📡'] },
];
export const ICONS = ICON_GROUPS.flatMap((g) => g.icons);

/** アイコンの入力値を正規化。空白を含むものや長すぎるものは未設定扱い（絵文字 1〜2 文字分を想定） */
export function normalizeIcon(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!s || /\s/.test(s) || s.length > 16) return '';
  return s;
}

export function uid(prefix = '') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export const DEFAULT_SESSION_ID = 'sess_default';

/**
 * 状態の形:
 * - sessions: ワークスペースが「どのログイン状態（アカウント）で使うか」を表すラベル。
 *   ワークスペース側が sessionId で参照する（ワークスペース N : セッション 1）。セッションはワークスペースを所有しない
 * - workspaceOrder: 全ワークスペースの表示順（セッションをまたいだ 1 本のリスト）
 */
export function defaultState() {
  return {
    version: STATE_VERSION,
    sessions: {
      [DEFAULT_SESSION_ID]: { id: DEFAULT_SESSION_ID, name: 'デフォルト', createdAt: Date.now() },
    },
    sessionOrder: [DEFAULT_SESSION_ID],
    workspaceOrder: [],
    workspaces: {},
    // 最後にフォーカスしていたワークスペース。再起動時に Chrome がタブを復元しなかった場合はこれを開く
    lastFocusedWorkspaceId: null,
    settings: { ...DEFAULT_SETTINGS },
  };
}

/** 保存データの欠損を補う（古いバージョンや手で壊れたデータへの防御）。v1（セッションが workspaceIds を持つ形）からの移行も行う */
export function normalizeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;
  const rawSessions = raw.sessions && typeof raw.sessions === 'object' && Object.keys(raw.sessions).length ? raw.sessions : base.sessions;
  const sessions = {};
  for (const [id, s] of Object.entries(rawSessions)) {
    if (!s || typeof s !== 'object') continue;
    sessions[id] = { id, name: (typeof s.name === 'string' && s.name.trim()) || 'セッション', createdAt: s.createdAt || Date.now() };
  }
  if (!Object.keys(sessions).length) sessions[DEFAULT_SESSION_ID] = base.sessions[DEFAULT_SESSION_ID];
  const state = {
    ...base,
    ...raw,
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
    sessions,
    workspaces: raw.workspaces && typeof raw.workspaces === 'object' ? raw.workspaces : {},
  };
  state.sessionOrder = (Array.isArray(raw.sessionOrder) ? raw.sessionOrder : []).filter((id) => sessions[id]);
  for (const id of Object.keys(sessions)) {
    if (!state.sessionOrder.includes(id)) state.sessionOrder.push(id);
  }
  for (const [id, ws] of Object.entries(state.workspaces)) {
    if (!ws || typeof ws !== 'object') { delete state.workspaces[id]; continue; }
    ws.id = id;
    if (!sessions[ws.sessionId]) ws.sessionId = state.sessionOrder[0];
    ws.tabs = Array.isArray(ws.tabs) ? ws.tabs : [];
    ws.groups = ws.groups || {};
    ws.icon = normalizeIcon(ws.icon);
  }
  // 並び順。v1 ではセッションごとの workspaceIds に持っていたので、セッション順に連結して引き継ぐ
  const legacyOrder = state.sessionOrder.flatMap((id) => (Array.isArray(rawSessions[id]?.workspaceIds) ? rawSessions[id].workspaceIds : []));
  const order = Array.isArray(raw.workspaceOrder) ? raw.workspaceOrder : legacyOrder;
  state.workspaceOrder = [];
  for (const id of [...order, ...Object.keys(state.workspaces)]) {
    if (state.workspaces[id] && !state.workspaceOrder.includes(id)) state.workspaceOrder.push(id);
  }
  if (state.lastFocusedWorkspaceId && !state.workspaces[state.lastFocusedWorkspaceId]) state.lastFocusedWorkspaceId = null;
  state.version = STATE_VERSION;
  return state;
}

/** セッションを使っているワークスペースを表示順で返す */
export function workspacesUsingSession(state, sessionId) {
  return state.workspaceOrder.filter((id) => state.workspaces[id]?.sessionId === sessionId);
}

export function tabUrl(tab) {
  return tab.url || tab.pendingUrl || '';
}

/** 管理パネルのページか（パネル用ポップアップウィンドウの判定や、タブ一覧・履歴からの除外に使う） */
export function isManagerUrl(url) {
  return typeof url === 'string'
    && url.startsWith('chrome-extension://')
    && /\/src\/ui\/sidepanel\.html(?:$|[?#])/.test(url);
}

/**
 * 管理パネル用ポップアップウィンドウの位置とサイズ。対象ウィンドウ（win: left/top/width/height）の
 * 約 ratio 倍の大きさで、その中央に重ねる。はみ出さないよう対象ウィンドウの範囲内にクランプする。
 * bounds が取れない場合は null（呼び出し側は位置・サイズを Chrome に任せる）
 */
export function managerPopupBounds(win, { ratio = 0.85, minWidth = 720, minHeight = 480 } = {}) {
  const { left, top, width, height } = win || {};
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  const size = (full, min) => Math.min(full, Math.max(Math.min(min, full), Math.round(full * ratio)));
  const w = size(width, minWidth);
  const h = size(height, minHeight);
  return {
    left: Math.round(left + (width - w) / 2),
    top: Math.round(top + (height - h) / 2),
    width: Math.round(w),
    height: Math.round(h),
  };
}

/** 保存・復元の対象にする URL か */
export function isRestorableUrl(url) {
  if (!url) return false;
  if (url.startsWith('chrome-extension://')) return false; // 自分自身の UI や他拡張のページ
  if (url.startsWith('devtools://')) return false;
  return true;
}

/** 空ワークスペース扱いにするタブ（新しいタブだけのウィンドウなど） */
export function isBlankUrl(url) {
  return !url || url === 'chrome://newtab/' || url === 'about:blank' || url === 'chrome://new-tab-page/';
}

/**
 * chrome.tabs.Tab[] と tabGroups を保存用スナップショットに変換する。
 * groupsById: { [groupId]: { title, color, collapsed } }
 */
export function snapshotTabs(tabs, groupsById = {}) {
  const sorted = [...tabs].sort((a, b) => a.index - b.index);
  const groups = {};
  const out = [];
  for (const t of sorted) {
    const url = tabUrl(t);
    if (!isRestorableUrl(url)) continue;
    let groupKey = null;
    if (t.groupId !== undefined && t.groupId !== -1 && groupsById[t.groupId]) {
      groupKey = 'g' + t.groupId;
      const g = groupsById[t.groupId];
      groups[groupKey] = { title: g.title || '', color: g.color || 'grey', collapsed: !!g.collapsed };
    }
    out.push({
      url,
      title: t.title || url,
      pinned: !!t.pinned,
      active: !!t.active,
      groupKey,
      favIconUrl: t.favIconUrl && !t.favIconUrl.startsWith('data:') ? t.favIconUrl : '',
    });
  }
  return { tabs: out, groups };
}

/** 比較用に URL を正規化（フラグメントと末尾スラッシュを無視） */
export function normalizeUrlForMatch(url) {
  if (!url) return '';
  let u = url.split('#')[0];
  if (u.endsWith('/')) u = u.slice(0, -1);
  return u;
}

/**
 * 保存 URL と現在 URL の重なり。hit = 一致数、score = hit / max(両者の件数)（0〜1）。
 * 空タブは数えない。片方が極端に多いケースで誤マッチしにくいよう大きい方で割る。
 */
export function overlapStats(savedUrls, currentUrls) {
  const meaningful = (urls) => urls.filter((u) => u && !isBlankUrl(u)).map(normalizeUrlForMatch);
  const saved = meaningful(savedUrls);
  const current = new Set(meaningful(currentUrls));
  if (!saved.length || !current.size) return { hit: 0, score: 0, savedCount: saved.length };
  const hit = saved.filter((u) => current.has(u)).length;
  return { hit, score: hit / Math.max(saved.length, current.size), savedCount: saved.length };
}

export function urlOverlap(savedUrls, currentUrls) {
  return overlapStats(savedUrls, currentUrls).score;
}

/**
 * 再起動時に、Chrome が復元したウィンドウとワークスペースを URL の重なりで対応付ける。
 * Gmail / Slack のような共通 URL 1 件だけで別ワークスペースに結び付けて上書きしないよう、
 * 「2 件以上一致（保存が 1 件だけなら完全一致）」かつ score >= threshold を条件にする。
 * windows: [{ windowId, urls }], candidates: [{ workspaceId, urls }]
 * 戻り値: { [windowId]: { workspaceId, score } }
 */
export function matchWindowsToWorkspaces(windows, candidates, threshold = 0.5) {
  const pairs = [];
  for (const w of windows) {
    for (const c of candidates) {
      const { hit, score, savedCount } = overlapStats(c.urls, w.urls);
      const enoughHits = hit >= 2 || (savedCount === 1 && hit === 1);
      if (enoughHits && score >= threshold) pairs.push({ windowId: w.windowId, workspaceId: c.workspaceId, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const result = {};
  const usedWs = new Set();
  for (const p of pairs) {
    if (result[p.windowId] !== undefined || usedWs.has(p.workspaceId)) continue;
    result[p.windowId] = { workspaceId: p.workspaceId, score: p.score };
    usedWs.add(p.workspaceId);
  }
  return result;
}

/**
 * 復元時に開くタブと、前面にして読み込むタブを1件だけ決める。
 * active 印が複数あっても最後の1件だけを前面にする。印が無ければ末尾。
 * 戻り値の activeIndex は tabs が空なら -1。
 */
export function planRestore(tabs) {
  const restorable = (tabs || []).filter((t) => isRestorableUrl(t.url));
  let activeIndex = -1;
  for (let i = 0; i < restorable.length; i++) {
    if (restorable[i].active) activeIndex = i;
  }
  if (activeIndex < 0 && restorable.length) activeIndex = restorable.length - 1;
  return { tabs: restorable, activeIndex };
}

/** saved のうち current に存在しない URL のタブだけを返す（再起動時の不足分補完用） */
export function missingTabs(savedTabs, currentUrls) {
  const current = new Set(currentUrls.map(normalizeUrlForMatch));
  return savedTabs.filter((t) => !current.has(normalizeUrlForMatch(t.url)));
}

/**
 * bookmarks.onCreated で作られたブックマークを、ワークスペースのフォルダへ移動すべきか判定する。
 * onCreated にはタブ・ウィンドウ情報が無いので「最後にフォーカスしたワークスペースのアクティブタブの URL と一致」を必須にする。
 */
export function shouldRouteBookmark({ node, enabled, importing, ownIds, targetFolderId, activeTabUrl }) {
  if (!enabled) return false;
  if (!node || !node.url) return false; // フォルダは対象外
  if (importing) return false;
  if (!targetFolderId) return false;
  if (ownIds && ownIds.has(node.id)) return false;
  if (node.parentId === targetFolderId) return false;
  if (!activeTabUrl) return false;
  return normalizeUrlForMatch(node.url) === normalizeUrlForMatch(activeTabUrl);
}

/** 一覧の中で前後のワークスペース ID を返す（端はループ） */
export function neighborWorkspace(workspaceIds, currentId, dir) {
  if (!workspaceIds.length) return null;
  const i = workspaceIds.indexOf(currentId);
  if (i === -1) return workspaceIds[0];
  return workspaceIds[(i + dir + workspaceIds.length) % workspaceIds.length];
}

/** 検索用の簡易あいまい一致（全語を含むか） */
export function matchesQuery(text, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return true;
  const t = (text || '').toLowerCase();
  return q.split(/\s+/).every((w) => t.includes(w));
}

// ---- 管理パネル: タブのドラッグ＆ドロップでブックマーク登録 ----

/** 管理パネル内でタブをドラッグする時の独自 MIME タイプ */
export const TAB_DRAG_TYPE = 'application/x-seiton-tab';

/** ブックマークとして保存できる URL か（chrome:// / about: / 拡張ページなどは除く） */
export function isBookmarkableUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'file:';
}

/** text/uri-list から最初の URL を取り出す（# で始まる行はコメント） */
export function firstUriFromList(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const s = line.trim();
    if (s && !s.startsWith('#')) return s;
  }
  return '';
}

/**
 * ドロップされた dataTransfer から { url, title } を取り出す。
 * getData: (type) => string（DataTransfer.getData 相当）。独自形式 → text/uri-list → text/plain の順に見る。
 * URL が取れなければ null。
 */
export function parseTabDragData(getData) {
  const get = (type) => {
    try {
      return getData(type) || '';
    } catch {
      return '';
    }
  };
  const raw = get(TAB_DRAG_TYPE);
  if (raw) {
    try {
      const v = JSON.parse(raw);
      if (v && typeof v.url === 'string' && v.url) {
        return { url: v.url, title: typeof v.title === 'string' && v.title ? v.title : v.url };
      }
    } catch { /* 壊れていれば他の形式を見る */ }
  }
  const url = firstUriFromList(get('text/uri-list')) || get('text/plain').trim();
  return url ? { url, title: url } : null;
}

/** ブックマーク一覧（{ url }[]）に同じ URL（フラグメント・末尾スラッシュ無視）があればそれを返す */
export function findBookmarkByUrl(items, url) {
  const want = normalizeUrlForMatch(url);
  if (!want) return null;
  return (items || []).find((it) => it?.url && normalizeUrlForMatch(it.url) === want) || null;
}
