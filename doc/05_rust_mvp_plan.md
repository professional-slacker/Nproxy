# Rust MVP 方針書: 同思想を下層で再証明する

> ## 確定設計原則の継承 (変更不可)
>
> Rust 実装は [`08_principles.md`](./08_principles.md) の三原則に **完全準拠** する。
> Rust になっても以下は変わらない:
>
> 1. **制御コードはそのまま流す** — ANSI / バイナリ / 制御バイトを解釈しない
> 2. **シグナルは中継する** — SIGINT/SIGTERM/SIGWINCH を子へ転送
> 3. **プロトコル層は nproxy の外側で組む** — framing / metadata / 意味付けを Rust 実装内に入れない
>
> Rust への移植は性能改善と低レイヤ機能 (splice/sendfile/pty/cgroup) の解放のためであり、
> **設計境界の変更ではない**。レビューでは [`REVIEW_CHECKLIST.md`](./REVIEW_CHECKLIST.md) を使う。

## 1. 目的の再確認

Node 上の PoC で検証されたのは **「設計思想」**であり、**「Node の限界」**ではない。
Rust 実装の意図は次の通り:

| 動機 | 内容 |
|---|---|
| ① 思想の再現性検証 | 言語が変わっても同じ 3 原則で結果が再現するか |
| ② 観測解像度の向上 | GC のない世界で heap 動作をより精密に観測 |
| ③ 機能領域の拡大 | zero-copy / pty / cgroup / SIGPIPE 精密制御 |
| ④ プロダクション化 | nproxy を CLI ツールから「I/O ランタイム」へ昇格 |

これは **「Node では足りないから乗り換える」ではない**。
**「思想を最下層まで降ろす」フェーズ**である。

---

## 2. CLI 互換性

Node 版と同じ起動形を維持する。差し替えに摩擦を作らない。

```sh
# Node 版
node nproxy.js app.js [args...]

# Rust 版
nproxy node app.js [args...]
nproxy --                  # 任意コマンドも受け付ける
nproxy python script.py    # Node 専用ではなくする（拡張）
```

環境変数も同名で互換:

```
NPROXY_DEBUG=1
NPROXY_LOG=./nproxy.debug.log
NPROXY_PRESSURE_MB=80
NPROXY_CRITICAL_MB=200
NPROXY_TICK_MS=500
```

---

## 3. 設計原則の言語横断対応表（最重要）

| 設計思想 | Node 実装 | Rust 実装 | 共通の根 |
|---|---|---|---|
| chunk 非保持 | `pipe()` のみ。data イベント不使用 | `tokio::io::copy` / `tokio::io::copy_buf` | OS バッファに任せる |
| backpressure | libuv `ReadStop/ReadStart` | Tokio `AsyncRead`/`AsyncWrite` のpoll戻り値 | OS poll の停止/再開 |
| policy 縮退 | JS state object + setInterval | 軽量 `struct State` + `tokio::time::interval` | 状態は副作用にだけ作用 |
| chunk = 最小単位 | `Buffer` (V8 ArrayBuffer) | `Bytes` / `BytesMut` (zero-copy slice) | OSページ単位 |
| ランタイム I/O | Node + libuv | Tokio + epoll(Linux)/IOCP(Win)/kqueue(macOS) | 各OSのpoll API |

### 3.1 chunk 非保持の Rust 実装

```rust
// 本流（Node の pipe() に相当）
use tokio::io::{copy, AsyncRead, AsyncWrite};

let mut child_stdout = child.stdout.take().unwrap();
let mut parent_stdout = tokio::io::stdout();

tokio::spawn(async move {
    let _ = copy(&mut child_stdout, &mut parent_stdout).await;
});
```

これだけで、内部バッファは一時 `Vec<u8>` (8KB 既定) を **ローテートして使い回す**。
`Bytes` 型を使えば **ref-counted で zero-copy slice** ができる。

### 3.2 観測の Rust 実装

