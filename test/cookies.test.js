// セッションごとの Cookie の分離（issue #12）。chrome API を偽物に差し替えて、退避 → 全削除 → 復元の流れを確かめる
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// cookies.js はモジュール読み込み時に chrome を触らないので、先に偽物を用意してから import する
const fake = makeFakeChrome();
globalThis.chrome = fake.chrome;
const {
  swapCookies, ensureCookieSession, needsCookieSwap, forgetSessionJar, clearCookieJars, cookieStatus,
  adoptCookieSession, getCookieSessionId, COOKIE_JARS_KEY, COOKIE_SESSION_KEY,
} = await import('../src/lib/cookies.js');

function cookie(name, domain, extra = {}) {
  return {
    name, value: `v-${name}`, domain, path: '/', secure: true, httpOnly: false, hostOnly: !domain.startsWith('.'),
    session: false, expirationDate: Math.floor(Date.now() / 1000) + 3600, sameSite: 'lax', storeId: '0', ...extra,
  };
}

function makeFakeChrome() {
  const store = {};
  let cookies = [];
  let permitted = true;
  const key = (c) => `${c.storeId}|${c.domain}|${c.path}|${c.name}|${c.partitionKey ? JSON.stringify(c.partitionKey) : ''}`;
  const chrome = {
    storage: {
      local: {
        async get(k) { return { [k]: store[k] === undefined ? undefined : JSON.parse(JSON.stringify(store[k])) }; },
        async set(obj) { for (const [k, v] of Object.entries(obj)) store[k] = JSON.parse(JSON.stringify(v)); },
        async remove(k) { delete store[k]; },
      },
    },
    permissions: {
      async contains() { return permitted; },
      async remove() { permitted = false; return true; },
    },
    cookies: {
      async getAll(filter) {
        // 本物に合わせて、partitionKey: {} を渡すと分割 Cookie も含めて全部返し、無しなら分割されていないものだけ
        if (filter.partitionKey) return cookies.map((c) => ({ ...c }));
        return cookies.filter((c) => !c.partitionKey).map((c) => ({ ...c }));
      },
      async remove(d) {
        const host = new URL(d.url).hostname;
        const idx = cookies.findIndex((c) => c.name === d.name && c.domain.replace(/^\./, '') === host
          && (c.storeId || '0') === (d.storeId || '0') && JSON.stringify(c.partitionKey || null) === JSON.stringify(d.partitionKey || null));
        if (idx < 0) return null;
        cookies.splice(idx, 1);
        return { url: d.url, name: d.name };
      },
      async set(d) {
        if (!d.url || !d.name) return null;
        const u = new URL(d.url);
        const c = {
          name: d.name, value: d.value, domain: d.domain || u.hostname, path: d.path || '/', secure: !!d.secure, httpOnly: !!d.httpOnly,
          hostOnly: !d.domain, session: d.expirationDate === undefined, expirationDate: d.expirationDate,
          sameSite: d.sameSite || 'unspecified', storeId: d.storeId || '0', partitionKey: d.partitionKey,
        };
        const idx = cookies.findIndex((x) => key(x) === key(c));
        if (idx >= 0) cookies[idx] = c; else cookies.push(c);
        return c;
      },
    },
  };
  return {
    chrome,
    reset(list = []) { cookies = list.map((c) => ({ ...c })); for (const k of Object.keys(store)) delete store[k]; permitted = true; },
    get cookies() { return cookies; },
    get store() { return store; },
    setPermitted(v) { permitted = v; },
  };
}

const state = () => ({
  settings: {},
  sessions: { A: { id: 'A', name: '本番' }, B: { id: 'B', name: '開発' } },
  sessionOrder: ['A', 'B'],
  workspaces: { w1: { id: 'w1', sessionId: 'B' } },
  lastFocusedWorkspaceId: 'w1',
});

beforeEach(() => fake.reset());

