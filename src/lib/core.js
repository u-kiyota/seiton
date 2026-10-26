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
  // 最後に使ってから days 日以上経ったタブを自動で閉じる（既定 OFF。ワークスペースごとに ws.autoClose で上書き可。凍結: 必ず新しいオブジェクトで置き換える）
  autoClose: Object.freeze({ enabled: false, days: 7 }),
  // 自動クローズの対象外にする URL のパターン（issue #20。書き方は autoCloseExcludeMatch 付近を参照）。凍結: 必ず新しい配列で置き換える
  autoCloseExclude: Object.freeze([]),
  // ウィンドウの左端に、今のワークスペースを示す専用タブ（色付きのタブグループ）を置く
  workspaceTab: true,
  // セッションごとに Cookie（ログイン状態）を分ける（issue #12）。切替時に Cookie を退避 / 復元する。
  // 任意権限（cookies + <all_urls>）が必要なので、設定画面の setCookieIsolation 経由でだけ ON にする（updateSettings では変えない）
  cookieIsolation: false,
};

export const COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

/** ワークスペース色名 → hex（UI のドット・アイコン背景と、ツールバーアイコンの描画で共用） */
export const COLOR_HEX = {
  grey: '#5f6368', blue: '#1a73e8', red: '#d93025', yellow: '#f9ab00', green: '#188038',
  pink: '#d01884', purple: '#a142f4', cyan: '#007b83', orange: '#fa903e',
};

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
  state.settings.autoClose = normalizeAutoClose(state.settings.autoClose);
  state.settings.autoCloseExclude = normalizeExcludePatterns(state.settings.autoCloseExclude);
  state.settings.cookieIsolation = state.settings.cookieIsolation === true;
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
    ws.autoClose = normalizeAutoCloseOverride(ws.autoClose, state.settings.autoClose);
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

/** ワークスペースタブ（ウィンドウ左端に置く、今のワークスペースを示す拡張ページ）の拡張内パス */
export const WORKSPACE_TAB_PAGE = 'src/ui/wstab.html';

