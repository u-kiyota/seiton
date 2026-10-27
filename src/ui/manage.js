// 管理 UI（ワークスペース / セッション / 閉じたタブ）。設定・管理画面（options.html）の「管理」の節に描く。
// ワークスペースの並び替え（ドラッグ＆ドロップ）とアイコン選択は管理パネル（sidepanel.js）とも共用する。
import {
  workspacesUsingSession, matchesQuery, ICON_GROUPS, ICONS, normalizeIcon, workspaceHotkey, normalizeUrlForMatch,
  autoCloseDaysFrom, autoCloseDuration, formatAutoCloseDuration, AUTO_CLOSE_UNIT_LABELS,
  CLOSED_TABS_MAX, closedDayLabel, formatClockTime,
  WORKSPACE_DRAG_TYPE, parseWorkspaceDragData, dropPlacement, reorderDropIndex,
} from '../lib/core.js';
import { call, h, faviconUrl, COLOR_HEX, wsIcon, toast, attempt, confirmButton } from './api.js';

const COLORS = Object.keys(COLOR_HEX);
// manifest の optional_permissions / optional_host_permissions と一致させる（lib/cookies.js の COOKIE_PERMISSION と同じ）
export const COOKIE_PERMISSION = { permissions: ['cookies'], origins: ['<all_urls>'] };

function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

function fav(url) {
  const img = h('img', { class: 'fav', src: faviconUrl(url), alt: '' });
  img.addEventListener('error', () => img.remove());
  return img;
}

function windowOf(bindings, wsId) {
  const e = Object.entries(bindings || {}).find(([, w]) => w === wsId);
  return e ? Number(e[0]) : null;
}

/** 文字 / 数値の入力欄やセレクトを操作中か（描き直すとフォーカスと入力中の値が消えるため、その間は待つ） */
function editingIn(root) {
  const a = document.activeElement;
  return !!a && root.contains(a) && ((a.tagName === 'INPUT' && (a.type === 'text' || a.type === 'number')) || a.tagName === 'SELECT');
}

/**
 * アイコン選択 UI。既定の絵文字から選ぶか、入力欄に任意の絵文字を入れる。「なし」で色のドットに戻す。
 * onPick(icon) は選択のたびに呼ばれる（icon は '' = なし）
 */
export function iconPicker(current, onPick) {
  let value = normalizeIcon(current);
  const box = h('div', { class: 'icon-picker' });
  const custom = h('input', { type: 'text', placeholder: '絵文字', title: '一覧に無い絵文字を入力', maxlength: 16, autocomplete: 'off' });
  const buttons = [];
  const sync = () => {
    for (const b of buttons) b.classList.toggle('sel', b.dataset.icon === value);
    // 入力中（IME 変換中を含む）は入力欄の内容を書き換えない
    if (document.activeElement !== custom) custom.value = ICONS.includes(value) ? '' : value;
    custom.classList.toggle('sel', !!value && !ICONS.includes(value));
  };
  const pick = (v) => { value = normalizeIcon(v); sync(); onPick(value); };
  const row = (...kids) => h('div', { class: 'icon-row' }, ...kids);
  const groups = ICON_GROUPS.map((g) => {
    const btns = g.icons.map((ic) => h('button', { type: 'button', 'data-icon': ic, title: ic, onclick: () => pick(ic) }, ic));
    buttons.push(...btns);
    return row(h('span', { class: 'icon-label' }, g.label), ...btns);
  });
  const none = h('button', { type: 'button', class: 'none', 'data-icon': '', title: 'アイコンなし（色のドットを表示）', onclick: () => pick('') }, 'なし');
  buttons.push(none);
  // IME 変換中は確定するまで反映しない（変換中の文字列を保存しないため）
  const commitCustom = () => {
    const v = normalizeIcon(custom.value);
    if (v) pick(v);
  };
  custom.addEventListener('input', (e) => { if (!e.isComposing) commitCustom(); });
  custom.addEventListener('compositionend', commitCustom);
  custom.addEventListener('blur', () => { if (!normalizeIcon(custom.value) && !ICONS.includes(value)) pick(''); sync(); });
  box.append(...groups, row(h('span', { class: 'icon-label' }, 'その他'), custom, none));
  sync();
  return box;
}

// ---- ワークスペースの並び替え: ドラッグ＆ドロップ（issue #25） ----

