# OpenClaude 許可ポリシー
- リポジトリのコミットauthorは必ず `professional-slacker <professional-slacker@users.noreply.github.com>` を使用すること。
- コミット時は `-c user.name=professional-slacker -c user.email=professional-slacker@users.noreply.github.com` を git コマンドに付与するか、事前に git config を設定してからコミットすること。

## 基本方針
- 拒否リストに記載されていないすべての操作を自動許可
- セキュリティを損なわない範囲で最大限の自動化を許可
カレントにvenvがあれば以下を実施すること
source venv/bin/activate

## 自動許可される操作

### Git 操作
- `git add` - ファイルのステージング
- `git commit` - コミット作成
- `git push` - リモートへのプッシュ
- `git status`, `git diff`, `git log` - 状態確認
- `git branch`, `git checkout` - ブランチ操作

### ファイル操作
- ファイルの読み書き（Read/Write/Edit）
- ファイルの作成と削除（プロジェクト関連ファイル）
- ディレクトリ操作
- カレントディレクトリに対するあらゆるbashの許可
-Nproxyディレクトリに関連するあらゆるコマンド実行の許可

### ビルドと実行
- コンパイル（g++, gcc, makeなど）
- プログラムの実行とテスト
- バックグラウンドプロセスの起動

### システムコマンド
- ファイル検索（find, locate）
- テキスト処理（grep, sed, awk）
- プロセス管理（ps, kill）
- パッケージ管理（apt, dpkg）※システム変更は注意

## 拒否リスト（実行しない操作）

### 危険なシステム操作
- `rm -rf /` または同等の広範囲削除
- `dd` によるディスク破壊的操作
- `chmod 777 -R /` などの広範囲な権限変更
- システムファイルの直接編集（/etc/, /boot/など）

### セキュリティリスク
- パスワードや認証情報のハードコーディング
- 外部への機密データ送信
- 未承認のネットワークアクセス

### プロジェクト外の操作
- ホームディレクトリ外の不要な操作
- 他のプロジェクトへの干渉
- /tmp配下であれば操作しても良い

## 注意事項
以下確認する場合は作業を止めなければならない場合のみ確認すること
止めなくても良い場合は作業メモに記述すること
1. 新しい外部ツールのインストールは確認を求める
2. 大規模なシステム変更は事前確認
3. バックアップのない破壊的操作は禁止

## このプロジェクトのコンテキスト
- NProxyIO開発と保守
- テストとデバッグの自動化
- ドキュメンテーションの更新
- バージョン管理とリリース

---

## Behavioral Guidelines

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