/** ワークスペースタブのページか（タブ一覧・保存・照合からの除外、切替時に閉じないタブの判定に使う） */
export function isWorkspaceTabUrl(url) {
  return typeof url === 'string'
    && url.startsWith('chrome-extension://')
    && /\/src\/ui\/wstab\.html(?:$|[?#])/.test(url);
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
 * inherited: { [tabId]: { saved, restoredAt } }（復元したタブが引き継ぐ最終アクセス時刻。effectiveLastAccessed 参照）
 */
export function snapshotTabs(tabs, groupsById = {}, inherited = {}) {
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
    const entry = {
      url,
      title: t.title || url,
      pinned: !!t.pinned,
      active: !!t.active,
      groupKey,
      favIconUrl: t.favIconUrl && !t.favIconUrl.startsWith('data:') ? t.favIconUrl : '',
    };
    // タブの自動クローズ用。開き直しても保存時の最終アクセス時刻を引き継げるように保存する
    const lastAccessed = effectiveLastAccessed(t, inherited?.[t.id]);
    if (lastAccessed !== null) entry.lastAccessed = lastAccessed;
    out.push(entry);
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

// ---- ツールバー（action）のアイコン / タイトルで今のワークスペースを示す ----

export const INDICATOR_TITLE_PREFIX = 'seiton — ';
export const UNASSIGNED_INDICATOR_TITLE = `${INDICATOR_TITLE_PREFIX}未割り当て（クイックパレット）`;

/** 文字列の先頭 1 文字（書記素）。サロゲートペアや結合文字を壊さないよう Intl.Segmenter があればそれを使う */
export function firstGrapheme(str) {
  const s = typeof str === 'string' ? str.trim() : '';
  if (!s) return '';
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const first = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)[Symbol.iterator]().next();
    if (!first.done) return first.value.segment;
  }
  return Array.from(s)[0];
}

/**
 * ツールバーアイコンに描く内容とホバーのタイトル。
 * ws が無い（未割り当て）なら { text: '', emoji: false, color: null, title: 未割り当て } を返し、呼び出し側は既定アイコンに戻す。
 * text は絵文字アイコン（emoji: true）、無ければ名前の先頭 1 文字（名前が空なら '?'）
 */
export function indicatorLabel(ws, sessionName) {
  if (!ws) return { text: '', emoji: false, color: null, title: UNASSIGNED_INDICATOR_TITLE };
  const name = typeof ws.name === 'string' ? ws.name.trim() : '';
  const icon = normalizeIcon(ws.icon);
  const session = typeof sessionName === 'string' ? sessionName.trim() : '';
  return {
    text: icon || firstGrapheme(name) || '?',
    emoji: !!icon,
    color: COLOR_HEX[ws.color] || COLOR_HEX.grey,
    title: `${INDICATOR_TITLE_PREFIX}${name || '(名前なし)'}${session ? `（${session}）` : ''}`,
  };
}

/** bindings（windowId → workspaceId）の新旧で、対応先が変わった windowId（数値）を返す */
export function changedBindingWindows(oldBindings, newBindings) {
  const a = oldBindings && typeof oldBindings === 'object' ? oldBindings : {};
  const b = newBindings && typeof newBindings === 'object' ? newBindings : {};
  const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...ids].filter((k) => (a[k] || null) !== (b[k] || null)).map(Number).filter(Number.isFinite);
}

/**
 * 保存状態のうちツールバー表示に関わる部分（ワークスペースの名前・色・アイコン・セッション、セッション名）だけの署名。
 * state はタブの変化のたびに保存されるので、これが変わったときだけ全ウィンドウを再描画する
 */
export function indicatorSignature(rawState) {
  const st = rawState && typeof rawState === 'object' ? rawState : {};
  const workspaces = st.workspaces && typeof st.workspaces === 'object' ? st.workspaces : {};
  const sessions = st.sessions && typeof st.sessions === 'object' ? st.sessions : {};
  const ws = Object.keys(workspaces).sort().map((id) => {
    const w = workspaces[id] || {};
    return [id, w.name ?? '', w.color ?? '', w.icon ?? '', w.sessionId ?? ''];
  });
  const ss = Object.keys(sessions).sort().map((id) => [id, sessions[id]?.name ?? '']);
  return JSON.stringify([ws, ss]);
}

// ---- ワークスペースタブ（ウィンドウ左端の専用タブ＋色付きタブグループ） ----

/** 保存状態の settings.workspaceTab（未設定なら既定値）。storage.onChanged の新旧比較用 */
export function workspaceTabEnabled(rawState) {
  const v = rawState?.settings?.workspaceTab;
  return typeof v === 'boolean' ? v : DEFAULT_SETTINGS.workspaceTab;
}

/** ワークスペースタブのグループのタイトルと色。タイトルは「絵文字 名前」（絵文字が無ければ名前のみ）、色は tabGroups の色名（不明なら grey） */
export function workspaceTabGroupProps(ws) {
  const name = typeof ws?.name === 'string' ? ws.name.trim() : '';
  const icon = normalizeIcon(ws?.icon);
  return {
    title: [icon, name].filter(Boolean).join(' '),
    color: COLORS.includes(ws?.color) ? ws.color : 'grey',
  };
}

/** ワークスペースタブを置くべき index（固定タブの直後 = 固定タブの数。固定タブはグループに入れられないため） */
export function workspaceTabIndex(tabs) {
  return (tabs || []).filter((t) => t && t.pinned).length;
}

/**
 * ウィンドウのタブからワークスペースタブを探し、残す 1 枚と閉じる残りを決める。
 * 残すのはグループに入っているもの → index が小さいもの の順（決定的にするため）。
 * 戻り値: { keep: Tab | null, close: Tab[] }
 */
export function pickWorkspaceTab(tabs) {
  const cands = (tabs || []).filter((t) => t && isWorkspaceTabUrl(tabUrl(t)));
  if (!cands.length) return { keep: null, close: [] };
  const ungrouped = (t) => (t.groupId !== undefined && t.groupId !== -1 ? 0 : 1);
  const sorted = [...cands].sort((a, b) => ungrouped(a) - ungrouped(b) || (a.index ?? 0) - (b.index ?? 0));
  return { keep: sorted[0], close: sorted.slice(1) };
}

/**
 * ワークスペースタブが入っているグループを「自分のもの」として扱うか。
 * ワークスペースタブだけのグループ、前回このウィンドウで使ったグループ（knownGroupId）、
 * 期待するタイトルのグループなら自分のもの（他のタブが紛れ込んだだけ）。それ以外はユーザーのグループに入れられたとみなす。
 * members: そのグループに属するタブ
 */
export function isOwnWorkspaceGroup({ group, members, wsTabId, knownGroupId, expectedTitle }) {
  if (!group) return false;
  const others = (members || []).filter((t) => t.id !== wsTabId);
  if (!others.length) return true;
  if (knownGroupId != null && group.id === knownGroupId) return true;
  return typeof expectedTitle === 'string' && expectedTitle !== '' && group.title === expectedTitle;
}

/**
 * ワークスペースタブのグループで、変える必要のあるプロパティだけを返す（変化が無ければ null。自分の更新イベントで無限ループしないため）。
 * collapse: true なら折りたたむ（グループを作ったとき・ワークスペースが変わったときだけ。ユーザーが開いたのを毎回閉じ直さない）
 */
export function workspaceGroupPatch(group, props, { collapse = false } = {}) {
  const patch = {};
  if ((group?.title ?? '') !== props.title) patch.title = props.title;
  if (group?.color !== props.color) patch.color = props.color;
  if (collapse && !group?.collapsed) patch.collapsed = true;
  return Object.keys(patch).length ? patch : null;
}

// ---- 管理パネル: 番号キーで切替 ----

/** 並び順の index（0 始まり）に対応する番号キー: 0〜8 → '1'〜'9'、9 → '0'、それ以外は null */
export function workspaceHotkey(index) {
  if (!Number.isInteger(index) || index < 0 || index > 9) return null;
  return String((index + 1) % 10);
}

/** 番号キー（'0'〜'9'）→ 並び順の index（0〜9）。数字 1 文字以外は null */
export function hotkeyToIndex(key) {
  if (typeof key !== 'string' || !/^[0-9]$/.test(key)) return null;
  return (Number(key) + 9) % 10;
}

// ---- タブの自動クローズ ----

/** 自動クローズまでの日数の下限（動作確認用に小数も受け付ける。0.01 日 ≒ 14.4 分） */
export const AUTO_CLOSE_MIN_DAYS = 0.01;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 日数として有効なら数値、無効（NaN・負・下限未満・数値でない）なら null */
export function parseAutoCloseDays(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= AUTO_CLOSE_MIN_DAYS ? n : null;
}

/** 期間の単位 → 日数への係数（UI の「分 / 時間 / 日」入力用。内部は常に日数で持つ） */
export const AUTO_CLOSE_UNITS = { minutes: 1 / (24 * 60), hours: 1 / 24, days: 1 };
export const AUTO_CLOSE_UNIT_LABELS = { minutes: '分', hours: '時間', days: '日' };

/** 値と単位（minutes / hours / days）→ 日数。無効（単位不明・NaN・下限未満）なら null */
export function autoCloseDaysFrom(value, unit) {
  const f = AUTO_CLOSE_UNITS[unit];
  if (!f || value === '' || value === null || value === undefined) return null;
  return parseAutoCloseDays(Number(value) * f);
}

/** 日数 → 表示用の { value, unit }。割り切れる最も大きい単位（日 → 時間 → 分）で表す */
export function autoCloseDuration(days) {
  const d = parseAutoCloseDays(days) ?? DEFAULT_SETTINGS.autoClose.days;
  const whole = (x) => Math.abs(x - Math.round(x)) < 1e-6;
  if (whole(d)) return { value: Math.round(d), unit: 'days' };
  if (whole(d * 24)) return { value: Math.round(d * 24), unit: 'hours' };
  return { value: Math.round(d * 24 * 60), unit: 'minutes' };
}

/** 日数 → 「3 日」「12 時間」「30 分」 */
export function formatAutoCloseDuration(days) {
  const { value, unit } = autoCloseDuration(days);
  return `${value} ${AUTO_CLOSE_UNIT_LABELS[unit]}`;
}

/** { enabled, days } に正規化した新しいオブジェクトを返す。不正な項目は fallback の値を使う */
export function normalizeAutoClose(v, fallback = DEFAULT_SETTINGS.autoClose) {
  const fb = {
    enabled: typeof fallback?.enabled === 'boolean' ? fallback.enabled : DEFAULT_SETTINGS.autoClose.enabled,
    days: parseAutoCloseDays(fallback?.days) ?? DEFAULT_SETTINGS.autoClose.days,
  };
  if (!v || typeof v !== 'object') return fb;
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : fb.enabled,
    days: parseAutoCloseDays(v.days) ?? fb.days,
  };
}

