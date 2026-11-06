# seiton — Chrome Web Store listing

Draft listing text and permission explanations. Update this file before copying to the store dashboard.

- Name: seiton (matches manifest).
- Listing and UI: English and Japanese.
- Screenshots: store/screenshots/ (_en / _ja), 1280×800.
- Icon: icons/icon128.png.
- Privacy: [privacy-policy.md](privacy-policy.md).
- Distribution: public, all regions, free.

## English

### Summary (manifest description, 132 characters max)

```
Organize tabs and bookmarks into workspaces and switch fast. Also login-session switching, cross-browser sync, and tab auto-close.
```

### Detailed description

```
seiton is a tab manager that groups your tabs and bookmarks into "workspaces" — one per project, client, or topic — so you only keep open what you need right now.

The interface supports English and Japanese. Choose Automatic (browser language), English, or Japanese under Settings & management > Display & behavior > Language.

■ Workspaces
- Save each workspace's tabs (URL, title, pinned state, tab groups) and switch with one click or a keyboard shortcut
- Windows and workspaces are matched again automatically after a browser restart
- "Park and switch" keeps the current tabs open as a collapsed tab group, so you don't lose half-filled forms
- Move selected tabs to another workspace in bulk

■ Bookmarks
- Link a bookmark folder to each workspace
- Bookmarks saved with Ctrl+D or Alt+Shift+D go straight into the current workspace's folder
- A "frequently opened" shelf for pages that don't deserve a bookmark

■ Quick palette (Alt+K)
- Incrementally search open tabs, workspace bookmarks, and workspaces — keyboard only
- The management panel can also search your browsing history, if you allow it

■ Sessions (switch login state)
- Choose which account each workspace uses (e.g. production, staging, personal)
- Only if you grant permission, seiton swaps site cookies when you switch, so you can move between logins. Other site storage such as localStorage is not separated, so some sites may not be fully isolated.
- Saved cookies are encrypted (AES-GCM) in your browser

■ Memory and tab hygiene
- Lazy loading: only the front tab loads when a workspace opens
- Optional auto-close for tabs you haven't used for a while (off by default, with an exclusion list). Closed tabs can be reopened from history.

■ Sync
- Continue on another computer via Chrome's extension sync (chrome.storage.sync)
- No sign-up and no server of our own

■ Privacy
- Data stays in your browser unless you enable sync. With sync enabled, Google's Chrome Sync stores saved tab URLs/titles and workspace, session, and settings data under your Google account. Saved cookies, browsing-history search results, and auto-closed tab history are not synced. Nothing is sent to developer-operated servers.
- No ads, analytics, or tracking.

Shortcuts (customizable at chrome://extensions/shortcuts)
- Alt+K: Quick palette
- Alt+Shift+K: Management panel
- Alt+Shift+D: Bookmark the current tab into the workspace folder
- Alt+Shift+N: Next workspace
```

### Single purpose

```
seiton saves and switches between "workspaces" — each a set of tabs, a bookmark folder, and the login account used for that work. Cookie swapping switches the account tied to a workspace; sync, auto-close, and search exist only to save and organize workspaces.
```

### Permission justification

| Permission | Justification |
|---|---|
| tabs | To save each workspace's tabs (URL, title, pinned, active) and reopen them on switch, and to list/search open tabs in the quick palette. |
| tabGroups | To save and restore tab groups, and to collapse tabs into a group when the user chooses "Park and switch". |
| storage | To store workspaces, sessions, settings and closed-tab history locally (chrome.storage.local), and to sync them via chrome.storage.sync only when the user turns sync on. |
| unlimitedStorage | Cookies saved per session (several MB each) and many workspaces can exceed the default 10 MB local quota. Data stays in the browser. |
| bookmarks | To create/link a bookmark folder per workspace, move bookmarks the user saves into that folder, and list/search them. |
| alarms | To run optional auto-close and memory release periodically, and to batch sync writes. |
| favicon | To show icons for saved tabs and bookmarks without storing favicon images. |
| history (optional) | Requested only when the user clicks "Allow" in the management panel's search results to include browsing history (title/URL). History is read only at search time and is never stored or sent. It can be revoked from the settings page. |
| cookies (optional) | Requested only when the user adds a second session, after an in-extension consent dialog that explains what is stored, where, and how to delete it. Used to save the current cookies and restore the target session's cookies when switching workspaces. Saved cookies are encrypted (AES-GCM) and stored only in the browser, never transmitted. |
| `<all_urls>` host (optional) | Requested together with cookies, only for the session feature. Saving and restoring login cookies requires access to every site the user is signed in to. The extension does not read page content or inject scripts. |

## 日本語

### 概要（manifest の description。132 文字以内）

```
タブとブックマークをワークスペース単位で整理・切り替え。ログイン状態のセッション切替、ブラウザ間同期、使っていないタブの自動クローズにも対応。
```

### 詳細説明