// ドラッグ中のワークスペース ID。dragover 中は dataTransfer の中身が読めないので控えておく
let draggingWsId = null;
// ドラッグを始めた行の click（一覧では切替）を 1 回だけ無視する。次の mousedown で解除
let suppressClick = false;
document.addEventListener('mousedown', () => { suppressClick = false; }, true);

function hasWorkspaceDrag(e) {
  return !!e.dataTransfer && [...e.dataTransfer.types].includes(WORKSPACE_DRAG_TYPE);
}

function clearReorderMarks() {
  for (const el of document.querySelectorAll('.drop-before, .drop-after')) el.classList.remove('drop-before', 'drop-after');
}

/**
 * el をワークスペース id のドラッグ元にする。handle を渡すとそこを押した時だけドラッグできる（入力欄のある行用）。
 * ドラッグ直後に el に click が届いても無視する
 */
export function makeWorkspaceDraggable(el, id, { handle = null } = {}) {
  if (handle) {
    el.draggable = false;
    handle.addEventListener('mousedown', () => { el.draggable = true; });
    handle.addEventListener('mouseup', () => { el.draggable = false; });
  } else {
    el.draggable = true;
  }
  el.addEventListener('dragstart', (e) => {
    suppressClick = true;
    draggingWsId = id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(WORKSPACE_DRAG_TYPE, JSON.stringify({ id }));
    el.classList.add('dragging');
  });
  el.addEventListener('click', (e) => {
    if (!suppressClick) return;
    suppressClick = false;
    e.stopImmediatePropagation();
  }, true);
  el.addEventListener('dragend', () => {
    draggingWsId = null;
    el.classList.remove('dragging');
    if (handle) el.draggable = false;
    clearReorderMarks();
  });
  return el;
}

/**
 * el をワークスペース id の行として、他のワークスペースのドロップ先にする。
 * 上半分に落とすとその行の前、下半分なら後ろへ。印（線）は mark（省略時は el）に付ける。getOrder() は今の並び順
 */
