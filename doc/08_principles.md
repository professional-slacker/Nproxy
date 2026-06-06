# nproxy 確定設計原則 (Charter)

> このドキュメントは nproxy の **責務境界を一行で定義する強い宣言** である。
> 全ての他文書 (設計書・実装・テスト・Rust 移植計画) はこの原則に従う。

---

## 原則 (短文版・README 冒頭用)

> **nproxy はランタイム I/O プロキシである。**
> **制御コードは解釈せず透過し、シグナルは中継する。**
> **プロトコルや意味付けは nproxy の外側で行う。**

---

## 原則 (技術者向け版)

> nproxy は **stdin/stdout/stderr を byte stream として調停する**。
> 制御コード・バイナリを含む I/O を改変せずに透過し、
> OS レベルの backpressure とシグナル伝播を保持する。
> **プロトコル層・text 解釈・意味付けは責務外**とする。

---

## 三原則の確定文

### ① 制御コードはそのまま流す

| 対象 | 方針 |
|---|---|
| ANSI escape sequence (`\x1b[31m` 等) | 解釈しない / 改変しない |
| 改行 (`\n`)、CR (`\r`)、BS (`\x08`)、BEL (`\x07`) | 解釈しない / 改変しない |
| バイナリ混在 (画像/動画/PDF などのバイト列) | 解釈しない / 改変しない |
| stdin に流れる 0x03 (ETX) などの制御バイト | 解釈しない / 改変しない |

これは **「何もしない」ことで最も安全を得る設計**。
解釈し始めた時点で:

- chunk 非保持原則が破綻する
- TTY 実装に踏み入ることになる
- 無限 state を持つことになる

**nproxy はターミナルエミュレータではない。**

text 層を ON にした場合でも:

- UTF-8 境界は守る (StringDecoder の責務範囲)
- ESC sequence の **意味解釈はしない**
- 「壊さずに再出力」だけを保証する

### ② シグナルは中継する

| シグナル | 動作 |
|---|---|
| SIGINT (Ctrl+C) | 親で受け、子に転送 |
| SIGTERM | 親で受け、子に転送 |
| SIGHUP | 親で受け、子に転送 (POSIX) |
| SIGPIPE | 上流が閉じた → 子に SIGTERM 転送 (現実装) |
| SIGWINCH (端末サイズ変更) | 中継対象 (Rust MVP で対応予定) |

**nproxy は「境界」だが「遮断器」ではない**:

- 観測する
- ログを取る
- でも **制御権は奪わない**

ここを吸収すると:

- Ctrl+C が効かない (CLI 文化との衝突)
- 子プロセスが zombie 化
- CI / shell script が壊れる

### ③ プロトコル層は nproxy の外側で組む

これが**設計の芯**である。

| 責務 | 担当 |
|---|---|
| stream passthrough | **nproxy** |
| backpressure 委譲 | **nproxy** |
| signal 中継 | **nproxy** |
| chunk 観測 (size/ts のみ) | **nproxy** |
| memory policy 縮退 | **nproxy** |
| message framing (length-prefix / NDJSON / multipart) | **outer (nproxy の外)** |
| metadata (filename, mimetype, size, checksum) | **outer** |
| text / binary の意味解釈 | **outer** |
| AI / API / UX 層 | **outer** |

**nproxy は「運ぶ層」、プロトコルは「意味を与える層」。**

切り離す理由:

- プロトコルは仕様変更が頻発する
- 利用者ごとに違う (LLM, file transfer, JSON-RPC, gRPC...)
- nproxy に入れると chunk 非保持原則が壊れる
- string 前提が混入する
- OOM 保証が崩れる

CLI × ファイル添付の文脈での具体化:

| 層 | 振る舞い |
|---|---|
| nproxy | 質問文もファイルも **ただ流す** |
| ask CLI / client / service | 「これは prompt」「これは file」と境界と意味を定義する |

---

## レイヤ整理

```
┌─────────────────────────────────────────┐
│          OS / TTY / Filesystem          │
└────────────────────┬────────────────────┘
                     ↓ syscall / poll
┌─────────────────────────────────────────┐
│                 nproxy                  │
│   - stream passthrough                  │
│   - backpressure 委譲                   │
│   - signal 中継                         │
│   - chunk 観測 (meta only)              │
│   - memory policy (NORMAL/PRESSURE/CRIT)│
└────────────────────┬────────────────────┘
                     ↓ stdin/stdout/stderr
┌─────────────────────────────────────────┐
│      outer protocol / client            │
│   - framing (length-prefix, NDJSON)     │
│   - text / binary 解釈                  │
│   - metadata (filename, mimetype)       │
│   - AI / API / UX                       │
└─────────────────────────────────────────┘
```

**nproxy は中央にいながら意味を持たない。**
だからこそ:

- 10GB でも壊れない
- 制御コードでも壊れない
- ファイル添付でも壊れない

---

## 「やる / やらない」確定リスト

### nproxy が **やる** こと

