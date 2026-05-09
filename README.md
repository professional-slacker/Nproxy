# nproxy — Node.js Runtime I/O Proxy

> **nproxy はランタイム I/O プロキシである。**
> **制御コードは解釈せず透過し、シグナルは中継する。**
> **プロトコルや意味付けは nproxy の外側で行う。**

```
node nproxy.js [--text=MODE] app.js [args...]
```

---

## 確定設計原則 (Charter)

この三文が nproxy の責務境界を定義する。実装変更は必ずこの原則に従う。
詳細は [`08_principles.md`](./08_principles.md) を参照。
レビュー時のチェックは [`REVIEW_CHECKLIST.md`](./REVIEW_CHECKLIST.md) を使う。

### 短文版 (この一文を覚える)

> **nproxy はランタイム I/O プロキシである。**
> **制御コードは解釈せず透過し、シグナルは中継する。**
> **プロトコルや意味付けは nproxy の外側で行う。**

### 技術者向け版

> nproxy は stdin/stdout/stderr を byte stream として調停する。
> 制御コード・バイナリを含む I/O を改変せずに透過し、
> OS レベルの backpressure とシグナル伝播を保持する。
> プロトコル層・text 解釈・意味付けは責務外とする。

---

## レイヤ整理

```
┌─────────────────────────────────────────┐
│          OS / TTY / Filesystem          │
└────────────────────┬────────────────────┘
                     ↓ syscall / poll
┌─────────────────────────────────────────┐
│                 nproxy                  │  ← ここが本リポジトリの責務範囲
│   - stream passthrough                  │
│   - backpressure 委譲                   │
│   - signal 中継                         │
│   - chunk 観測 (meta only)              │
│   - memory policy (NORMAL/PRESSURE/CRIT)│
└────────────────────┬────────────────────┘
                     ↓ stdin/stdout/stderr
┌─────────────────────────────────────────┐
│      outer protocol / client            │  ← nproxy の外。別パッケージ・別言語可
│   - framing (length-prefix, NDJSON)     │
│   - metadata (filename, mimetype)       │
│   - text / binary 解釈                  │
│   - AI / API / UX                       │
└─────────────────────────────────────────┘
```

**nproxy は中央にいながら意味を持たない。** だからこそ 10GB でも、制御コードでも、ファイル添付でも壊れない。

---

## 三原則の確定文

### ① 制御コードはそのまま流す

ANSI escape / 改行 / CR / BS / BEL / バイナリ混在 / 0x03 等の制御バイトを
**一切解釈・改変せず byte stream として透過する**。

- nproxy はターミナルエミュレータではない
- text 層 ON 時も、UTF-8 境界保護のみ。ESC は触らない
- 「何もしない」ことで最も安全を得る設計

### ② シグナルは中継する

SIGINT / SIGTERM / SIGHUP / SIGPIPE / SIGWINCH を親で握りつぶさず、子へ伝播させる。

- nproxy は「境界」だが「遮断器」ではない
- 制御権は奪わない (Ctrl+C は普通に効く)
- CI / shell script の期待動作と衝突しない

### ③ プロトコル層は nproxy の外側で組む

message framing / metadata (filename, mimetype, size) / text 解釈 / AI 用プロトコルは
**nproxy の責務外**。outer (ask CLI / client / service) で行う。

- nproxy は「運ぶ層」、プロトコルは「意味を与える層」
- これにより nproxy は用途を問わず再利用可能なランタイム I/O になる

---

## 派生する技術原則 (上記から導かれる)

### ⓐ chunk 非保持 (No Chunk Retention)

chunk (Buffer / Bytes) は passthrough する瞬間以外メモリに留めない。
観測は size / ts / kind のメタ情報のみ。
これを破った瞬間、ランタイムを問わず OOM が起きる。

### ⓑ backpressure 委譲 (Delegate to OS-level)

自前でバッファを積まない。OS poll (libuv / epoll / IOCP / kqueue) の
「読まない → カーネル pipe に詰まる → 上流 blocking」機構に乗る。
JS なら `pipe()` のみ。`data` イベントは使わない。

### ⓒ policy は副作用の縮退のみ

入出力の本流は絶対に止めない／拒否しない。
メモリ圧力に応じて変化させてよいのは観測の解像度・ring buffer・text mode などの **副作用** のみ。

| state | byte 層 | text 層 |
|---|---|---|
| NORMAL | 詳細ログ + ring 1024 件 | text-on-by-config |
| PRESSURE | サマリ + ring 128 件 | text-AUTO-OFF (重い変換は停止) |
| CRITICAL | 観測停止 + ring 0 件 | text-完全OFF |

**どの状態でも passthrough は続く**。

## ファイル構成

