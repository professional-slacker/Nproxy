# nproxy Rust版 開発計画

このドキュメントは、nproxy Rust版のコードレビュー結果と、今後の実装計画をまとめたものです。

## 1. コードレビューサマリ (2026-05-09)

`main.rs`, `relay.rs`, `child.rs` を中心にレビューを実施。
総じて、Rust/tokioの機能を活かしたクリーンで堅牢な実装であり、Node.js版の設計思想が正しく継承されていることを確認した。

### 1.1 全体的な評価

- **Good**:
  - `clap`によるCLI引数解析、`tracing`によるデバッグログ機構が適切に実装されている。
  - `tokio`の非同期タスク(`spawn`, `select!`, `signal`)が効果的に利用されており、並行処理が明確に分離されている。
  - `Arc<Mutex<T>>`によるObserverの共有など、Rustの所有権モデルに基づいた正しい共有状態の扱いができている。
  - 設計原則（Chunk非保持、Backpressure委譲）が`relay.rs`のシンプルな`read`/`write`ループで達成されている。
  - モジュール分割が適切で、各モジュールの責務が明確である。

### 1.2 改善提案

- **エラーハンドリングの強化:**
  - `main.rs`内の`.expect()`や`.unwrap()`を`match`や`Result`を返す形にリファクタリングし、panicを避けてより丁寧なエラーメッセージを出すようにする。
- **シグナルハンドラの堅牢性向上:**
  - `child.id()`が`None`を返した場合にログを出力し、デバッグを容易にする。
- **終了処理の洗練:**
  - `std::process::exit()`を直接呼ぶ代わりに、`main`関数から`Result`を返す形式にすることで、`Drop`トレイトの実行を保証し、よりRustらしい終了処理にする。
- **`relay.rs`のロジック:**
  - `spawn_stdin_relay`内の`shutdown()`呼び出しは不要の可能性があるため、挙動を確認して削除を検討する。

---

## 2. 実装計画

レビュー結果を踏まえ、Node.js版の機能に追いつき、それを超えるための実装計画を以下に定める。

### フェーズ1: TextDecode 機能の実装 (コアロジック)

**目標:** Node.js版と同等のテキストデコード機能の基盤を実装する。

1.  **`text.rs`の改修:**
    - `TextDecode`構造体に、実際のデコード処理ロジックを追加する。
    - `tokio_util::codec::Decoder`を参考に、チャンク境界でマルチバイト文字が分断されても正しくデコードできる状態を持つデコーダを実装する。
    - まずは`passthrough`モード（UTF-8デコード -> UTF-8エンコード）を実装する。

2.  **`relay.rs`と`main.rs`の連携:**
    - `relay`関数を改修し、`TextMode`に応じて`TextDecode`処理をパイプラインに挟み込めるようにする。
    - ジェネリクスやトレイトオブジェクト(`dyn AsyncRead`)を活用し、`TextDecode`層の有無を柔軟に切り替えられる設計を目指す。

3.  **`transform`モードと`tee`モードの実装:**
    - `transform`モード: デコードされた文字列に行番号やタイムスタンプを付与するロジックを追加する。
    - `tee`モード: デコードされた文字列を、標準出力と指定されたログファイルの両方に書き出すロジックを実装する。CLI引数でログファイルパスを受け取れるように`main.rs`も修正する。

### フェーズ2: メモリポリシーとの連携

**目標:** TextDecode処理をメモリ状態に応じて動的に制御する機能を実装する。

1.  **`memory.rs`と`text.rs`の連携:**
    - `MemoryPolicy`の状態(`MemState`)が変化したことを`TextDecode`層に通知する仕組みを実装する（例: `tokio::sync::watch`チャンネル）。
    - `TextDecode`側では、メモリ状態に応じて`transform` -> `passthrough` -> `off`へと処理を動的に縮退させるロジックを実装する。

2.  **`main.rs`でのセットアップ:**
    - `main`関数内で、`MemoryPolicy`と`TextDecode`の連携をセットアップするコードを追加する。

### フェーズ3: 品質向上 (テストとビルド) ✅ 完了 (2026-05-10)

#### 完了項目

以下の項目を2026-05-10に確認・完了した。

- **buildエラー修正:**
  - `main.rs`の`?`演算子問題（`main`が`ExitCode`を返す関数で`signal()`が`?`を使っていた）→ `match`による明示的なエラーハンドリングに修正。
  - `child.rs`テストの型不一致（`&["hello"]`は`&[&str]`だが関数は`&[String]`を期待）→ `&["hello".to_string()]`に修正。
- **`cargo build`:** 成功
- **`cargo test`:** 48 tests all pass (0 failed)
- **`cargo build --release`:** 成功
- **`cargo-llvm-cov` カバレッジ計測:**
  - 全体カバレッジ: 77.27% (main.rs除く実質 ~90%)
  - observer.rs: 97.33%
  - text.rs: 88.43%
  - relay.rs: 84.24%
  - child.rs: 82.61%
  - memory.rs: 66.45%
  - main.rs: 0.00% (CLIエントリポイントのためテスト実行時未カバー)

**目標:** コードの信頼性と実用性を高める。

1.  **ユニットテストの作成:**
    - `text.rs`: チャンク境界でのUTF-8破壊が起きないかなど、デコードロジックを重点的にテストする。 ✅
    - `memory.rs`: 状態遷移ロジックをテストする。 ✅
    - `child.rs`: エラーケーステストを追加（nonexistent command, exit code確認）。 ✅
    - `relay.rs`: 5つの非同期リレーテストを追加（basic/empty/spawn/text_relay）。 ✅
    - 合計48テスト、全件パス確認 (2026-05-10, 1.91s)。 ✅
    - コードカバレッジの計測を導入する。（任意）

2.  **リリースビルドの最適化:**
    - `Cargo.toml`にリリースビルド用の最適化設定（`lto = "fat"`, `codegen-units = 1`, `strip = "symbols"`）を追加。 ✅

3.  **エラーハンドリングの強化:**
    - `main.rs`: `std::process::exit()` → `ExitCode` 返却に変更。 `.expect()`/`.unwrap()` の本番コード使用を排除。 ✅
    - シグナルハンドラ: `kill_child` は失敗時にログ出力のみ行う。 ✅