test('swapCookies: 今の Cookie を from に退避して全部消し、to の Cookie を復元する', async () => {
  fake.reset([cookie('sid', 'github.com'), cookie('pref', '.example.com', { sameSite: 'no_restriction' })]);
  await fake.chrome.storage.local.set({ [COOKIE_SESSION_KEY]: 'A' });
  const res = await swapCookies('A', 'B');
  assert.equal(res.saved, 2);
  assert.equal(res.removed, 2);
  assert.equal(res.restored, 0, 'B には退避した Cookie が無いので空になる');
  assert.equal(res.failed, 0);
  assert.deepEqual(fake.cookies, [], 'Chrome の Cookie は空');
  assert.equal(fake.store[COOKIE_JARS_KEY].A.cookies.length, 2, 'A の jar に 2 件退避');
  assert.equal(await getCookieSessionId(), 'B');

  // B でログインした体で Cookie を足し、A に戻す
  fake.cookies.push(cookie('sid', 'github.com', { value: 'dev-login' }));
  const back = await swapCookies('B', 'A');
  assert.equal(back.saved, 1);
  assert.equal(back.restored, 2, 'A の 2 件が戻る');
  assert.equal(fake.cookies.length, 2);
  const sid = fake.cookies.find((c) => c.name === 'sid');
  assert.equal(sid.value, 'v-sid', 'A の値に戻っている（B の dev-login ではない）');
  assert.equal(sid.hostOnly, true, 'hostOnly の Cookie は hostOnly のまま');
  const pref = fake.cookies.find((c) => c.name === 'pref');
  assert.equal(pref.domain, '.example.com', 'ドメイン Cookie はドメインを保つ');
  assert.equal(pref.sameSite, 'no_restriction');
  assert.equal(fake.store[COOKIE_JARS_KEY].B.cookies[0].value, 'dev-login', 'B の jar に B のログインが退避されている');
  assert.equal(await getCookieSessionId(), 'A');
});

test('swapCookies: セッション Cookie は expirationDate 無しで復元し、退避中に期限が切れたものは復元しない', async () => {
  fake.reset([
    cookie('s', 'a.test', { session: true, expirationDate: undefined }),
    cookie('p', 'a.test', { partitionKey: { topLevelSite: 'https://top.test' } }),
  ]);
  await swapCookies('A', 'B');
  assert.equal(fake.store[COOKIE_JARS_KEY].A.cookies.length, 2);
  // 退避している間に期限が切れた Cookie（Chrome 自身は期限切れを getAll で返さないので、jar に直接混ぜる）
  const jars = fake.store[COOKIE_JARS_KEY];
  jars.A.cookies.push(cookie('old', 'a.test', { expirationDate: Math.floor(Date.now() / 1000) - 10 }));
  await fake.chrome.storage.local.set({ [COOKIE_JARS_KEY]: jars });
  await swapCookies('B', 'A');
  const names = fake.cookies.map((c) => c.name).sort();
  assert.deepEqual(names, ['p', 's']);
  assert.equal(fake.cookies.find((c) => c.name === 's').session, true);
  assert.deepEqual(fake.cookies.find((c) => c.name === 'p').partitionKey, { topLevelSite: 'https://top.test' }, '分割 Cookie の partitionKey を保つ');
});

test('swapCookies: from が不明なら消さず、今の Cookie を to のものとして引き取る', async () => {
  fake.reset([cookie('sid', 'github.com')]);
  const res = await swapCookies(null, 'A');
  assert.equal(res.adopted, true);
  assert.equal(fake.cookies.length, 1, '消していない');
  assert.equal(await getCookieSessionId(), 'A');
  assert.equal(fake.store[COOKIE_JARS_KEY], undefined, '何も退避しない');
});

test('ensureCookieSession / needsCookieSwap: 権限なし・同じセッションでは何もしない', async () => {
  fake.reset([cookie('sid', 'github.com')]);
  await fake.chrome.storage.local.set({ [COOKIE_SESSION_KEY]: 'A' });
  assert.equal(await needsCookieSwap(state(), 'A'), false);
  assert.equal(await ensureCookieSession(state(), 'A'), null);
  fake.setPermitted(false);
  assert.equal(await needsCookieSwap(state(), 'B'), false);
  assert.equal(await ensureCookieSession(state(), 'B'), null);
  assert.equal(fake.cookies.length, 1, 'Cookie は触っていない');
  fake.setPermitted(true);
  assert.equal(await ensureCookieSession(state(), 'unknown'), null, '存在しないセッションは無視');
});