```rust
// chunk を 1 度も保持せず、size と ts だけ拾う
struct Meta { ts: Instant, kind: Kind, size: usize }

// AsyncRead/AsyncWrite を「観測ラッパ」で透明にラップする
struct Observed<S> { inner: S, kind: Kind, ring: Arc<Mutex<Ring<Meta>>> }

impl<S: AsyncRead + Unpin> AsyncRead for Observed<S> {
    fn poll_read(...) -> Poll<...> {
        let pre = buf.filled().len();
        let ret = Pin::new(&mut self.inner).poll_read(cx, buf);
        if let Poll::Ready(Ok(())) = &ret {
            let n = buf.filled().len() - pre;
            if n > 0 {
                self.ring.lock().push(Meta { ts: Instant::now(), kind: self.kind, size: n });
            }
        }
        ret
    }
}
```

この時点で **JS 版のセマンティクスを維持しつつ、構造体3つで実現**できる。

### 3.3 policy 縮退の Rust 実装

```rust
// 軽量 struct
#[derive(Clone, Copy, PartialEq)]
enum State { Normal, Pressure, Critical }

struct Policy {
    state: AtomicU8,
    pressure_mb: u64,
    critical_mb: u64,
}

// jemalloc / mimalloc から RSS を取る
fn evaluate() -> State {
    let rss = procfs::process::Process::myself()?.statm()?.resident * page_size();
    if rss >= CRITICAL { State::Critical }
    else if rss >= PRESSURE { State::Pressure }
    else { State::Normal }
}
```

---

## 4. Rust ならではの拡張領域

Node では実装が困難 / 不可能だった機能を解放する。

### 4.1 zero-copy I/O

| OS API | 用途 |
|---|---|
| `splice(2)` (Linux) | pipe ⇄ pipe / pipe ⇄ file をユーザ空間を介さず直接転送 |
| `sendfile(2)` (Linux/BSD) | file → socket のゼロコピー |
| `tee(2)` (Linux) | pipe を分岐（ログ取りに最適） |
| `io_uring` (Linux 5.1+) | バッチ submit / completion |
| `TransmitFile` (Windows) | sendfile 相当 |

これにより:
- **「観測のためのコピー」をゼロにできる**（`tee` で ring に流すだけ）
- **CPU 使用率が劇的に下がる**

### 4.2 pty 完全制御

Node の `child_process.spawn` は pty を直接扱えない（`node-pty` 等の C 拡張が必要）。
Rust なら `nix` クレートで `posix_openpt` / `grantpt` / `unlockpt` / `ptsname` を直接呼べる。

→ TTY raw mode、ターミナルサイズ追従、SIGWINCH 中継が **設計の中**に組み込める。

### 4.3 cgroup / rlimit 連携 (Linux)

```rust
// cgroup v2 で子プロセスのメモリ上限を強制
use nix::sys::resource::{setrlimit, Resource};
setrlimit(Resource::RLIMIT_AS, soft_limit, hard_limit)?;
```

policy が CRITICAL に入った時、**子プロセスを殺さずに**:
- メモリ上限を引き下げる
- CPU シェアを下げる
- pipe バッファサイズを縮める (`F_SETPIPE_SZ`)

### 4.4 SIGPIPE / SIGSTOP の精密制御

- Node は SIGPIPE を握りつぶすしかない
- Rust なら `signalfd` (Linux) / `kqueue EVFILT_SIGNAL` (BSD) で **キュー化して順序保証**できる
- SIGCHLD と SIGTERM の順序が保証されることで、子の exit と signal forwarding の競合を消せる

---

## 5. 実装スコープ（MVP）

「設計を下層で再証明する」のが目的なので、最初は **Node 版と機能等価** に絞る。

### 5.1 MVP に入れる

