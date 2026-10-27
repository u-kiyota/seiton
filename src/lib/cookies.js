// セッションごとの Cookie（ログイン状態）の分離（issue #12）。
// Chrome にはタブやウィンドウ単位で Cookie を分ける API が無いので、「今 Chrome に入っている Cookie は 1 つのセッションのもの」とし、
// 別のセッションのワークスペースに切り替えるときに、今の Cookie をそのセッションの入れ物（jar）へ退避して全部消し、
// 切替先セッションの jar から復元する（Chrome のプロファイルを切り替えるのに近い。同時に使えるセッションは 1 つ）。
// 必要な任意権限（cookies + <all_urls>）は設定画面で ON にしたときに要求する。
// ここの関数は store.js の serialize の中から呼ばれる前提（切替処理と同じ直列キューで動く）
import { cookieSetDetails, cookieRemoveDetails, dedupeCookies, normalizeCookieJar, cookieHosts } from './core.js';

/** storage.local: { [sessionId]: { savedAt, cookies: chrome.cookies.Cookie[] } }。state とは別キー（大きく、エクスポートに含めない） */
export const COOKIE_JARS_KEY = 'cookieJars';
/** storage.local: 今 Chrome に入っている Cookie がどのセッションのものか */
export const COOKIE_SESSION_KEY = 'cookieSessionId';
/** 必要な任意権限（manifest の optional_permissions / optional_host_permissions と一致させる） */
export const COOKIE_PERMISSION = Object.freeze({ permissions: ['cookies'], origins: ['<all_urls>'] });

const CONCURRENCY = 32;

export async function hasCookiePermission() {
  try {
    return await chrome.permissions.contains({ permissions: [...COOKIE_PERMISSION.permissions], origins: [...COOKIE_PERMISSION.origins] });
  } catch {
    return false;
  }
}

/** 分離が実際に働く状態か（設定が ON で、権限もある） */
export async function isolationActive(state) {
  return !!state?.settings?.cookieIsolation && await hasCookiePermission();
}

async function getJars() {
  const { [COOKIE_JARS_KEY]: jars } = await chrome.storage.local.get(COOKIE_JARS_KEY);
  return jars && typeof jars === 'object' ? jars : {};
}

export async function getCookieSessionId() {
  const { [COOKIE_SESSION_KEY]: id } = await chrome.storage.local.get(COOKIE_SESSION_KEY);
  return typeof id === 'string' && id ? id : null;
}

export async function setCookieSessionId(sessionId) {
  await chrome.storage.local.set({ [COOKIE_SESSION_KEY]: sessionId || null });
}

/** 今 Chrome に入っている Cookie を全部読む（Partitioned 属性付きも含める。古い Chrome では partitionKey を受け付けないので両方試す） */
export async function readAllCookies() {
  const lists = [];
  try {
    lists.push(await chrome.cookies.getAll({ partitionKey: {} }));
  } catch { /* partitionKey 非対応 */ }
  lists.push(await chrome.cookies.getAll({}));
  return dedupeCookies(lists.flat());
}

/** 失敗しても止めず、失敗した件数を返す */
async function forEachLimited(items, fn) {
  let failed = 0;
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    await Promise.all(items.slice(i, i + CONCURRENCY).map(async (item) => {
      try {
        const r = await fn(item);
        if (r === null) failed++; // cookies.set / remove は失敗すると null を返す（例外を投げないことがある）
      } catch (e) {
        failed++;
        console.warn('[cookies] operation failed', item?.name, item?.domain, e?.message || e);
      }
    }));
  }
  return failed;
}

/**
 * Cookie を fromId のセッションに退避し、全部消してから toId のセッションの Cookie を復元する。
 * fromId が null（どのセッションのものか分からない）のときは消さず、今の Cookie をそのまま toId のものとして扱う
 */