test('ensureCookieSession: 別のセッションなら入れ替え、名前付きの結果を返す', async () => {
  fake.reset([cookie('sid', 'github.com')]);
  await fake.chrome.storage.local.set({ [COOKIE_SESSION_KEY]: 'A' });
  assert.equal(await needsCookieSwap(state(), 'B'), true);
  const res = await ensureCookieSession(state(), 'B');
  assert.equal(res.from, 'A');
  assert.equal(res.to, 'B');
  assert.equal(res.fromName, '本番');
  assert.equal(res.toName, '開発');
  assert.deepEqual(fake.cookies, []);
  assert.equal(await needsCookieSwap(state(), 'B'), false, '入れ替え後は不要');
});

test('ensureCookieSession: 今の Cookie のセッションが消えていれば、消さずに引き取る', async () => {
  fake.reset([cookie('sid', 'github.com')]);
  await fake.chrome.storage.local.set({ [COOKIE_SESSION_KEY]: 'gone' });
  const res = await ensureCookieSession(state(), 'B');
  assert.equal(res.adopted, true);
  assert.equal(fake.cookies.length, 1);
  assert.equal(await getCookieSessionId(), 'B');
});

test('forgetSessionJar / clearCookieJars / cookieStatus', async () => {
  fake.reset([cookie('sid', 'github.com'), cookie('x', '.google.com'), cookie('y', '.google.com')]);
  await swapCookies('A', 'B');
  fake.cookies.push(cookie('dev', 'dev.test'));
  const st = await cookieStatus(state());
  assert.equal(st.permitted, true);
  assert.equal(st.cookieSessionId, 'B');
  assert.equal(st.jars.A.count, 3);
  assert.deepEqual(st.jars.A.hosts, [{ host: 'google.com', count: 2 }, { host: 'github.com', count: 1 }], '件数の多い順');
  assert.equal(st.live.count, 1);
  assert.deepEqual(st.live.hosts, [{ host: 'dev.test', count: 1 }]);

  await forgetSessionJar('A');
  assert.deepEqual(fake.store[COOKIE_JARS_KEY], {});
  await forgetSessionJar('none'); // 無いものは何もしない
  await swapCookies('B', 'A');
  assert.equal(Object.keys(fake.store[COOKIE_JARS_KEY]).length, 1);
  await clearCookieJars();
  assert.equal(fake.store[COOKIE_JARS_KEY], undefined);
  assert.equal(await getCookieSessionId(), 'A', '今の Cookie のセッションは残る');
});

test('adoptCookieSession: 未定なら 指定 → 最後のワークスペース → 先頭 の順で決め、決まっていれば変えない', async () => {
  let r = await adoptCookieSession(state(), 'A');
  assert.deepEqual(r, { cookieSessionId: 'A', adopted: true });
  assert.equal(await getCookieSessionId(), 'A');
  r = await adoptCookieSession(state(), 'B');
  assert.deepEqual(r, { cookieSessionId: 'A', adopted: false }, '既に決まっていれば変えない');
  await fake.chrome.storage.local.set({ [COOKIE_SESSION_KEY]: 'gone' });
  r = await adoptCookieSession(state(), undefined);
  assert.deepEqual(r, { cookieSessionId: 'B', adopted: true }, '消えたセッションなら決め直す。指定が無ければ最後に使ったワークスペースのセッション');
  await fake.chrome.storage.local.remove(COOKIE_SESSION_KEY);
  r = await adoptCookieSession({ ...state(), lastFocusedWorkspaceId: null }, 'nope');
  assert.deepEqual(r, { cookieSessionId: 'A', adopted: true }, 'どちらも無ければ先頭');
});

test('cookieStatus: enabled は無く permitted だけを返す', async () => {
  const st = await cookieStatus(state(), { live: false });
  assert.equal('enabled' in st, false);
  assert.equal(st.permitted, true);
});