/** ワークスペースごとの上書き。null（= グローバル設定に従う）か { enabled, days } */
export function normalizeAutoCloseOverride(v, fallback = DEFAULT_SETTINGS.autoClose) {
  if (!v || typeof v !== 'object') return null;
  return normalizeAutoClose({ enabled: !!v.enabled, days: v.days }, fallback);
}

/** ワークスペース（未割り当てなら null）に実際に適用される自動クローズ設定 */
export function effectiveAutoClose(settings, ws) {
  const global = normalizeAutoClose(settings?.autoClose);
  const override = normalizeAutoCloseOverride(ws?.autoClose, global);
  return override || global;
}

/** グローバル設定かいずれかのワークスペースの上書きが ON なら、アラームを張る必要がある */
export function isAutoCloseActive(state) {
  if (normalizeAutoClose(state?.settings?.autoClose).enabled) return true;
  return Object.values(state?.workspaces || {}).some((ws) => ws?.autoClose?.enabled === true);
}

/** 復元直後とみなす猶予。作成時の lastAccessed はこれ以内に収まる */
const RESTORE_GRACE_MS = 1000;

/**
 * 自動クローズの判定・保存に使う「最終アクセス時刻」（無ければ null）。
 * 切替で作り直したタブの tab.lastAccessed は作成時刻なので、復元後に一度も前面になっていない
 * （lastAccessed <= restoredAt + 猶予）タブは、保存されていた値 inherited.saved を使う。
 * 今アクティブなタブは使用中なので常に tab.lastAccessed
 */