export async function swapCookies(fromId, toId) {
  const jars = await getJars();
  if (!fromId) {
    await setCookieSessionId(toId);
    return { from: null, to: toId, adopted: true, saved: 0, removed: 0, restored: 0, failed: 0 };
  }
  const current = await readAllCookies();
  // 1. 今の Cookie を退避。消す前に書き込みを終える（途中で止まっても失わないように）
  jars[fromId] = { savedAt: Date.now(), cookies: current };
  await chrome.storage.local.set({ [COOKIE_JARS_KEY]: jars });
  // 2. 全部消す
  const removeFailed = await forEachLimited(current, (c) => chrome.cookies.remove(cookieRemoveDetails(c)));
  // 3. 切替先の Cookie を復元（期限切れは除く）
  const jar = normalizeCookieJar(jars[toId]);
  const toRestore = jar ? jar.cookies : [];
  const restoreFailed = await forEachLimited(toRestore, (c) => chrome.cookies.set(cookieSetDetails(c)));
  await setCookieSessionId(toId);
  const res = {
    from: fromId, to: toId, adopted: false,
    saved: current.length, removed: current.length - removeFailed,
    restored: toRestore.length - restoreFailed, failed: removeFailed + restoreFailed,
  };
  console.info('[cookies] swapped', res);
  return res;
}

/** sessionId のワークスペースを開くと Cookie の入れ替えが起きるか（分離が有効で、今の Cookie が別のセッションのもの） */
export async function needsCookieSwap(state, sessionId) {
  if (!sessionId || !state?.sessions?.[sessionId]) return false;
  if (!(await isolationActive(state))) return false;
  return (await getCookieSessionId()) !== sessionId;
}

/**
 * sessionId のワークスペースを開く前に呼ぶ。分離が有効で、今の Cookie が別のセッションのものなら入れ替える。
 * 入れ替えたときは { from, to, fromName, toName, ... } を返し、何もしなければ null
 */
export async function ensureCookieSession(state, sessionId) {
  if (!sessionId || !state?.sessions?.[sessionId]) return null;
  if (!(await isolationActive(state))) return null;
  const current = await getCookieSessionId();
  if (current === sessionId) return null;
  const res = await swapCookies(state.sessions[current] ? current : null, sessionId);
  return { ...res, fromName: state.sessions[current]?.name || null, toName: state.sessions[sessionId].name };
}

/** セッションを削除したときに、その退避 Cookie も消す */
export async function forgetSessionJar(sessionId) {
  const jars = await getJars();
  if (!(sessionId in jars)) return;
  delete jars[sessionId];
  await chrome.storage.local.set({ [COOKIE_JARS_KEY]: jars });
}

/** 退避した Cookie を全部消す（今 Chrome に入っている Cookie は消さない） */
export async function clearCookieJars() {
  await chrome.storage.local.remove(COOKIE_JARS_KEY);
}

/** 設定画面・セッション管理の表示用: 権限の有無、今の Cookie のセッション、各セッションの退避 Cookie の件数と主なサイト */
export async function cookieStatus(state, { hosts = 8, live = true } = {}) {
  const permitted = await hasCookiePermission();
  const jars = await getJars();
  const out = { permitted, enabled: !!state?.settings?.cookieIsolation, cookieSessionId: await getCookieSessionId(), jars: {}, live: null };
  for (const [id, raw] of Object.entries(jars)) {
    const jar = normalizeCookieJar(raw);
    if (!jar) continue;
    out.jars[id] = { savedAt: jar.savedAt, count: jar.cookies.length, hosts: cookieHosts(jar.cookies).slice(0, hosts) };
  }
  if (permitted && live) {
    try {
      const all = await readAllCookies();
      out.live = { count: all.length, hosts: cookieHosts(all).slice(0, hosts) };
    } catch { /* 権限が取り消された直後など */ }
  }
  return out;
}

/** 権限が無いのに設定が ON のままなら OFF に戻す（権限の取り消し・インポート後の整合）。変更したら true */
export async function reconcileCookieIsolation(state) {
  if (!state.settings.cookieIsolation) return false;
  if (await hasCookiePermission()) return false;
  state.settings.cookieIsolation = false;
  return true;
}

/** 設定画面の OFF: 権限を返上する（退避した Cookie と「今の Cookie のセッション」は残し、再度 ON にしたとき続きから使える） */
export async function releaseCookiePermission() {
  try {
    await chrome.permissions.remove({ permissions: [...COOKIE_PERMISSION.permissions], origins: [...COOKIE_PERMISSION.origins] });
  } catch (e) {
    console.warn('[cookies] failed to remove permission', e);
  }
}
