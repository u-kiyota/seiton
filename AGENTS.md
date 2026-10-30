# AGENTS.md — AI コーディングエージェント向けの案内

このファイルは、seiton のコードを AI エージェント（Claude Code / Codex / Copilot など）に触らせるときの前提をまとめたもの。人が読んでも役に立つように書いてある。製品としての説明は [README.md](README.md)、設計の詳細は [docs/](docs/) を見ること。

## プロジェクトの要点

- **何か**: ワークスペース単位でタブとブックマークを管理する Chrome 拡張（Manifest V3）。
- **ビルド無し**: ソースをそのまま `chrome://extensions` で読み込む。バンドラ・トランスパイラ・依存パッケージは無く、`package.json` の scripts は Node 標準機能だけで動く。
- **言語**: ソースのコメント・UI・ドキュメント・コミットメッセージはすべて日本語。識別子は英語。
- **実行環境**: Node 22 以上（CI も 22）。Chrome 121 以上（`minimum_chrome_version`）。
- **配布**: GitHub Release（タグ `v*` で zip を自動生成）と Chrome ウェブストア。

## 必ず実行するコマンド

```sh
npm test        # node --test。chrome API に依存しない純粋ロジックのユニットテスト
npm run check   # scripts/check.js。manifest の整合・参照ファイルの存在・JS の構文・import 名の解決・_locales の検証
```

変更を加えたら両方を通してからコミットする。CI（`.github/workflows/ci.yml`）も同じ 2 つを実行する。
`npm run zip` は配布用 zip を `dist/` に作る（Windows では PowerShell から実行すること。Git Bash だと zip 内のパス区切りが `\` になる）。

## ディレクトリ構成

```
manifest.json          拡張の定義。name / description は _locales の __MSG_*__
_locales/{en,ja}/      ストア掲載用の name / description（UI 本体の文言は日本語のハードコード）
src/background.js      サービスワーカー。Chrome のイベントと UI からのメッセージを処理する唯一の「状態を書き込む場所」
src/lib/core.js        chrome API に依存しない純粋ロジック（スナップショット化・URL 照合・並び替え・除外判定など）
src/lib/store.js       storage.local（永続）/ storage.session（ウィンドウ⇔ワークスペースの対応）と直列実行キュー
src/lib/workspace.js   切替・スナップショット・復元・セッション操作・起動時の対応付け
src/lib/*.js           機能ごとのモジュール（cookies / vault / sync / syncdoc / parked / autoclose / history / bookmarks / memory / wstab / indicator / draw / manager / access）
src/ui/                管理パネル（sidepanel）/ クイックパレット（popup）/ 設定・管理（options + manage）/ ワークスペースタブ（wstab）/ 使い方（guide）
src/ui/api.js          UI からサービスワーカーへ chrome.runtime.sendMessage する薄いラッパー
test/*.test.js         純粋ロジックのテスト。chrome API が要るものは偽物（fake）を差し替えて動かす
scripts/check.js       静的チェック
scripts/build-zip.js   配布用 zip の生成とタグ名の検証
store/                 Chrome ウェブストアの掲載文・プライバシーポリシー・スクリーンショット
docs/                  設計の詳細・手動テストのチェックリスト
```

## 設計上の約束

- **状態の書き込みは `background.js` だけ**。UI は `src/ui/api.js` 経由でメッセージを送り、結果を受け取って描画する。UI から直接 `chrome.storage` を書かない。
- **ロジックは `lib/core.js` などの純粋関数に寄せ、テストを書く**。chrome API に触る部分は薄く保つ。純粋ロジックを増やしたら `test/` に対応するテストを足す。
- **保存データの形を変えるときは移行を書く**。`chrome.storage.local` の `state` は古い版を読み込み時に移行している（`core.js` の正規化）。既存ユーザーのデータが壊れないようにする。同期ドキュメント（`syncdoc.js`）の版 `v` も同様。
- **権限は最小限**。必須権限を増やすと Chrome ウェブストアの再審査と、インストール時の警告が変わる。新しい権限が要るときは `optional_permissions` にして、使う直前に `chrome.permissions.request` する（`cookies` / `history` の実装を参考に）。
- **manifest の制約**: `commands` の `suggested_key` は 4 個まで。`_locales/*/messages.json` の `extDescription` は 132 文字以内（`npm run check` が検証する）。
- **外部通信をしない**。fetch で外部に送らない、リモートコードを読み込まない。プライバシーポリシーと掲載情報がそれを前提にしている。
- **他社製品名を書かない**。README・掲載文・コード・コメントに他のタブ管理拡張の名前を出さない（ストアの審査上の理由）。
- **UI の文言は日本語**。絵文字のボタン（✎ ⧉ ⏸ 🛡 など）は既存の使い方に合わせる。
- **Chrome のタブは隠せない**。切替は「保存して閉じ、開き直す」が基本で、例外が「休止」（折りたたんだタブグループに残す）。この前提を崩す変更は慎重に。

## ファイル編集の注意

- 作業ツリーのファイルは CRLF（`core.autocrlf=true`）。スクリプトで置換するときは改行を正規化して照合し、書き戻しは元の改行を保つ。
- 新しいファイルの先頭には、そのモジュールが何をするかを 1〜数行の日本語コメントで書く（既存ファイルの慣習）。
- `dist/` と `*.zip` は `.gitignore` 済み。生成物や作業メモ・引き継ぎファイルをリポジトリに入れない。

## 検証できないこと（実機確認）

自動テストは Chrome API に依存しない部分だけを対象にしている。ウィンドウ・タブ・Cookie・同期・休止など Chrome の実機でしか確かめられない変更は、[docs/manual-test-checklist.md](docs/manual-test-checklist.md) の該当項目で確認し、確認できなかった項目は「未検証」として PR に明記する。

## 開発の流れ

1. GitHub の issue を 1 つ選ぶ（`u-kiyota/seiton`）。
2. `main` からブランチ `feat/<issue 番号>-<短い英語>` を切る（同じファイルを触る issue は 1 つのブランチで順に進める）。
3. 実装 → `npm test` と `npm run check` → 日本語のコミットメッセージ（本文に `Closes #N`）。
4. PR を作り、CI を待ってから squash マージ。
5. リリースは `manifest.json` と `package.json` の version を上げ、`v<version>` のタグを push する（`.github/workflows/release.yml` が zip を Release に添付する。タグと version が違うと失敗する）。
