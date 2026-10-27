// セッションごとの Cookie（ログイン状態）の分離（issue #12）。
// Chrome にはタブやウィンドウ単位で Cookie を分ける API が無いので、「今 Chrome に入っている Cookie は 1 つのセッションのもの」とし、
// 別のセッションのワークスペースに切り替えるときに、今の Cookie をそのセッションの入れ物（jar）へ退避して全部消し、
// 切替先セッションの jar から復元する（Chrome のプロファイルを切り替えるのに近い。同時に使えるセッションは 1 つ）。
// 必要な任意権限（cookies + <all_urls>）は 2 つ目のセッションを追加するときに、同意ダイアログの後で要求する。
// 退避した Cookie は vault.js（AES-GCM。鍵は IndexedDB の書き出せない CryptoKey）で暗号化して storage.local に置く。
// ここの関数は store.js の serialize の中から呼ばれる前提（切替処理と同じ直列キューで動く）
import { cookieSetDetails, cookieRemoveDetails, dedupeCookies, normalizeCookieJar, cookieHosts } from './core.js';
import { encryptJson, decryptJson, isEncrypted } from './vault.js';

/**
 * storage.local: { [sessionId]: { savedAt, enc, iv, data } }。enc/iv/data は暗号化した chrome.cookies.Cookie[]（vault.js）。
 * state とは別キー（大きく、エクスポート / 同期に含めない）。旧版（v1.0.1 より前）は { savedAt, cookies } の平文で、
 * 起動時の encryptCookieJars() で暗号化に置き換える
 */
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

/** 分離が働く状態か（= 権限がある。ON / OFF の設定は無く、セッションを追加するときに権限を求める） */
export async function isolationActive() {
  return hasCookiePermission();
}

/** 保存形のまま（復号しない）読む */
async function getRawJars() {
  const { [COOKIE_JARS_KEY]: jars } = await chrome.storage.local.get(COOKIE_JARS_KEY);
  return jars && typeof jars === 'object' ? jars : {};
}

/** jar（{ savedAt, cookies }）を暗号化した保存形にする。savedAt は表示用に平文のまま */
async function sealJar(jar) {
  return { savedAt: jar.savedAt, ...(await encryptJson(jar.cookies)) };
}

/**
 * 保存形から jar（{ savedAt, cookies }）へ。復号できない（鍵が無い・壊れている）ときは null = 退避 Cookie なしとして扱う。
 * 旧版の平文 jar（{ savedAt, cookies }）もそのまま読める（encryptCookieJars が暗号化に置き換える）
 */
async function openJar(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!isEncrypted(raw)) return normalizeCookieJar(raw);
  try {
    return normalizeCookieJar({ savedAt: raw.savedAt, cookies: await decryptJson(raw) });
  } catch (e) {
    console.warn('[cookies] 退避した Cookie を復号できません（鍵が変わった・データが壊れている）', e?.message || e);
    return null;
  }
}

/** 全 jar を復号して返す（表示用） */
async function getJars() {
  const raw = await getRawJars();
  const out = {};
  for (const [id, r] of Object.entries(raw)) {
    const jar = await openJar(r);
    if (jar) out[id] = jar;
  }
  return out;
}

/** 旧版の平文 jar があれば暗号化して置き換える（起動時・更新時に呼ぶ）。置き換えた件数を返す */
export async function encryptCookieJars() {
  const raw = await getRawJars();
  let changed = 0;
  for (const [id, r] of Object.entries(raw)) {
    if (isEncrypted(r)) continue;
    const jar = normalizeCookieJar(r);
    if (!jar) { delete raw[id]; changed++; continue; }
    raw[id] = await sealJar(jar);
    changed++;
  }
  if (changed) await chrome.storage.local.set({ [COOKIE_JARS_KEY]: raw });
  return changed;
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
  if (!fromId) {
    await setCookieSessionId(toId);
    return { from: null, to: toId, adopted: true, saved: 0, removed: 0, restored: 0, failed: 0 };
  }
  const raw = await getRawJars();
  const current = await readAllCookies();
  // 1. 今の Cookie を暗号化して退避。消す前に書き込みを終える（途中で止まっても失わないように）。
  //    暗号化に失敗したら（鍵が作れない等）ここで例外になり、Cookie は消さない
  raw[fromId] = await sealJar({ savedAt: Date.now(), cookies: current });
  await chrome.storage.local.set({ [COOKIE_JARS_KEY]: raw });
  // 2. 全部消す
  const removeFailed = await forEachLimited(current, (c) => chrome.cookies.remove(cookieRemoveDetails(c)));
  // 3. 切替先の Cookie を復元（期限切れは除く）
  const jar = await openJar(raw[toId]);
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
  if (!(await isolationActive())) return false;
  return (await getCookieSessionId()) !== sessionId;
}

/**
 * sessionId のワークスペースを開く前に呼ぶ。分離が有効で、今の Cookie が別のセッションのものなら入れ替える。
 * 入れ替えたときは { from, to, fromName, toName, ... } を返し、何もしなければ null
 */
export async function ensureCookieSession(state, sessionId) {
  if (!sessionId || !state?.sessions?.[sessionId]) return null;
  if (!(await isolationActive())) return null;
  const current = await getCookieSessionId();
  if (current === sessionId) return null;
  const res = await swapCookies(state.sessions[current] ? current : null, sessionId);
  return { ...res, fromName: state.sessions[current]?.name || null, toName: state.sessions[sessionId].name };
}

/** セッションを削除したときに、その退避 Cookie も消す */
export async function forgetSessionJar(sessionId) {
  const raw = await getRawJars();
  if (!(sessionId in raw)) return;
  delete raw[sessionId];
  await chrome.storage.local.set({ [COOKIE_JARS_KEY]: raw });
}

/** 退避した Cookie を全部消す（今 Chrome に入っている Cookie は消さない） */
export async function clearCookieJars() {
  await chrome.storage.local.remove(COOKIE_JARS_KEY);
}

/** 設定画面・セッション管理の表示用: 権限の有無、今の Cookie のセッション、各セッションの退避 Cookie の件数と主なサイト */
export async function cookieStatus(state, { hosts = 8, live = true } = {}) {
  const permitted = await hasCookiePermission();
  const jars = await getJars();
  const out = { permitted, cookieSessionId: await getCookieSessionId(), jars: {}, live: null };
  for (const [id, jar] of Object.entries(jars)) {
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

/**
 * 権限が許可された直後（セッションの追加時）に呼ぶ。「今 Chrome に入っている Cookie がどのセッションのものか」がまだ無ければ決める。
 * sessionId（権限を求めたウィンドウのワークスペースのセッション）→ 最後に使ったワークスペースのセッション → 先頭のセッション の順。
 * 既に決まっていれば変えない（権限を取り消して許可し直したときに、退避した Cookie との対応を崩さない）
 */
export async function adoptCookieSession(state, sessionId) {
  const current = await getCookieSessionId();
  if (current && state.sessions[current]) return { cookieSessionId: current, adopted: false };
  const last = state.workspaces[state.lastFocusedWorkspaceId]?.sessionId;
  const sid = state.sessions[sessionId] ? sessionId : (state.sessions[last] ? last : state.sessionOrder[0]);
  await setCookieSessionId(sid);
  return { cookieSessionId: sid, adopted: true };
}