```
result/
├─ README.md                    ← このファイル
├─ 08_principles.md             ★ 確定設計原則 (Charter)
├─ REVIEW_CHECKLIST.md          ★ コードレビュー時のチェックリスト
├─ nproxy.js                    ← プロトタイプ実装 (byte層 + Text I/O層)
├─ run_tests.js                 ← 6ケース機能テストランナー
├─ run_limit_test.js            ← Node 限界テストランナー (1/5/10GB)
├─ run_text_tests.js            ← Text I/O テストランナー (9ケース)
├─ test_apps/
│  ├─ app_echo.js
│  ├─ app_big_stdout.js
│  ├─ app_ansi.js
│  ├─ app_fs_huge.js
│  ├─ app_stderr_mix.js
│  ├─ app_text_ascii.js         ← Text層用 ASCII 大量出力
│  ├─ app_text_utf8.js          ← Text層用 UTF-8 マルチバイト
│  └─ app_text_boundary.js      ← chunk境界破壊検知用
├─ 01_investigation.md          ← Node ソース解析 (V8/libuv stream/IO)
├─ 02_overview_design.md        ← byte層 概要設計
├─ 03_detailed_design.md        ← byte層 詳細設計
├─ 04_node_limit_report.md      ← Node 限界レポート (10GB透過)
├─ 05_rust_mvp_plan.md          ← Rust MVP 方針書
├─ 06_text_io_design.md         ← Text I/O 層 設計書
├─ 07_text_io_results.md        ← Text I/O 層 結果レポート
├─ report.html                  ← 単一HTMLレポート (全Phase統合)
├─ test_results.json            ← 機能テスト結果
├─ text_test_results.json       ← Text I/Oテスト結果
└─ tmp/                         ← 各テストの入出力 + ログ
```

---

## クイックスタート

### 機能テスト (6 ケース)

```sh
cd result
node run_tests.js
```

### 限界テスト

```sh
node run_limit_test.js 1024     # 1GB
node run_limit_test.js 5120     # 5GB
node run_limit_test.js 10240    # 10GB
```

### 単独実行 + デバッグログ

```sh
set NPROXY_DEBUG=1
set NPROXY_LOG=.\nproxy.debug.log
node nproxy.js test_apps/app_big_stdout.js 200
```

---

## 環境変数

| 変数 | 既定値 | 意味 |
|---|---|---|
| `NPROXY_DEBUG` | (off) | `1` で debug log 出力 |
| `NPROXY_LOG` | `./nproxy.debug.log` | ログ出力先 |
| `NPROXY_PRESSURE_MB` | `80` | NORMAL → PRESSURE 閾値 (heapUsed) |
| `NPROXY_CRITICAL_MB` | `200` | PRESSURE → CRITICAL 閾値 |
| `NPROXY_RING_NORMAL` | `1024` | NORMAL 時 ring サイズ |
| `NPROXY_RING_PRESSURE` | `128` | PRESSURE 時 ring サイズ |
| `NPROXY_TICK_MS` | `500` | memory polling 周期 |

---

## ベースライン実測値 (Win11 / Node v12.9.1)

| サイズ | 所要 | スループット | heap (avg) | 状態遷移 |
|---:|---:|---:|---:|:---:|
| 1 GB stdout | 1.78s | 576 MB/s | 2.3 MB | NORMAL のみ |
| 5 GB stdout | 6.11s | 837 MB/s | 2.5 MB | NORMAL のみ |
| 10 GB stdout | 9.87s | 1037 MB/s | 2.6 MB | NORMAL のみ |

**heap がデータサイズに対してフラット**であることが、3 原則が守られている直接的な証拠。

---


---

## Text I/O 層

byte 層に加え、UTF-8 string decode を行う Text I/O 層を統合。3 モード切替＋メモリ自動連動。

`sh
node nproxy.js --text=passthrough app.js   # decode してそのまま流す
node nproxy.js --text=transform   app.js   # decode + 行頭にタイムスタンプ/行番号
node nproxy.js --text=tee --text-log=./out.log app.js   # decode + ログファイルtee
`

### Text 層ベースライン

| サイズ | mode | 所要 | スループット | heap (max) |
|---:|---|---:|---:|---:|
| 10GB ASCII | passthrough | 16.2 s | 633 MB/s | 19.4 MB |
| 10GB UTF-8 | passthrough | 50.9 s | 201 MB/s | 18.8 MB |
| 100MB ASCII | transform | 6.2 s | 16 MB/s | 22.2 MB |

### メモリ自動連動

| Policy state | text=transform 要求時の実適用 |
|---|---|
| NORMAL | transform |
| PRESSURE | passthrough に自動縮退 |
| CRITICAL | off に強制 |

### 設計原則 3 点との整合 (Text 層でも維持)

- **chunk 非保持**: string オブジェクトは push 直後に参照を切る。StringDecoder の保留は固定 kSize
- **backpressure 委譲**: Transform の push() 戻り値で内部キューが backpressure を伝搬
- **policy は副作用の縮退のみ**: text 加工自体を「重い副作用」と再定義し、PRESSURE で自動 OFF

詳細は [ 6_text_io_design.md](./06_text_io_design.md) と [ 7_text_io_results.md](./07_text_io_results.md) を参照。
## 後続実装への引き継ぎ

Rust / Go / Zig など他言語で再実装する場合の **絶対要件**:

1. **`tokio::io::copy` 相当の I/O プリミティブで本流を組む**
   （std::io::copy、io.Copy、splice 等）
2. **読み込みハンドラに「データを持つフィールド」を作らない**
3. **policy はサイドカー的に動かす**。本流ループに条件分岐を埋め込まない

詳細は [`05_rust_mvp_plan.md`](./05_rust_mvp_plan.md) を参照。

---

## ライセンス / 担当

- 担当: SVF開発部 サステインメンバー
- 用途: 社内 PoC / 設計検証