export function effectiveLastAccessed(tab, inherited) {
  const own = Number.isFinite(tab?.lastAccessed) ? tab.lastAccessed : null;
  if (tab?.active) return own;
  if (inherited && Number.isFinite(inherited.saved) && Number.isFinite(inherited.restoredAt)
    && (own === null || own <= inherited.restoredAt + RESTORE_GRACE_MS)) {
    return inherited.saved;
  }
  return own;
}

/**
 * 1 ウィンドウ分のタブ（tabs.query の結果）から、自動で閉じるタブを返す。
 * 最後にアクティブだった時刻（effectiveLastAccessed）から days 日以上経ったものが対象。
 * inherited: { [tabId]: { saved, restoredAt } }（復元したタブが引き継ぐ最終アクセス時刻）
 * exclude: 除外 URL のパターンの配列（autoCloseExcludeMatch）。当てはまるタブは閉じない
 * アクティブ・固定・音声再生中・拡張自身のページ・最終アクセス時刻が無いタブは除外。
 * ウィンドウが消えないよう、全タブ（ワークスペースタブを除く）が対象になる場合は最後に使ったタブを 1 つ残す
 */
export function tabsToAutoClose(tabs, { now, days, inherited = {}, exclude = [] }) {
  const d = parseAutoCloseDays(days);
  if (d === null || !Number.isFinite(now) || !Array.isArray(tabs)) return [];
  const threshold = now - d * DAY_MS;
  const accessed = new Map();
  const out = tabs.filter((t) => {
    if (!t || t.active || t.pinned || t.audible || tabUrl(t).startsWith('chrome-extension://')) return false;
    if (autoCloseExcludeMatch(tabUrl(t), exclude)) return false;
    const at = effectiveLastAccessed(t, inherited?.[t.id]);
    accessed.set(t, at);
    return at !== null && at <= threshold;
  });
  // ワークスペースタブ（左端のラベル）は数えない。普通のタブが 1 枚も残らないと保存内容を更新できないため
  const regular = tabs.filter((t) => t && !isWorkspaceTabUrl(tabUrl(t))).length;
  if (out.length && out.length >= regular) {
    const keep = out.reduce((a, b) => (accessed.get(b) > accessed.get(a) ? b : a));
    return out.filter((t) => t !== keep);
  }
  return out;
}