- [x] CLI: `nproxy <cmd> [args...]`
- [x] stdin/stdout/stderr の `tokio::io::copy` 透過
- [x] Observer (size/ts 観測、ring buffer)
- [x] Policy (NORMAL/PRESSURE/CRITICAL)
- [x] memoryUsage 相当 (`procfs` / Windows `GetProcessMemoryInfo`)
- [x] シグナル中継 (SIGINT/SIGTERM)
- [x] デバッグログ (NPROXY_DEBUG)
- [x] **Node と互換のテストスクリプトで PASS**

### 5.2 MVP に入れない（v2 以降）

- [ ] splice / sendfile によるゼロコピー
- [ ] pty 完全制御
- [ ] cgroup 連携
- [ ] io_uring 対応
- [ ] マルチ child（同時 spawn N 本）

---

## 6. 推奨クレート

| 用途 | クレート | 理由 |
|---|---|---|
| 非同期ランタイム | `tokio` | 業界標準、ecosystem が厚い |
| プロセス起動 | `tokio::process::Command` | tokio 統合 |
| I/O コピー | `tokio::io::copy` | 内部バッファ再利用、backpressure 対応 |
| zero-copy バイト | `bytes` (`Bytes`/`BytesMut`) | ref-counted slice |
| シグナル | `tokio::signal` (Unix) / `signal-hook` | クロスプラットフォーム |
| メモリ観測 (Linux) | `procfs` | /proc 簡潔アクセス |
| メモリ観測 (Win) | `windows` (Win32) または `sysinfo` | クロスプラットフォーム |
| エラー型 | `anyhow` (top-level) / `thiserror` (lib) | 慣用 |
| ログ | `tracing` + `tracing-subscriber` | 構造化、policy 状態を span にできる |
| CLI | `clap` v4 | derive で十分 |

---

## 7. ベンチ計画（Node との比較）

同一テストデータで比較する。

| ケース | Node 結果 (baseline) | Rust 期待 |
|---|---|---|
| 1GB stdout | 576 MB/s, heap 2.3MB | 1500 MB/s+, heap 0 (relevant) |
| 5GB stdout | 837 MB/s, heap 2.5MB | 2000 MB/s+, RSS フラット |
| 10GB stdout | 1037 MB/s, heap 2.6MB | I/O 速度律速 |
| splice 経由 1GB pipe→pipe | 該当なし | CPU 1% 未満 (新規評価軸) |

`run_limit_test.js` をそのまま流用できる。`NPROXY_BIN` 環境変数で Node 版 / Rust 版を
切り替える形にしておくのが綺麗。

---

## 8. リスクと対策

| リスク | 対策 |
|---|---|
| Tokio の単一スレッドランタイムで CPU 律速になる | `#[tokio::main(flavor = "multi_thread")]` を MVP から採用 |
| Windows IOCP と Linux epoll で挙動差 | CI でクロスビルド + 同テストを各 OS で走らせる |
| `tokio::io::copy` の内部 8KB バッファが大規模で非効率 | `copy_buf` で `BufReader::with_capacity(64*1024)` を渡す |
| シグナル順序の OS 差異 | `tokio::signal` の挙動を OS 別にユニットテスト化 |

---

## 9. 着地点（MVP 完了条件）

以下の **5 条件** を満たした時、Rust MVP は完了とみなす:

1. **Node と同じ 6 ケース**が全 PASS (機能テスト)
2. **5GB スループットが Node 同等以上** (837 MB/s 以上)
3. **3 状態遷移**が動作ログで確認できる (NORMAL/PRESSURE/CRITICAL)
4. **REVIEW_CHECKLIST の Q1〜Q5 すべて Yes** (確定原則の遵守)
5. **Text I/O 9 ケース** (10GB UTF-8 含む) が全 PASS

それを越えた段階で、ゼロコピー / pty / cgroup の v2 機能に進む。

---

## 10. このドキュメントの位置付け

> **Node PoC で検証された設計思想を、言語横断で参照可能な形に固定する**。

設計原則 3 点 (chunk 非保持 / backpressure 委譲 / policy 縮退のみ) は、
**Node でも Rust でも、Go でも Zig でも、同じ意味で適用される**。
このドキュメントは、そのアンカーである。
