// 退避した Cookie（ログイン情報）の暗号化。Chrome Web Store のユーザーデータ方針は認証情報を保存時に強い暗号化で守ることを求める。
// AES-GCM 256 bit。鍵は書き出せない（extractable: false）CryptoKey として IndexedDB（seiton-vault）に置き、
// 暗号文は chrome.storage.local に Base64 で置く。鍵は JS から値を取り出せず、鍵と暗号文は別の場所にある。
// この拡張を削除すると両方とも消える。サービスワーカーだけが使う（UI は background へのメッセージ経由）。
// テストでは setKeyStore() で鍵の置き場をメモリに差し替える（Node に IndexedDB は無い）
import { t } from './i18n.js';

const DB_NAME = 'seiton-vault';
const DB_VERSION = 1;
const STORE = 'keys';
const KEY_ID = 'cookieJars';
/** 暗号文の形式の印（将来アルゴリズムを変えるときに見分ける） */
export const VAULT_FORMAT = 'aes-gcm-1';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error(t('IndexedDB がブロックされています')));
  });
}

/** 1 トランザクションで 1 リクエスト。結果はトランザクション完了後に返す（put / add の書き込みが確定してから） */
async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let result;
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => { result = req.result; };
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error(t('IndexedDB のトランザクションが中断されました')));
    });
  } finally {
    db.close();
  }
}

const idbKeyStore = {
  get: () => withStore('readonly', (s) => s.get(KEY_ID)),
  // add は既にあれば失敗する（同時に 2 か所で鍵を作っても 1 つしか残らない）
  add: (key) => withStore('readwrite', (s) => s.add(key, KEY_ID)),
  delete: () => withStore('readwrite', (s) => s.delete(KEY_ID)),
};

let keyStore = idbKeyStore;
let keyPromise = null;

/** テスト用: 鍵の置き場を { get(), add(key), delete() } に差し替える */
export function setKeyStore(store) {
  keyStore = store || idbKeyStore;
  keyPromise = null;
}

async function loadOrCreateKey() {
  const existing = await keyStore.get();
  if (existing) return existing;
  const fresh = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  try {
    await keyStore.add(fresh);
  } catch { /* 別の処理が先に作った。下で読み直す */ }
  return (await keyStore.get()) || fresh;
}

/** 鍵を返す（無ければ作る）。同時に呼ばれても 1 回しか作らない */
export function getVaultKey() {
  if (!keyPromise) {
    keyPromise = loadOrCreateKey().catch((e) => { keyPromise = null; throw e; });
  }
  return keyPromise;
}

/** 鍵を捨てる（以後、既存の暗号文は読めなくなる。次の暗号化で新しい鍵を作る） */
export async function deleteVaultKey() {
  keyPromise = null;
  await keyStore.delete();
}

function toBase64(bytes) {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

function fromBase64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 任意の JSON 値を暗号化して { enc, iv, data }（すべて文字列。chrome.storage に入れられる）にする */
export async function encryptJson(value) {
  const key = await getVaultKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
  return { enc: VAULT_FORMAT, iv: toBase64(iv), data: toBase64(new Uint8Array(data)) };
}

/** encryptJson の出力か */
export function isEncrypted(blob) {
  return !!blob && typeof blob === 'object' && blob.enc === VAULT_FORMAT && typeof blob.iv === 'string' && typeof blob.data === 'string';
}

/** encryptJson の出力を元の値に戻す。鍵が違う・壊れている場合は例外 */
export async function decryptJson(blob) {
  if (!isEncrypted(blob)) throw new Error(t('暗号化された形式ではありません'));
  const key = await getVaultKey();
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(blob.iv) }, key, fromBase64(blob.data));
  return JSON.parse(new TextDecoder().decode(plain));
}