export function makeWorkspaceDropTarget(el, id, { getOrder, mark = el }) {
  const targetIndex = (e, draggedId) => {
    const r = el.getBoundingClientRect();
    return reorderDropIndex(getOrder() || [], draggedId, id, dropPlacement(e.clientY - r.top, r.height));
  };
  el.addEventListener('dragover', (e) => {
    if (!hasWorkspaceDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = el.getBoundingClientRect();
    const placement = dropPlacement(e.clientY - r.top, r.height);
    const toIndex = draggingWsId ? targetIndex(e, draggingWsId) : null;
    mark.classList.toggle('drop-before', toIndex !== null && placement === 'before');
    mark.classList.toggle('drop-after', toIndex !== null && placement === 'after');
  });
  el.addEventListener('dragleave', (e) => {
    if (e.relatedTarget && el.contains(e.relatedTarget)) return;
    mark.classList.remove('drop-before', 'drop-after');
  });
  el.addEventListener('drop', (e) => {
    if (!hasWorkspaceDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    clearReorderMarks();
    const dragged = parseWorkspaceDragData((t) => e.dataTransfer.getData(t));
    if (!dragged) return;
    const toIndex = targetIndex(e, dragged);
    if (toIndex === null) return;
    attempt(() => call('reorderWorkspace', { id: dragged, toIndex }));
  });
  return el;
}

// ---- ワークスペースの管理（一覧で編集・一括変更・並び替え・削除。issue #25） ----

/** 「自動クローズ」のコントロール: 設定に従う（null）/ 無効 / 有効（期間）。read() は今の値（不正なら undefined） */
function autoCloseControls(settings, ws, { onSave, blurOnChange = true }) {
  const globalAc = settings.autoClose || { enabled: false, days: 7 };
  const ac = ws?.autoClose || null;
  const acDaysValue = ac?.days ?? globalAc.days;
  const mode = h('select', { title: 'タブの自動クローズ（設定の値をこのワークスペースだけ上書き）' },
    h('option', { value: '', selected: !ac }, `設定に従う（${globalAc.enabled ? `有効・${formatAutoCloseDuration(globalAc.days)}` : '無効'}）`),
    h('option', { value: 'off', selected: !!ac && !ac.enabled }, '無効'),
    h('option', { value: 'on', selected: !!ac?.enabled }, '有効'));
  const dur = autoCloseDuration(acDaysValue);
  const value = h('input', { type: 'number', min: '1', step: '1', value: String(dur.value), style: { width: '64px' }, title: '閉じるまでの期間（最後に使ってから）' });
  const unit = h('select', { title: '単位' }, ...Object.entries(AUTO_CLOSE_UNIT_LABELS).map(([v, label]) =>
    h('option', { value: v, selected: v === dur.unit }, label)));
  const durationBox = h('span', { class: 'row ac-duration', hidden: !ac?.enabled }, value, unit);
  const read = () => {
    if (!mode.value) return null;
    if (mode.value === 'off') return { enabled: false, days: acDaysValue };
    const days = autoCloseDaysFrom(value.value, unit.value);
    if (days === null) {
      toast('期間は 15 分以上で入力してください', true);
      value.value = String(dur.value);
      unit.value = dur.unit;
      return undefined;
    }
    return { enabled: true, days };
  };
  const commit = () => {
    const v = read();
    if (v !== undefined) onSave(v);
  };
  mode.addEventListener('change', () => {
    durationBox.hidden = mode.value !== 'on';
    // フォーカスが残っていると一覧の描き直しが後回しになるので外す
    if (blurOnChange) mode.blur();
    commit();
  });
  value.addEventListener('change', commit);
  unit.addEventListener('change', commit);
  return { box: h('span', { class: 'row ac-controls' }, mode, durationBox), read };
}

/**
 * ワークスペースの管理を root の中に描く。ctx.getData(): { state, bindings }、ctx.getWindowId(): 「ここ」バッジを付けるウィンドウ。
 * 戻り値の render() は状態が変わるたびに呼ぶ（入力中なら、フォーカスが外れてから描く）
 */
export function createWorkspaceManager(root, ctx) {
  const selected = new Set(); // チェックを入れたワークスペース ID
  let expandId = null; // 色・アイコンを開いている行
  let pending = false;
  let bulkAutoClose = null;

  const allCheck = h('input', { type: 'checkbox', title: 'すべて選択 / 解除' });
  const count = h('span', { class: 'muted small grow' });
  const list = h('div', { class: 'mg-list' });
  const bulkSession = h('select', { title: 'セッション' });
  const bulkColor = h('select', { title: '色' }, h('option', { value: '' }, '色を選択…'),
    ...COLORS.map((c) => h('option', { value: c, style: { color: COLOR_HEX[c] } }, `● ${c}`)));
  const bulkAutoCloseSlot = h('span');
  const bulkDeleteBtn = confirmButton('選択を削除', '本当に削除？', () => {
    const ids = targets();
    if (!ids.length) return;
    attempt(async () => {
      const res = await call('deleteWorkspaces', { ids });
      for (const id of ids) selected.delete(id);
      toast(`${res.count} 件を削除しました（ブックマークフォルダは残っています）`);
    });
  }, { title: 'チェックした行をまとめて削除（ブックマークフォルダは残ります）' });
  const bulk = h('div', { class: 'mg-bulk' },
    h('span', { class: 'mg-bulk-title' }, 'チェックした行を一括変更:'),
    h('span', { class: 'group' }, h('span', { class: 'label' }, 'セッション'), bulkSession,
      h('button', { type: 'button', onclick: () => { if (!bulkSession.value) { toast('セッションを選んでください', true); return; } bulkApply({ sessionId: bulkSession.value }, 'セッション'); } }, '適用')),
    h('span', { class: 'group' }, h('span', { class: 'label' }, '色'), bulkColor,
      h('button', { type: 'button', onclick: () => { if (!bulkColor.value) { toast('色を選んでください', true); return; } bulkApply({ color: bulkColor.value }, '色'); } }, '適用')),
    h('span', { class: 'group' }, h('span', { class: 'label' }, '自動クローズ'), bulkAutoCloseSlot,
      h('button', { type: 'button', onclick: () => { const v = bulkAutoClose?.read(); if (v !== undefined) bulkApply({ autoClose: v }, '自動クローズ'); } }, '適用')),
    h('span', { class: 'grow' }),
    bulkDeleteBtn,
  );
  root.replaceChildren(
    h('div', { class: 'row' }, h('label', { class: 'check' }, allCheck, ' すべて選択'), count),
    list,
    bulk,
  );

  const targets = () => [...selected].filter((id) => ctx.getData().state?.workspaces[id]);

  function bulkApply(patch, label) {
    const ids = targets();
    if (!ids.length) { toast('変更する行にチェックを入れてください', true); return; }
    attempt(async () => {
      const res = await call('updateWorkspaces', { ids, patch });
      toast(`${res.count} 件の${label}を変更しました${res.cookieSession ? '（Cookie を入れ替えてページを読み込み直しました）' : ''}`);
    });
  }

  allCheck.addEventListener('change', () => {
    const all = ctx.getData().state?.workspaceOrder || [];
    if (allCheck.checked) for (const id of all) selected.add(id); else selected.clear();
    for (const cb of list.querySelectorAll('.mg-row input[type=checkbox]')) cb.checked = allCheck.checked;
    syncBulk();
  });

  /** 件数表示・一括変更の有効 / 無効・行の選択色 */
  function syncBulk() {
    const n = targets().length;
    const total = ctx.getData().state?.workspaceOrder.length || 0;
    count.textContent = n ? `${n} 件を選択中` : 'チェックした行に下の一括変更を適用します';
    allCheck.checked = total > 0 && n === total;
    allCheck.indeterminate = n > 0 && n < total;
    for (const el of bulk.querySelectorAll('button, select, input')) el.disabled = !n;
    for (const row of list.querySelectorAll('.mg-row')) row.classList.toggle('sel', !!row.querySelector('input[type=checkbox]')?.checked);
  }

  function row(ws, index) {
    const { state, bindings } = ctx.getData();
    const windowId = ctx.getWindowId();
    const here = windowId != null && bindings[windowId] === ws.id;
    const openIn = windowOf(bindings, ws.id);
    const save = (patch) => attempt(() => call('updateWorkspace', { id: ws.id, patch }));

    const grip = h('span', { class: 'mg-grip', title: 'ドラッグで並び替え' }, '⋮⋮');
    const check = h('input', { type: 'checkbox', checked: selected.has(ws.id), title: '一括変更の対象にする' });
    check.addEventListener('change', () => {
      if (check.checked) selected.add(ws.id); else selected.delete(ws.id);
      syncBulk();
    });
    const look = h('button', {
      type: 'button', class: 'icon mg-look', title: '色・アイコンを変更',
      onclick: () => { expandId = expandId === ws.id ? null : ws.id; render(true); },
    }, wsIcon(ws), h('span', { class: 'muted small' }, expandId === ws.id ? '▲' : '▼'));
    const name = h('input', { type: 'text', class: 'mg-name', value: ws.name, title: '名前（Enter または他へ移動で保存）' });
    name.addEventListener('change', () => {
      const v = name.value.trim();
      if (!v) { name.value = ws.name; return; }
      save({ name: v });
    });
    const session = h('select', { class: 'mg-session', title: '使うセッション' }, state.sessionOrder.map((id) =>
      h('option', { value: id, selected: id === ws.sessionId }, state.sessions[id].name)));
    session.addEventListener('change', () => {
      session.blur();
      attempt(async () => {
        const res = await call('updateWorkspace', { id: ws.id, patch: { sessionId: session.value } });
        if (res?.cookieSession) toast(`「${ws.name}」のセッションを変え、Cookie を入れ替えてページを読み込み直しました`);
      });
    });
    const ac = autoCloseControls(state.settings, ws, { onSave: (autoClose) => save({ autoClose }) });
    const status = here ? h('span', { class: 'badge here', title: 'このウィンドウで開いています' }, 'ここ')
      : openIn != null ? h('span', { class: 'badge', title: '別のウィンドウで開いています' }, '開いている') : null;
    const del = confirmButton('削除', '本当に削除？', () => attempt(async () => {
      await call('deleteWorkspace', { id: ws.id });
      selected.delete(ws.id);
      toast(`「${ws.name}」を削除しました（ブックマークフォルダは残っています）`);
    }), { class: 'danger icon', title: '削除（ブックマークフォルダは残ります）' });

    const el = h('div', { class: `mg-row${selected.has(ws.id) ? ' sel' : ''}` },
      grip, check,
      h('span', { class: 'badge hotkey', title: '管理パネルの一覧での番号' }, workspaceHotkey(index) || String(index + 1)),
      look, name, session, ac.box,
      h('span', { class: 'muted small mg-tabs', title: '保存されているタブ数' }, `${ws.tabs.length} タブ`),
      status, del,
    );
    makeWorkspaceDraggable(el, ws.id, { handle: grip });
    makeWorkspaceDropTarget(el, ws.id, { getOrder: () => ctx.getData().state?.workspaceOrder });
    if (expandId !== ws.id) return [el];

    const colors = h('div', { class: 'colors' }, COLORS.map((c) => h('span', {
      class: 'dot' + (c === ws.color ? ' sel' : ''), title: c, style: { background: COLOR_HEX[c] },
      onclick: () => save({ color: c }),
    })));
    const icon = iconPicker(ws.icon, (v) => save({ icon: v }));
    return [el, h('div', { class: 'mg-expand' },
      h('div', { class: 'row' }, h('span', { class: 'edit-label' }, '色'), colors),
      h('div', { class: 'row' }, h('span', { class: 'edit-label' }, 'アイコン'), icon),
    )];
  }

  function render(force = false) {
    const { state } = ctx.getData();
    if (!state) return;
    if (!force && editingIn(root)) { pending = true; return; }
    pending = false;
    for (const id of [...selected]) if (!state.workspaces[id]) selected.delete(id);
    if (expandId && !state.workspaces[expandId]) expandId = null;
    // 一括変更のセッション候補（選択中の値は保つ）
    const keep = bulkSession.value;
    bulkSession.replaceChildren(h('option', { value: '' }, 'セッションを選択…'),
      ...state.sessionOrder.map((id) => h('option', { value: id }, state.sessions[id].name)));
    bulkSession.value = state.sessions[keep] ? keep : '';
    // 自動クローズは入力中の値を保つため 1 度だけ作る
    if (!bulkAutoClose) {
      bulkAutoClose = autoCloseControls(state.settings, { autoClose: null }, { onSave: () => {}, blurOnChange: false });
      bulkAutoCloseSlot.replaceChildren(bulkAutoClose.box);
    }
    if (!state.workspaceOrder.length) list.replaceChildren(h('div', { class: 'empty' }, 'ワークスペースがありません。管理パネルの ＋ から作成してください。'));
    else list.replaceChildren(...state.workspaceOrder.flatMap((id, index) => row(state.workspaces[id], index)));
    syncBulk();
  }
  root.addEventListener('focusout', () => { if (pending) setTimeout(() => render(), 0); });
  return { render };
}

// ---- セッションの管理（追加・名前変更・削除・全て開く・Cookie の権限。issue #12） ----

/**
 * Cookie を分けるための権限（cookies + <all_urls>）を求める。ユーザー操作の直後に呼ぶこと。
 * 許可されたら「今 Chrome に入っている Cookie は windowId のワークスペースのセッションのもの」とサービスワーカーに伝える。
 * 既に許可済みなら何もしない。拒否されたら false。request(): 権限ダイアログの出し方（既定は permissions.request）
 */
export async function ensureCookiePermission({ getData, getWindowId, request = () => chrome.permissions.request(COOKIE_PERMISSION) }) {
  if (await chrome.permissions.contains(COOKIE_PERMISSION)) return true;
  const granted = await request();
  if (!granted) return false;
  const { state, bindings } = getData();
  const sessionId = state.workspaces[bindings[getWindowId()]]?.sessionId;
  const res = await call('grantCookieIsolation', { sessionId });
  if (res.adopted) toast(`今 Chrome に入っている Cookie はセッション「${state.sessions[res.cookieSessionId]?.name || ''}」のものとして扱います`);
  return true;
}

/**
 * セッションの管理を root の中に描く。ctx: { getData, getWindowId, request? }。
 * 戻り値の render() は非同期（Cookie の状態を取る）
 */
export function createSessionManager(root, ctx) {
  let pending = false;
  const note = h('div', { class: 'muted small grow' });
  const grantSlot = h('span');
  const list = h('div', { class: 'sess-list' });
  const nameInput = h('input', { type: 'text', class: 'grow', placeholder: '新しいセッション名（例: AWS 開発アカウント）', autocomplete: 'off' });
  const form = h('form', { class: 'row' }, nameInput, h('button', { type: 'submit' }, '追加'));
  root.replaceChildren(h('div', { class: 'row sess-cookie' }, note, grantSlot), list, form);

  const grantButton = () => h('button', {
    type: 'button', class: 'primary', title: 'Cookie を読み書きする権限（すべてのサイト）の確認が出ます',
    onclick: () => attempt(async () => {
      if (!(await ensureCookiePermission(ctx))) { toast('権限が許可されなかったため、Cookie は分かれません', true); return; }
      await render();
    }),
  }, '権限を許可する');

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) return;
    attempt(async () => {
      // セッションを分ける＝Cookie を分けるので、2 つ目以降のセッションを作る前に権限を求める（拒否されたら作らない）
      if (!(await ensureCookiePermission(ctx))) {
        toast('Cookie を読み書きする権限が許可されなかったため、セッションを追加しませんでした', true);
        return;
      }
      nameInput.value = '';
      await call('createSession', { name });
      toast(`セッション「${name}」を追加しました`);
    });
  });

  async function render() {
    const { state } = ctx.getData();
    if (!state) return;
    if (editingIn(root)) { pending = true; return; }
    pending = false;
    let cookie = null;
    try { cookie = await call('getCookieStatus', { live: false }); } catch { /* 表示だけなので無視 */ }
    const isolating = !!cookie?.permitted;
    const multi = state.sessionOrder.length > 1;
    note.textContent = isolating
      ? `別のセッションのワークスペースに切り替えると、Cookie（ログイン状態）をそのセッションのものに入れ替えます（全ウィンドウに及びます）。今 Chrome に入っている Cookie: 「${state.sessions[cookie.cookieSessionId]?.name || '不明'}」`
      : (multi
        ? 'Cookie を読み書きする権限が許可されていないため、今はセッション間で Cookie が分かれていません。「権限を許可する」で許可してください。'
        : 'セッションを追加すると、Cookie を読み書きする権限（すべてのサイト）の確認が出ます。許可すると、セッションごとにログイン状態が分かれます。');
    grantSlot.replaceChildren(cookie && !isolating && multi ? grantButton() : '');
    const cookieBadge = (id) => {
      if (!isolating) return null;
      if (id === cookie.cookieSessionId) return h('span', { class: 'badge here', title: '今 Chrome に入っている Cookie はこのセッションのものです' }, '🍪 今の Cookie');
      const jar = cookie.jars[id];
      return h('span', { class: 'muted small', title: jar ? `退避した Cookie: ${jar.count} 件（${new Date(jar.savedAt).toLocaleString()}）` : '退避した Cookie はありません（切り替えると未ログインの状態から始まります）' },
        jar ? `🍪 ${jar.count}` : '🍪 なし');
    };
    list.replaceChildren(...state.sessionOrder.map((id) => {
      const s = state.sessions[id];
      const users = workspacesUsingSession(state, id);
      const name = h('input', { type: 'text', value: s.name, title: '名前を変更（Enter または他へ移動で保存）' });
      name.addEventListener('change', () => attempt(() => call('renameSession', { id, name: name.value })));
      return h('div', { class: 'sess-row' },
        name,
        cookieBadge(id),
        h('span', { class: 'muted small', title: users.map((w) => state.workspaces[w].name).join('\n') || 'このセッションを使うワークスペースはありません' },
          `${users.length} WS`),
        h('button', {
          type: 'button', disabled: !users.length, title: 'このセッションを使う全ワークスペースをそれぞれ別ウィンドウで開く',
          onclick: () => attempt(async () => {
            const wid = await call('openSessionWindows', { sessionId: id });
            if (wid != null) await chrome.windows.update(wid, { focused: true }).catch(() => {});
          }),
        }, '全て開く'),
        confirmButton('削除', '本当に削除？', () => attempt(async () => {
          const res = await call('deleteSession', { id });
          toast(res?.cookieSession
            ? `削除しました（Cookie をセッション「${res.cookieSession.toName}」に入れ替え、ワークスペースも付け替えました）`
            : '削除しました（使っていたワークスペースは別のセッションに付け替えました）');
        }), { disabled: state.sessionOrder.length <= 1, title: state.sessionOrder.length <= 1 ? '最後のセッションは削除できません' : (isolating ? '削除（ワークスペースは消えません。退避した Cookie は消えます）' : '削除（ワークスペースは消えません）') }),
      );
    }));
  }
  root.addEventListener('focusout', () => { if (pending) setTimeout(() => attempt(render), 0); });
  return { render };
}