// ---- 自動クローズの除外 URL（issue #20） ----
// settings.autoCloseExclude に文字列の配列で持つ。1 件の書き方:
//   github.com                 ホスト（サブドメインも含む）。example.com は www.example.com にも当てはまる
//   mail.google.com/mail       ホスト + パスの先頭（/mail と /mail/... に当てはまり、/mailbox には当てはまらない）
//   https://example.com/a/b    URL の先頭（スキームを書くと URL 全体の前方一致。同じく /a/b と /a/b/... と /a/b?x）
//   *.example.com, example.com/*/edit, https://*.example.com/   * は任意の文字列

/** 除外パターン 1 件を整える（前後の空白を除去）。文字列でなければ '' */
export function normalizeExcludePattern(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** 除外パターンの配列を整える（空を捨て、重複を除き、順序は保つ）。配列でなければ空 */
export function normalizeExcludePatterns(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const v of list) {
    const p = normalizeExcludePattern(v);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/** glob（* だけ）→ 正規表現の本体 */
function globToRegExpSource(s) {
  return s.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\/]/g, '\$&')).join('.*');
}

/**
 * 前方一致（境界付き）: text が prefix そのものか、prefix に続く文字が区切り（/ ? # & =）か、prefix が区切りで終わる。
 * example.com/a が example.com/ab に当たらないようにする。* を含む prefix は glob として扱う
 */
