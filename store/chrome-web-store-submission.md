# seiton — Chrome Web Store 申請情報（v1.0.1）

- 作成日: 2026-10-27
- 対象パッケージ: `dist/seiton-v1.0.1.zip`（manifest.json / _locales / src / icons のみ同梱）
- 公開範囲: 一般公開（Public）
- 掲載者: Yu Kiyota / サポート連絡先: （省略）
- プライバシーポリシー: [removed] に掲載（本文は `privacy-policy.md`）

参照（公式）:
- ストア掲載情報: https://developer.chrome.com/docs/webstore/cws-dashboard-listing
- プライバシー タブ: https://developer.chrome.com/docs/webstore/cws-dashboard-privacy
- ユーザーデータ FAQ: https://developer.chrome.com/docs/webstore/user_data/
- プログラムポリシー: https://developer.chrome.com/docs/webstore/program-policies/policies

---

## 0. 申請前に直したほうがよい点（審査リスク）

| # | 内容 | リスク | 推奨対応 |
|---|---|---|---|
| 1 | manifest の `description` と `src/ui/guide.html` に「Workona」（他社製品名）が入っている | 他社名での集客は Keyword spam / なりすまし系ポリシーで指摘されやすい | **対応済み（v1.0.1）**: manifest / package.json / README / guide.html から他社名を削除し、manifest の description は下記「概要」に差し替え |
| 2 | 退避した Cookie（ログイン情報）を `chrome.storage.local` に**平文**保存している（README「既知の制限」に記載） | ユーザーデータ FAQ #9 は保存時に「RSA や AES などの強い暗号化」を求めている。認証情報は最も厳しく見られる | **対応済み（v1.0.1）**: `src/lib/vault.js` で AES-GCM 256 bit 暗号化、鍵は IndexedDB `seiton-vault` の書き出せない CryptoKey、暗号文は storage.local に Base64。旧版の平文は起動時に暗号化へ置き換え。セッション追加・権限の再許可の前に、何を・どこに保存し・どう消せるかを示す同意ダイアログ（`manage.js` の `cookieConsentDialog`）を出し、同意後に permissions.request する |
| 3 | 任意権限 `optional_host_permissions: <all_urls>` と `cookies` | 広いホスト権限は詳細審査（in-depth review）の対象になり、審査が長引きやすい | 下記の権限説明を具体的に書く。機能上必要なのでそのまま申請で可 |
| 4 | `history` 権限（管理パネルの検索で閲覧履歴も検索するためだけに使用） | 必須権限のため「閲覧履歴を読む」警告がインストール時に出る。最小権限の原則で指摘されうる | **対応済み（v1.0.1）**: `optional_permissions` へ移動。管理パネルの検索結果の「閲覧履歴」に「権限を許可する」を出し、押したときだけ要求。設定・管理の「表示・操作」で取り消し可。インストール時の警告から「閲覧履歴」が消える |

| 5 | `unlimitedStorage` | storage.local の上限は Chrome 114 以降 10MB（本拡張は 121 以上）。不要権限とみなされうる | **維持（v1.0.1）**: 退避 Cookie は 1 セッションあたり数 MB になりうる（一般的なプロファイルの Cookie 3,000〜5,000 件 × JSON 約 350 バイト ≒ 1〜1.75 MB、暗号化 + Base64 で約 1.3 倍）。セッションが 4〜5 個で 10 MB を超えるため、権限の説明にその理由を書いて申請する。unlimitedStorage はインストール時の警告を出さない権限 |

> #1・#2 は申請前に必須、#4・#5 は推奨、#3 は説明で対応可能という判断です。v1.0.1 で #1・#2・#4 を対応し、#5 は理由付きで維持、#3 は説明で対応。

---

## 1. ストア掲載情報（Store listing）

### 名前
`seiton`
（任意で「seiton - ワークスペースでタブとブックマークを整理」のように補足を付けても可。manifest の `name` と一致させる）