// ---- 閉じたタブ（自動クローズで閉じたタブの履歴。issue #18） ----

function entryRow({ url, title, sub, extra, onOpen, onClose, closeTitle }) {
  return h('div', { class: 'entry', title: url || '', onclick: () => onOpen && attempt(onOpen) },
    url ? fav(url) : null,
    h('span', { class: 'title ellipsis' }, title || url || '（無題）'),
    sub ? h('span', { class: 'host muted small ellipsis' }, sub) : null,
    extra || null,
    onClose ? h('button', {
      class: 'icon close', type: 'button', title: closeTitle,
      onclick: (e) => { e.stopPropagation(); attempt(onClose); },
    }, '×') : null,
  );
}

/** URL を 1 件開く。wsId のワークスペースが開いているウィンドウがあればそこで、無ければ windowId で。同じ URL のタブがあればそれを前面に */
async function openUrlIn(url, wsId, bindings, windowId) {
  const wid = (wsId ? windowOf(bindings, wsId) : null) ?? windowId;
  const tabs = await chrome.tabs.query({ windowId: wid });
  const want = normalizeUrlForMatch(url);
  const existing = tabs.find((t) => normalizeUrlForMatch(t.url || t.pendingUrl || '') === want);
  if (existing) await chrome.tabs.update(existing.id, { active: true });
  else await chrome.tabs.create({ windowId: wid, url, active: true });
  await chrome.windows.update(wid, { focused: true }).catch(() => {});
}

