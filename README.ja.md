# nproxy — Runtime I/O Proxy

> **nproxy はランタイム I/O プロキシである。**
> **制御コードは解釈せず透過し、シグナルは中継する。**
> **プロトコルや意味付けは nproxy の外側で行う。**

```
node -r ./node/nproxy.js app.js          # Node preload mode
cargo run -- command [args...]            # Rust CLI mode
```

---

## 絶対要件 (Must)

この 3 点は言語・実装を問わず nproxy の根幹を定義する。
**これらが動かなければ実装失敗。** コードレビュー時のチェックリスト。

### ① chunk 非保持 (No Chunk Retention)

chunk (Buffer / bytes) は passthrough する瞬間以外メモリに留めない。
観測は size / ts / kind のメタ情報のみ。

| 違反時に起きる現象 |
|---|
| OOM（即時 / 緩慢） |

- Rust: `tokio::io::copy` / `copy_buf` で OS バッファに任せる
- Node: `pipe()` のみ。`data` イベントで自前バッファに保持しない
- Go: `io.Copy` / `io.CopyBuffer` でゼロアロケーション

### ② backpressure 委譲 (Delegate to OS-level)

自前でバッファを積まない。OS poll の「読まない → カーネル pipe buffer に詰まる → 上流 blocking」機構に乗る。

| 違反時に起きる現象 |
|---|
| flowing-mode 固定で機構破壊 → OOM か stall |

- **読むのを止める = 子の write をブロック** が唯一の正しい backpressure
- `Poll::Pending` (Rust) / `ReadStop` (Node libuv) / 単に read しない (Go)
- バッファリングは OS の役割。nproxy はバッファしない

### ③ policy は副作用の縮退のみ (Policy Reduces Side-effects Only)

本流 (passthrough) は絶対に止めない／拒否しない。
縮退するのは観測解像度・ring buffer・text mode などの副作用のみ。

| 違反時に起きる現象 |
|---|
| 「拒否しない／止めない」要件違反。プロキシの存在意義が消える |

| state | byte 層 | text 層 |
|---|---|---|
| NORMAL | 詳細観測 + ring 1024 件 | text-on-by-config |
| PRESSURE | サマリ観測 + ring 128 件 + text-AUTO-OFF | 重い変換は停止 |
| CRITICAL | 観測停止 + ring 0 件 + text-完全OFF + **ReadGate closed** | backpressure で子を抑制 |

**どの状態でも passthrough の本流は動き続ける。**
CRITICAL でも ReadGate で読み出しを止めるのは backpressure の本流動作であって遮断ではない。
子が write をブロックされても nproxy は「読み出せる状態を待っている」だけ。

---

## 実装

### Node — preload mode (`-r`)

```bash
node -r ./node/nproxy.js my-app.js

# 環境変数
NPROXY_TEXT=passthrough|transform|strip-ansi   # text 処理モード (default: passthrough)
NPROXY_MONITOR=0                               # 0=off, カンマ区切り閾値 (default: 256,512,1024,1280)
NPROXY_DEBUG=1                                 # chunk 分割ログ/デバッグ出力 (default: off)
NPROXY_MEMLOG=60                               # 定期メモリログ (秒, 0=OFF)
```

- `process.stdout.write` フック + メモリ監視による自動 mode 縮退
- **256KB チャンク分割** — 256KB 超の write は自動分割
- **5段階メモリガード**: monitoring → attention(256MB) → pressure(512MB) → critical(1024MB) → emergency(1280MB)
  - pressure: 自動 strip-ansi 切替、チャンクサイズ 64KB に縮小
  - critical: チャンクサイズ 4KB、緊急モード
  - emergency: coalesce バイパス、即時書き出し
- **V8 NearHeapLimitCallback C++ addon** (`node/nheap_limit/`) — V8 OOM 直前に発動、emergency 状態へ強制遷移
- coalescing でフレームレート低下防止（Ink 等の対話型CLI向け）
- attention (黄) / pressure (赤) / critical (青) / emergency (マゼンタ) の色付き stderr フィードバック
- 起動時 `◈ nproxy memory guard active` バナーを最初の出力直下に注入
- cursor show/hide (`?25h`/`?25l`) は transform/strip-ansi でも保持
- Windows: 未定義シグナルを try/catch でガード
- **alias の注意**: `~` ではなく `$HOME` を使うこと（シングルクォート内の `~` は展開されない場合がある）