### 概要（manifest の description、132 文字以内）
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

### カテゴリ / 言語
- カテゴリ: 仕事効率化（Productivity）系から「ツール」または「ワークフローと計画」を選択（ダッシュボードの選択肢に合わせる）
- 言語: 日本語

### 画像素材
| 素材 | 仕様 | 状況 |
|---|---|---|
| ストアアイコン（必須） | 128×128 PNG | `icons/icon128.png` を使用可（128×128 確認済み） |
| スクリーンショット（必須） | 1280×800、1〜5 枚 | `store/screenshots/` に作成済み（サンプルデータで撮影）。アップロード推奨順: 01 管理パネル → 02 クイックパレット → 04 横断検索 → 03 ワークスペース一覧 → 05 自動クローズ。06 セッションは「権限未許可」の警告と「平文」の文言が出るため**使わない**。英語ロケールには `_en` 版（02 のみキャプション英語、他は日本語と同一） |
| 小プロモタイル（任意） | 440×280 PNG/JPEG | 未作成（`icons/logo.png` 256×256 を元に作成可） |
| マーキー（任意） | 1400×560 | 不要 |

### URL
- ホームページ URL: [removed] 内の seiton 紹介ページ（作成する場合）
- サポート URL: 問い合わせフォーム or 公開用アドレス（個人メールが公開されるため support@ 等の別名を推奨）
- 公式 URL: [removed] を Google Search Console で所有確認すると選択可能

### 成人向けコンテンツ: OFF

---

## 2. プライバシー（Privacy practices）

### 単一用途（Single purpose）
```
作業ごとの「ワークスペース」（タブ構成・ブックマークフォルダ・そのワークスペースで使うログインアカウントの組）を保存し、ワークスペース間を切り替えるタブ管理ツールです。Cookie の入れ替えはワークスペースに紐づくアカウントを切り替えるため、同期・自動クローズ・検索はワークスペースの保存・整理のための機能です。
```

### 権限の理由（Permission justification）

| 権限 | 説明文（そのまま貼り付け可） |
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
| ホスト権限 <all_urls>（任意権限） | cookies 権限と同時に、セッション機能を使うときにのみ要求します。ユーザーがログインしているすべてのサイトの Cookie を退避・復元するには全サイトへのアクセスが必要なためです。ページの内容を読み取ったり、スクリプトを挿入したりすることはありません。 |

### リモートコード
`いいえ、リモートコードを使用していません`（外部スクリプトの読み込み・eval なし。fetch による外部通信もなし）

### データの使用（Data usage）— チェックする項目
FAQ #3 により、ローカル保存のみでも「取り扱い」として開示が必要です。

| カテゴリ | チェック | 理由 |
|---|---|---|
| 個人を特定できる情報 | — | 扱わない |
| 健康情報 | — | 扱わない |
| 財務情報・支払い情報 | — | 扱わない |
| 認証情報 | ✔ | セッション機能で Cookie を退避・復元（任意機能） |
| 個人的な通信 | — | 扱わない |
| 位置情報 | — | 扱わない |
| ウェブ履歴 | ✔ | タブの URL・タイトルを保存、閲覧履歴を検索 |
| ユーザーのアクティビティ | — | クリック・キー入力等の記録はしない（タブの最終アクセス時刻はウェブ履歴の範囲として扱う。申請時にダッシュボードのツールチップで定義を確認） |
| ウェブサイトのコンテンツ | — | ページ内容は読まない |

認証項目（3 つすべてにチェック）:
- 承認されている用途以外で、ユーザーデータを第三者に販売、転送しない
- アイテムの唯一の目的と関係のない目的で、ユーザーデータを使用、転送しない
- 信用力を判断する目的または融資目的で、ユーザーデータを使用、転送しない

### プライバシーポリシー URL
[removed] 上の掲載 URL（例: `https://[removed]/seiton/privacy`）。本文は `privacy-policy.md`。