```
seiton は、作業ごとに「ワークスペース」を作り、タブとブックマークをまとめて切り替えられるタブ管理ツールです。仕事・案件・調べもの……と、文脈ごとにタブを分けて、必要なものだけを開いた状態で作業できます。

■ ワークスペース
・作業ごとにタブ構成（URL・タイトル・固定・タブグループ）を保存し、ワンクリック / ショートカットで切り替え
・ブラウザを再起動しても、ウィンドウとワークスペースの対応を自動で復元
・入力途中のページを残したいときは「休止して切替」で、タブを閉じずに折りたたんだタブグループとして残せます
・タブを別のワークスペースへまとめて移動

■ ブックマーク連携
・ワークスペースごとにブックマークフォルダを接続
・Ctrl+D や Alt+Shift+D で保存したブックマークは、今のワークスペースのフォルダへ自動で整理
・ブックマークするほどではないページは「よく開くタブ」置き場へ

■ クイックパレット（Alt+K）
・開いているタブ、接続フォルダのブックマーク、ワークスペースをキーボードだけでインクリメンタル検索・切り替え
・管理パネルの検索では、権限を許可した場合に Chrome の閲覧履歴も検索できます

■ セッション（ログイン状態の切り替え）
・ワークスペースごとに「どのアカウントで使うか」を選べます（例：本番用・開発用・個人用）
・許可した場合のみ、切り替え時にサイトの Cookie を入れ替えてログイン状態を切り替えます（localStorage などは分けないため、サイトによっては完全には分離されません）
・退避した Cookie は AES-GCM で暗号化してブラウザ内に保存します

■ メモリとタブの整理
・遅延読み込みで、ワークスペースを開くときは前面のタブだけを読み込み
・一定期間使っていないタブの自動クローズ（既定 OFF・除外 URL 指定可）。閉じたタブは履歴から開き直せます

■ 同期
・Chrome アカウントの拡張機能同期（chrome.storage.sync）を使って、別の PC でもワークスペースを再開できます
・独自サーバーやアカウント登録は不要です

■ プライバシー
・データはすべてお使いのブラウザ内（およびご自身の Chrome 同期ストレージ）に保存され、開発者のサーバーへ送信されることはありません
・広告・解析・トラッキングは一切行いません

ショートカット（chrome://extensions/shortcuts で変更可）
・Alt+K：クイックパレット
・Alt+Shift+K：管理パネル
・Alt+Shift+D：現在のタブをワークスペースのフォルダにブックマーク
・Alt+Shift+N：次のワークスペースへ
```

### カテゴリ

仕事効率化（ツール / ワークフローと計画）

### 単一用途（Single purpose）

```
作業ごとの「ワークスペース」（タブ構成・ブックマークフォルダ・そのワークスペースで使うログインアカウントの組）を保存し、ワークスペース間を切り替えるタブ管理ツールです。Cookie の入れ替えはワークスペースに紐づくアカウントを切り替えるため、同期・自動クローズ・検索はワークスペースの保存・整理のための機能です。
```

### 権限の理由（Permission justification）

| 権限 | 説明 |
|---|---|
| tabs | ワークスペースのタブ構成（URL・タイトル・固定状態・前面のタブ）を保存し、切り替え時にタブを閉じて開き直すため、またクイックパレットで開いているタブを一覧・検索するために使用します。 |
| tabGroups | タブグループの構成を保存・復元するため、および「休止して切替」でタブを折りたたんだタブグループにまとめるために使用します。 |
| storage | ワークスペース・セッション・設定・閉じたタブの履歴をブラウザ内（chrome.storage.local）に保存し、ユーザーが同期を ON にした場合は chrome.storage.sync で他の端末と同期するために使用します。 |
| unlimitedStorage | セッション機能で退避する Cookie（1 セッションあたり数 MB になることがあります）と多数のワークスペースのタブ構成を保存すると、chrome.storage.local の既定容量（10 MB）を超える場合があるため使用します。データはブラウザ内にのみ保存されます。 |
| bookmarks | ワークスペースごとにブックマークフォルダを接続・作成し、ユーザーが保存したブックマークを接続フォルダへ移動するため、およびフォルダ内のブックマークを一覧・検索するために使用します。 |
| alarms | 「使っていないタブの自動クローズ」「自動メモリ解放」を一定間隔で実行するため、および同期の書き込みをまとめるタイマーとして使用します。 |
| favicon | 管理パネルやクイックパレットで、保存済みタブ・ブックマークのアイコンを表示するために使用します（favicon 画像を保存しないで済むため）。 |
| history（任意権限） | 管理パネルの検索ボックスで閲覧履歴も検索したいユーザーが「権限を許可する」を押したときにのみ要求します。ワークスペースのタブ・ブックマークに加えて閲覧履歴をタイトル・URL で検索するために使用し、履歴は検索時に読み取るだけで、保存・送信はしません。設定画面からいつでも取り消せます。 |
| cookies（任意権限） | ユーザーが 2 つ目のセッションを追加したときにのみ、保存内容・場所・削除方法を示す同意ダイアログの後で要求します。退避した Cookie は AES-GCM で暗号化して保存します。ワークスペースごとにログイン状態を分ける「セッション」機能で、切り替え時に現在の Cookie を退避し、切替先セッションの Cookie を復元するために使用します。Cookie はブラウザ内にのみ保存され、外部へ送信しません。 |
| ホスト権限 `<all_urls>`（任意権限） | cookies 権限と同時に、セッション機能を使うときにのみ要求します。ユーザーがログインしているすべてのサイトの Cookie を退避・復元するには全サイトへのアクセスが必要なためです。ページの内容を読み取ったり、スクリプトを挿入したりすることはありません。 |

### リモートコード

使用していない（外部スクリプトの読み込み・eval なし。fetch による外部通信もなし）。

### データの使用（Data usage）

| カテゴリ | 申告 | 理由 |
|---|---|---|
| 認証情報 | あり | セッション機能で Cookie を退避・復元（任意機能） |
| ウェブ履歴 | あり | タブの URL・タイトルを保存、閲覧履歴を検索（任意権限） |
| その他（個人を特定できる情報 / 健康 / 財務 / 通信 / 位置 / アクティビティ / サイトの内容） | なし | 扱わない |

認証項目: 第三者への販売・転送なし、目的外の使用なし、信用力判断・融資目的の使用なし。