### Rust — CLI relay

```bash
cargo run --release -- command [args...]
cargo run --release -- --text=strip-ansi -- command [args...]
```

- `tokio::process::Command` + `AsyncRead`/`AsyncWrite` relay
- `ReadGate` による poll 停止ベースの backpressure
- `/proc/<child_pid>/status` RSS 監視 → watch channel → relay へ通知
- TextPipeline: passthrough / strip-ansi / transform + 自動縮退

---

## 設計原則対応表 (言語横断)

| 設計思想 | Node 実装 | Rust 実装 | 共通の根 |
|---|---|---|---|
| chunk 非保持 | `pipe()` のみ | `tokio::io::copy` / `copy_buf` | OS バッファに任せる |
| backpressure | libuv ReadStop/ReadStart | Tokio AsyncRead poll → `Poll::Pending` | OS poll 停止/再開 |
| policy 縮退 | JS state + setInterval | `MemoryPolicy` + watch channel | 状態は副作用のみ |
| chunk = 最小単位 | Buffer (V8 ArrayBuffer) | `Bytes`/`BytesMut` | OS ページ単位 |
| ランタイム I/O | libuv | epoll / kqueue / IOCP | 各 OS poll API |

---

## Rust で解放される領域

| 機能 | OS API | 意味 |
|---|---|---|
| zero-copy pipe→pipe | `splice(2)` (Linux) | 観測不要時、コピーゼロで中継 |
| zero-copy file→socket | `sendfile(2)` | CPU 1% 未満で大容量転送 |
| pipe 分岐 | `tee(2)` | ログ取りに最適 |
| バッチ I/O | `io_uring` (Linux 5.1+) | 高スループット低レイテンシ |
| pty 完全制御 | `posix_openpt` 等 | TTY raw mode / SIGWINCH 中継 |
| cgroup / rlimit | cgroup v2 | 子メモリ上限引き下げ（kill 不要） |
| シグナル順序保証 | `signalfd` / kqueue | SIGCHLD と SIGTERM 競合解消 |

---

## 構成

```
.
├── node/           Node.js preload mode 実装
│   └── nproxy.js
├── rs/             Rust CLI relay 実装
│   ├── src/
│   │   ├── main.rs
│   │   ├── relay.rs       ← ReadGate + spawn_relay/spawn_text_relay
│   │   ├── memory.rs      ← /proc/<pid>/status RSS 監視
│   │   ├── text.rs        ← TextPipeline + 状態縮退
│   │   ├── observer.rs    ← メタ観測（ring buffer / size / ts）
│   │   └── child.rs       ← 子プロセス spawn + signal relay
│   ├── tests/
│   └── Cargo.toml
├── result/         旧 Node プロトタイプ一式
├── doc/            設計ドキュメント
├── README.md       ← English
└── README.ja.md    ← 日本語 (このファイル)
```

---

## ライセンス & 支援

nproxy は GPL 3.0 のフリーソフトウェアです。
役に立ったと思ったら、任意の暗号通貨支援をお願いします 🙏

```
Bitcoin:  bc1q096t3sc9mndnu94guxcwjqpg7c5qcdv3gf0e0g
ETH:      0x1b9b7911585189c526d7740ce6c5e1c94c78aa84
USDT:     0x1b9b7911585189c526d7740ce6c5e1c94c78aa84
**手数料の関係で最低 $20 以上推奨**
```

商用ライセンスに関するお問い合わせ（プロプライエタリ利用、OEM 組み込み、カスタム開発）:
→ **nproxy@proton.me**
USDT  :   0x1b9b7911585189c526d7740ce6c5e1c94c78aa84
※ウォレットの事情で$20以上から受け付けてます 🙏
```

---

## コードレビューチェックリスト

ファイル [`REVIEW_CHECKLIST.md`](./REVIEW_CHECKLIST.md) を参照。
レビュー時は以下の観点でチェックする:

- [ ] chunk 非保持 — chunk をフィールド/クロージャに保持していないか
- [ ] backpressure 委譲 — `Poll::Pending` / `ReadStop` / read しない、で止めているか
- [ ] policy 縮退のみ — 本流の停止/拒否が発生していないか
