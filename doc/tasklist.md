# Tasklist: Rust MVP 実装

> 実装前に `01_investigation.md` 〜 `08_principles.md` および `README.md`、`REVIEW_CHECKLIST.md` をすべて読むこと。
> 各タスク完了時には変更ファイル一覧とレビューチェックリスト (Q1-Q5) のセルフチェックを通すこと。

## Phase0: プロジェクト初期化

- [ ] #7 Rust プロジェクト初期化と依存関係設定
  - `rs/` に `cargo init`、`Cargo.toml` に tokio / bytes / clap / tracing 追加
  - `nproxy.js` の Cargo.toml 相当の依存一覧を確認して過不足なく

## Phase1: コア構造

- [ ] #1 CLI 引数パース (clap)
  - `nproxy <cmd> [args...]` 形式
  - `--text=MODE` (off/passthrough/transform/tee)
  - 環境変数 NPROXY_DEBUG / NPROXY_PRESSURE_MB / NPROXY_CRITICAL_MB / NPROXY_TICK_MS
- [ ] #9 デバッグログ (tracing)
  - NPROXY_DEBUG 有効時のみ tracing subscriber 初期化
  - NORMAL/PRESSURE/CRITICAL の状態変化をログ

## Phase2: 子プロセス管理

- [ ] #2 子プロセス起動・stdio pipe 接続
  - tokio::process::Command で spawn
  - stdin/stdout/stderr を pipe で取得
  - exit code 伝播

## Phase3: バイト層透過

- [ ] #8 Observer + RingMetaBuffer
  - 各 chunk の size/ts/kind を記録
  - リングバッファ (max N 件、設定可能)
- [ ] #3 stdin/stdout/stderr 透過 + 観測ラッパ
  - tokio::io::copy または wrapper で中継
  - Observer 経由でメタ情報を収集
- [ ] #4 MemoryPolicy (NORMAL/PRESSURE/CRITICAL)
  - /proc/self/status VmRSS または psutil 相当で RSS 取得
  - tick 間隔で監視、state 遷移 (NORMAL→PRESSURE→CRITICAL)
  - 学習モード (最初の 5 tick で baseline 取得)
- [ ] #6 シグナル中継 (SIGINT/SIGTERM)
  - tokio::signal で捕捉 → 子へ転送
  - 子の exit code / signal を親が継承

## Phase4: Text I/O 層 (JS 版と同様)

- [ ] TextDecode (StringDecoder 相当)
  - passthrough transform tee の3モード
  - メモリポリシー連動 (PRESSURE→passthrough縮退、CRITICAL→off)

## Phase5: テスト

- [ ] #5 Node 版テストスイートとの互換テスト
  - run_tests.js 相当のケース (6ケース + 限界テスト)
  - run_text_tests.js 相当のケース (9ケース)
  - レビューチェックリスト Q1-Q5 全 Yes 確認