function prefixMatch(text, prefix, { ignoreCase = false } = {}) {
  if (!prefix) return true;
  if (prefix.includes('*')) return new RegExp(`^${globToRegExpSource(prefix)}`, ignoreCase ? 'i' : '').test(text);
  const a = ignoreCase ? text.toLowerCase() : text;
  const b = ignoreCase ? prefix.toLowerCase() : prefix;
  if (!a.startsWith(b)) return false;
  if (a.length === b.length) return true;
  return /[/?#&=]$/.test(b) || /[/?#&=]/.test(a[b.length]);
}

/** ホストの一致: 同じか、そのサブドメイン（* を含むパターンは glob で全体一致） */
function hostMatch(host, pattern) {
  const h = (host || '').toLowerCase();
  const p = pattern.toLowerCase();
  if (!h || !p) return false;
  if (p.includes('*')) return new RegExp(`^${globToRegExpSource(p)}$`).test(h);
  return h === p || h.endsWith(`.${p}`);
}

/** 除外パターン 1 件が URL に当てはまるか */
export function matchesExcludePattern(url, pattern) {
  const p = normalizeExcludePattern(pattern);
  if (!p || typeof url !== 'string' || !url) return false;
  const target = url.split('#')[0];
  // スキーム付き: URL 全体の前方一致（末尾のスラッシュは無視。大小は区別しない）
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) {
    const strip = (s) => (s.endsWith('/') ? s.slice(0, -1) : s);
    return prefixMatch(strip(target), strip(p), { ignoreCase: true });
  }
  let u;
  try { u = new URL(target); } catch { return false; }
  // スキーム無し: ホスト（サブドメインも）と、あればパスの先頭
  const slash = p.indexOf('/');
  const hostPat = slash === -1 ? p : p.slice(0, slash);
  const pathPat = slash === -1 ? '' : p.slice(slash);
  if (!hostMatch(u.host, hostPat) && !hostMatch(u.hostname, hostPat)) return false;
  if (!pathPat || pathPat === '/') return true;
  return prefixMatch(u.pathname + u.search, pathPat);
}

/** URL に当てはまる最初の除外パターン（無ければ null） */
export function autoCloseExcludeMatch(url, patterns) {
  if (!Array.isArray(patterns) || !url) return null;
  for (const p of patterns) if (matchesExcludePattern(url, p)) return p;
  return null;
}

/**
 * タブの URL から除外パターンの候補を作る（管理パネルの「自動クローズから除外」用）。
 * page: この URL（フラグメントと末尾スラッシュを除いた前方一致）、site: ホスト全体（ホストが無い URL では null）
 */
export function excludePatternsForUrl(url) {
  const page = normalizeUrlForMatch(url);
  if (!page) return { page: '', site: null };
  let site = null;
  try { site = new URL(url).host || null; } catch { /* about:blank など */ }
  return { page, site };
}

// ---- 自動クローズで閉じたタブの履歴（issue #18） ----

/** 履歴（storage.local の closedTabs）に残す件数の上限。超えた分は古いものから捨てる */
export const CLOSED_TABS_MAX = 500;

/** 新しい順の履歴を先頭から max 件に切り詰める（配列でなければ空、max が不正なら CLOSED_TABS_MAX） */
export function trimClosedTabs(list, max = CLOSED_TABS_MAX) {
  if (!Array.isArray(list)) return [];
  const n = Number.isInteger(max) && max >= 0 ? max : CLOSED_TABS_MAX;
  return list.length > n ? list.slice(0, n) : list;
}

/**
 * 自動クローズで閉じるタブ 1 件分の履歴エントリ。
 * ws は閉じた時点のワークスペース（未割り当てなら null）。名前も残すので、後でワークスペースを削除しても表示できる。
 * data: の favicon は大きくなりがちなので保存しない（表示は favicon 権限でページ URL から引く）
 */
export function closedTabEntry(tab, ws, now = Date.now()) {
  const fav = typeof tab?.favIconUrl === 'string' && !tab.favIconUrl.startsWith('data:') ? tab.favIconUrl : '';
  return {
    id: uid('ct_'),
    url: tabUrl(tab || {}),
    title: tab?.title || '',
    favIconUrl: fav,
    closedAt: now,
    workspaceId: ws?.id || null,
    workspaceName: ws?.name || '',
    reason: 'auto',
  };
}