/**
 * 閉じたタブの一覧を root の中に描く。ctx: { getData, getWindowId }。
 * 戻り値の render(list) に storage.local の closedTabs（新しい順）を渡す
 */
export function createClosedTabsView(root, ctx) {
  let items = [];
  const search = h('input', { type: 'search', class: 'grow', placeholder: 'タイトル・URL で絞り込み', autocomplete: 'off' });
  const clearBtn = confirmButton('すべて削除', '本当に削除？', () => attempt(async () => {
    await call('clearClosedTabs');
    toast('閉じたタブの履歴を削除しました');
  }), { title: '閉じたタブの履歴をすべて削除' });
  const list = h('div', { class: 'closed-list' });
  root.replaceChildren(
    h('div', { class: 'muted small' }, `自動クローズで閉じたタブです。最大 ${CLOSED_TABS_MAX} 件（古いものから消えます）。行をクリックすると、そのワークスペースのウィンドウ（開いていなければこのウィンドウ）で開き直します。`),
    h('div', { class: 'row' }, search, clearBtn),
    list,
  );
  search.addEventListener('input', () => draw());

  /** 履歴から 1 件を開き直す。開けたら履歴から消す（開くのに失敗したら残す） */
  const reopen = async (entry) => {
    await openUrlIn(entry.url, entry.workspaceId, ctx.getData().bindings, ctx.getWindowId());
    await call('removeClosedTab', { id: entry.id });
  };

  function draw() {
    clearBtn.disabled = !items.length;
    const { state } = ctx.getData();
    const q = search.value;
    const shown = items.filter((e) => matchesQuery(`${e.title || ''} ${e.url || ''}`, q));
    if (!shown.length) {
      list.replaceChildren(h('div', { class: 'empty' }, items.length ? '一致する閉じたタブはありません' : '自動で閉じたタブはありません'));
      return;
    }
    const now = Date.now();
    const nodes = [];
    let label = null;
    for (const e of shown) {
      const l = closedDayLabel(e.closedAt, now);
      if (l !== label) {
        label = l;
        nodes.push(h('div', { class: 'group-label' }, l));
      }
      const wsName = state?.workspaces[e.workspaceId]?.name || e.workspaceName;
      nodes.push(entryRow({
        url: e.url,
        title: e.title,
        sub: hostOf(e.url),
        extra: [
          wsName ? h('span', { class: 'ws-session', title: `ワークスペース: ${wsName}` }, wsName) : null,
          h('span', { class: 'time muted small', title: new Date(e.closedAt).toLocaleString() }, formatClockTime(e.closedAt)),
        ],
        onOpen: () => reopen(e),
        onClose: () => call('removeClosedTab', { id: e.id }),
        closeTitle: '履歴から削除',
      }));
    }
    list.replaceChildren(...nodes);
  }

  return { render(next) { items = Array.isArray(next) ? next : []; draw(); } };
}