- [x] stdin → child.stdin の byte stream 透過
- [x] child.stdout → parent.stdout の byte stream 透過
- [x] child.stderr → parent.stderr の byte stream 透過
- [x] OS pipe backpressure を活かす (`pipe()` のみ使い、`data` イベントは使わない)
- [x] chunk のメタ観測 (size / ts / kind) のみ
- [x] memoryUsage 監視 + policy 状態遷移
- [x] policy 連動の副作用縮退 (ring 縮退、hex preview 無効化、text 縮退)
- [x] 任意モードの text decode (off/passthrough/transform/tee) ※破壊しない範囲で
- [x] SIGINT/SIGTERM/SIGHUP の child への転送
- [x] graceful exit (子stdio close後、stdout/stderr flush 待ち)

### nproxy が **やらない** こと

- [ ] ANSI escape sequence の解釈・書換
- [ ] TTY raw mode 制御
- [ ] message framing (NDJSON, length-prefix, multipart 等)
- [ ] filename / mimetype / size / checksum の付与・検証
- [ ] text/binary 種別の判別 (与えられたモードで処理するのみ)
- [ ] サイズ上限の強制 (観測はしてもよいが本流は止めない)
- [ ] 子プロセスの fs / net I/O のフック
- [ ] 認証・暗号化・圧縮
- [ ] retry / リコネクト
- [ ] ログのローテーション (debug log は append のみ)

---

## 原則がもたらす保証

| 保証 | 根拠 |
|---|---|
| 10GB byte 透過で OOM しない | 原則① + chunk 非保持 |
| 10GB UTF-8 透過でも heap ≤ 19MB | 原則① + StringDecoder の固定 kSize 保留 |
| 制御コードで挙動が変わらない | 原則① の「解釈しない」 |
| Ctrl+C が普通に効く | 原則② の中継 |
| プロトコル変更で nproxy を直さない | 原則③ の外部化 |
| Rust / Go / Zig 移植が直線的 | 原則① ② ③ が言語非依存 |

---

## レビュー時の3点チェック (cowork 実装レビュー用)

実装変更の度に以下3点を確認する。**1つでもNoなら設計違反**。

### Q1. 制御コードはそのまま流れているか
- [ ] ANSI escape を解釈・書換していないか
- [ ] バイナリ混在 chunk を破壊していないか
- [ ] text 層 ON 時も UTF-8 境界保護のみで、ESC は触っていないか

### Q2. シグナルは中継されているか
- [ ] SIGINT を親で握りつぶしていないか
- [ ] 子の終了ステータスを親が継承しているか
- [ ] zombie プロセスを残さないか

### Q3. プロトコル意味付けが nproxy 内に漏れ込んでいないか
- [ ] message framing コードが入り込んでいないか
- [ ] filename / mimetype / JSON 解釈が混入していないか
- [ ] サイズ上限を nproxy が **強制** していないか (観測はOK)
- [ ] string化を伴う「意味を持つ処理」が byte 層に混じっていないか

詳細チェックリストは [`REVIEW_CHECKLIST.md`](./REVIEW_CHECKLIST.md) を参照。

---

## 言語横断アンカー (Rust / Go / Zig 等の移植時)

この原則は実装言語に依存しない。各言語へ移植する際は以下の対応で原則①②③を満たす:

| 原則 | Node 実装 | Rust 実装 | 共通の根 |
|---|---|---|---|
| ① 制御コード透過 | `pipe()` のみ。data イベント不使用 | `tokio::io::copy` / `copy_buf` | OS バッファに任せる |
| ② シグナル中継 | `process.on('SIGINT')` → `child.kill('SIGINT')` | `tokio::signal` → `child.kill().await` | OS signal API |
| ③ プロトコル外部化 | message framing コード一切なし | `tokio_util::codec` を使わない選択 | 「運ぶ」と「意味づける」の分離 |

---

## 原則の不変性

この三原則は:

- 機能追加で **書き換えない**
- バグ修正で **緩めない**
- 性能最適化で **崩さない**

緩めたい誘惑が出たときは、そもそも nproxy の責務外である可能性が高い。
新機能はまず**外側 (outer)** に置けないかを検討する。

---

---

## 開発プロセスの原則 (根本対策の定義)

アプリケーションをインストールし初期設定の段階で「意図しない動作」が起こること自体を
防げなければ根本的な対策とは言えない。
マニュアルや外部の仕組みによる改善は、技術的な理由によりアプリケーションの修正が
できない場合の妥協策または暫定対処にすぎない。

### 本プロジェクトへの適用

| レベル | 例 | 判定 |
|---|---|---|
| 根本対策 | 実装着手前に全機に自動通知が飛ぶ仕組み | ✅ アプリケーション自体が防ぐ |
| 妥協策 | README.md に「合意を得てから実装する」と追記 | ❌ 読まなければ意味がない |
| 暫定対処 | 各機に口頭で注意する | ❌ 属人的で持続しない |

### 判断基準

実装や設計の提案を行う際は、これが「根本対策」か「妥協策」かを明確に区別し、
根本対策が技術的に可能であればそちらを優先する。
妥協策で済ませる場合は、なぜ根本対策が採用できないかを説明すること。

## 改訂履歴

| 日付 | 内容 |
|---|---|
| 2026-06-06 | 開発プロセスの原則（根本対策の定義）を追加 |
| 2026-05-08 | 初版確定。Phase1〜10 の検証を経て三原則を成文化 |