/** 履歴の日付見出し: 今日 / 昨日 / M/D（ローカル時刻の暦日で判定） */
export function closedDayLabel(ts, now = Date.now()) {
  const day = (t) => { const x = new Date(t); return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
  const diff = Math.round((day(now) - day(ts)) / DAY_MS);
  if (diff === 0) return '今日';
  if (diff === 1) return '昨日';
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 時刻 HH:mm（ローカル時刻） */
export function formatClockTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---- セッションごとの Cookie 分離（issue #12）。chrome.cookies の Cookie ⇔ set / remove の引数の変換 ----

/** Cookie を set / remove するときに渡す URL（スキーム + ドメイン + パス）。ドメイン Cookie の先頭の . は外す */
export function cookieUrl(cookie) {
  const host = String(cookie?.domain || '').replace(/^\./, '');
  const path = typeof cookie?.path === 'string' && cookie.path.startsWith('/') ? cookie.path : '/';
  return `${cookie?.secure ? 'https' : 'http'}://${host}${path}`;
}

/** Cookie を同じ属性で作り直すための chrome.cookies.set の引数 */
export function cookieSetDetails(cookie) {
  const d = {
    url: cookieUrl(cookie),
    name: cookie.name,
    value: cookie.value ?? '',
    path: typeof cookie.path === 'string' && cookie.path.startsWith('/') ? cookie.path : '/',
    secure: !!cookie.secure,
    httpOnly: !!cookie.httpOnly,
  };
  // hostOnly の Cookie は domain を渡さない（渡すとドメイン Cookie になってしまう）
  if (!cookie.hostOnly && cookie.domain) d.domain = cookie.domain;
  // セッション Cookie（ブラウザ終了まで）は expirationDate を付けない
  if (!cookie.session && Number.isFinite(cookie.expirationDate)) d.expirationDate = cookie.expirationDate;
  if (cookie.sameSite) d.sameSite = cookie.sameSite;
  if (cookie.storeId) d.storeId = cookie.storeId;
  if (cookie.partitionKey) d.partitionKey = cookie.partitionKey;
  return d;
}

/** Cookie を削除するための chrome.cookies.remove の引数 */
export function cookieRemoveDetails(cookie) {
  const d = { url: cookieUrl(cookie), name: cookie.name };
  if (cookie.storeId) d.storeId = cookie.storeId;
  if (cookie.partitionKey) d.partitionKey = cookie.partitionKey;
  return d;
}

/** 同じ Cookie を識別するキー（getAll を 2 通りの条件で呼んだ結果を重複なく合わせるため） */
export function cookieKey(cookie) {
  const pk = cookie.partitionKey ? JSON.stringify(cookie.partitionKey) : '';
  return [cookie.storeId || '', cookie.domain || '', cookie.path || '/', cookie.name || '', pk].join('|');
}

/** 期限切れの Cookie か（退避中に期限が過ぎたものは復元しない） */
export function isExpiredCookie(cookie, now = Date.now()) {
  return !cookie.session && Number.isFinite(cookie.expirationDate) && cookie.expirationDate * 1000 <= now;
}

/** 保存した Cookie の一覧から、同じ Cookie を 1 つにまとめて期限切れを除く */
export function dedupeCookies(cookies, now = Date.now()) {
  const seen = new Map();
  for (const c of Array.isArray(cookies) ? cookies : []) {
    if (!c || typeof c !== 'object' || typeof c.name !== 'string' || !c.domain) continue;
    if (isExpiredCookie(c, now)) continue;
    seen.set(cookieKey(c), c);
  }
  return [...seen.values()];
}

/** 退避した Cookie の入れ物（storage.local の cookieJars[sessionId]）の形を整える */
export function normalizeCookieJar(jar) {
  if (!jar || typeof jar !== 'object') return null;
  const cookies = dedupeCookies(jar.cookies);
  return { savedAt: Number.isFinite(jar.savedAt) ? jar.savedAt : 0, cookies };
}

/** Cookie のドメイン（先頭の . なし）ごとの件数。設定画面で「どのサイトのログイン状態を持っているか」を見せる */
export function cookieHosts(cookies) {
  const counts = new Map();
  for (const c of Array.isArray(cookies) ? cookies : []) {
    const host = String(c.domain || '').replace(/^\./, '');
    if (!host) continue;
    counts.set(host, (counts.get(host) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([host, count]) => ({ host, count }));
}