---

## 3. 配布（Distribution）
- 公開設定: 公開（Public）
- 地域: すべての地域（日本のみにする場合は日本を選択）
- 料金: 無料（アプリ内課金なし）

## 4. 申請手順チェックリスト
- [x] manifest / guide.html から Workona を削除（#1）→ version を 1.0.1 等に上げて `npm run zip`
- [x] Cookie 暗号化＋同意ダイアログを実装（#2）、history の optional 化（#4）。unlimitedStorage は理由付きで維持（#5）
- [x] `_locales/ja` `_locales/en` を追加し manifest を `__MSG_` 化（default_locale: en）→ 英語の掲載情報（第 5 節）を追加できる
- [ ] プライバシーポリシーを [removed] に掲載し URL を確定
- [x] スクリーンショット 1280×800 を作成（store/screenshots）
- [ ] デベロッパー ダッシュボード（https://chrome.google.com/webstore/devconsole）で新規アイテム → zip アップロード
- [ ] 掲載情報・プライバシー・配布を入力（本書をコピー）
- [ ] デベロッパーアカウントの連絡先メール確認・（企業として）販売者（トレーダー）区分の申告を確認（EU 配布時は住所・電話が公開される点に注意）
- [ ] 審査に提出

---

## 5. 英語の掲載情報（English listing）

### 前提: 多言語掲載には `_locales` が必要
ストアの掲載情報は「パッケージに含まれる `_locales/<言語コード>` ごと」にしか言語を追加できません（公式: https://developer.chrome.com/docs/webstore/cws-dashboard-listing ）。現状の seiton は `_locales` が無いため、英語の説明を載せるには次の変更が必要です。

- `_locales/en/messages.json` と `_locales/ja/messages.json` を追加（**v1.0.1 で追加済み**。元の案は `store/locales-proposal/_locales/`）
- manifest を `"name": "__MSG_extName__"`, `"description": "__MSG_extDescription__"`, `"default_locale": "<en または ja>"` に変更（参考: https://developer.chrome.com/docs/extensions/mv3/manifest/default_locale/ ）
- `default_locale` は、対応していない言語のユーザーに表示される言語。一般公開で海外ユーザーも想定するなら `en` が無難（**v1.0.1 は `en`**）
- **注意: 拡張の UI は日本語のみ**。英語の説明にその旨を明記しないと、機能の誤認（Misrepresentation）とみなされるおそれがある（下の英文には明記済み）

### Summary（manifest description / 132 文字以内、実測 130 文字）
```
Organize tabs and bookmarks into workspaces and switch fast. Also login-session switching, cross-browser sync, and tab auto-close.
```

### Detailed description
```
seiton is a tab manager that groups your tabs and bookmarks into "workspaces" — one per project, client, or topic — so you only keep open what you need right now.

Note: The user interface is currently available in Japanese only.

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
- All data stays in your browser (and your own Chrome sync storage). Nothing is sent to the developer's servers.
- No ads, analytics, or tracking.

Shortcuts (customizable at chrome://extensions/shortcuts)
- Alt+K: Quick palette
- Alt+Shift+K: Management panel
- Alt+Shift+D: Bookmark the current tab into the workspace folder
- Alt+Shift+N: Next workspace
```

### （任意）プライバシー タブの英語版
プライバシー タブの各欄は言語別に分けられない 1 つの入力欄。審査担当者向けに英語で書く例も多いので、日本語の代わりに使う場合の英文を載せる。

**Single purpose**
```
seiton saves and switches between "workspaces" — each a set of tabs, a bookmark folder, and the login account used for that work. Cookie swapping switches the account tied to a workspace; sync, auto-close, and search exist only to save and organize workspaces.
```

**Permission justification**

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
| <all_urls> host (optional) | Requested together with cookies, only for the session feature. Saving and restoring login cookies requires access to every site the user is signed in to. The extension does not read page content or inject scripts. |
