# Phase1 調査レポート: Node.js ランタイム I/O の実体

本レポートは Node.js ソースツリー（`C:\work\workfolder\AITool\node`）を直接読み取り、
nproxy 設計の前提となる stdin / stdout / stderr / file I/O の実装メカニズムを整理したものである。

調査対象:
- `lib/internal/streams/readable.js`
- `lib/internal/streams/writable.js`
- `lib/internal/streams/state.js`
- `lib/internal/fs/streams.js`
- `lib/internal/fs/utils.js`
- `lib/fs.js`
- `src/stream_base.cc`
- `src/stream_pipe.cc`

---

## 1. Stream クラス構造（JS層）

Node.js の標準入出力（`process.stdin` / `process.stdout` / `process.stderr`）はすべて
`stream.Readable` または `stream.Writable` のサブクラスである。
`child_process.spawn` で起動された子プロセスの stdio もまた同じ Stream API を経由する。

stream は内部状態を `ReadableState` / `WritableState` に保持し、その中の
**bufferedChunks（リングバッファ的な配列）** に未処理の chunk を蓄える。
chunk は基本的に **`Buffer` (≒ Uint8Array)** で、setEncoding が呼ばれた場合のみ string に変換される。

### 1.1 highWaterMark（hwm）

`lib/internal/streams/state.js` の実装:

```js
let defaultHighWaterMarkBytes =
  process.platform === 'win32' ? 16 * 1024 : 64 * 1024;
let defaultHighWaterMarkObjectMode = 16;
```

- Windows: 16 KB
- それ以外: 64 KB
- objectMode: 16 個

つまり Node.js の Readable は、内部バッファに `hwm` バイト溜まっていれば「これ以上読まないでくれ」と
**ソースに対して push を遅延させる**（push() の戻り値が false になる）。
ソースが従わない（false でも push し続ける）場合、バッファは無制限に膨らみ得る。
ここが **OOM の最大の発生源**である。

### 1.2 push の挙動（`readable.js` line 550 付近）

```js
// We can push more data if we are below the highWaterMark.
const ret = !state.objectMode &&
  (state.length < state.highWaterMark || state.length === 0);
```

`push()` は `false` を返すことで「もう読まないでくれ」を伝えるが、
**chunk は破棄しない**。すでに渡された chunk は必ず buffer に蓄積される。

### 1.3 動的 hwm 拡張（`readable.js` line 618 付近）

```js
function computeNewHighWaterMark(n) { ... }
if (n > state.highWaterMark)
  state.highWaterMark = computeNewHighWaterMark(n);
```

read(n) で hwm を超えるサイズを要求された場合、Node は hwm を **次の2の冪まで自動拡張する**。
最大 1GiB まで成長可能（このため hwm を信用してはいけない）。

---

## 2. C++ 層（V8 / libuv）の実装

### 2.1 `src/stream_base.cc` — Write の流れ

```cpp
StreamWriteResult StreamBase::Write(uv_buf_t* bufs, size_t count, ...) {
    size_t total_bytes = 0;
    for (size_t i = 0; i < count; ++i) total_bytes += bufs[i].len;
    bytes_written_ += total_bytes;

    if (send_handle == nullptr && HasDoTryWrite() && !skip_try_write) {
      err = DoTryWrite(&bufs, &count);
      if (err != 0 || count == 0) {
        return StreamWriteResult{false, err, nullptr, total_bytes, {}};
      }
    }
    ...
}
```

**ポイント**:
- C++ 層では `uv_buf_t` (libuv のバッファ構造体) を直接扱っており、Buffer の中身は
  V8 の ArrayBuffer の BackingStore（外部メモリ）として保持される
- `DoTryWrite()` で同期書き込みを試み、失敗した分だけ非同期キューに積む
- string を Buffer に変換する場合のみ `BackingStore::NewBackingStore` で
  追加メモリを確保する（**string 化のメモリコスト**）
- string サイズが `INT_MAX` (2GiB) を超えると `UV_ENOBUFS` で失敗する
  （これは「拒否」ではなく libuv 側の物理上限）

### 2.2 `src/stream_pipe.cc` — pipe() の Backpressure 実装

`pipe()` の本質は C++ 層に実装されている `StreamPipe` クラス。

```cpp
void StreamPipe::ProcessData(size_t nread,
                             std::unique_ptr<BackingStore> bs) {
  ...
  StreamWriteResult res = sink()->Write(&buffer, 1);
  pending_writes_++;
  if (!res.async) {
    writable_listener_.OnStreamAfterWrite(nullptr, res.err);
  } else {
    is_reading_ = false;
    res.wrap->SetBackingStore(std::move(bs));
    if (source() != nullptr)
      source()->ReadStop();   // ← OS レベルでの読み込み停止
  }
}
```

**ここが nproxy 設計上、最も重要な発見**:

1. 書き込みが同期完了（`!res.async`）→ 即座に次へ
2. 書き込みが非同期（バッファに積んだ）→ **ソースの `ReadStart` を停止**

つまり Node.js の `pipe()` は、libuv の poll を停止することで **OS レベルでバックプレッシャを実現している**。
これにより、データはカーネルのソケットバッファ／パイプバッファに溜まり、
**Node プロセスのヒープには載らない**。

書き込み完了で `ReadStart()` が再開される（line 229）。

### 2.3 OnStreamAlloc — chunk のメモリ確保

```cpp
uv_buf_t StreamPipe::WritableListener::OnStreamAlloc(size_t suggested_size) {
  return previous_listener_->OnStreamAlloc(suggested_size);
}
```

libuv からの suggested_size（通常 64KB）を利用し、**毎回新規に BackingStore を確保**する。
データが大量に流れる場合、GC が間に合わなければ短期的にヒープが膨れる可能性がある。

---

## 3. fs モジュールの I/O

### 3.1 重要な定数（`lib/internal/fs/utils.js`）

```js
const kIoMaxLength = 2 ** 31 - 1;            // 約 2GB
const kReadFileUnknownBufferLength = 64 * 1024;   // 64KB（未知サイズ時）
const kReadFileBufferLength = 512 * 1024;         // 512KB（既知サイズ時）
```

### 3.2 fs.readFile vs fs.createReadStream

| API | メモリ消費 | 用途 |
|---|---|---|
| `fs.readFile(path, cb)` | **ファイル全体をヒープに乗せる** | 小ファイル限定 |
| `fs.readFileSync(path)` | 同上、加えて event loop を停止 | 危険 |
| `fs.createReadStream(path)` | hwm 単位（既定 64KB）で chunk 化 | **大ファイル必須** |

`readFile` は `kIoMaxLength` (約2GB) を超えると `RangeError` を throw するが、
それ未満であれば原則ヒープに全展開する。

### 3.3 file I/O が「親プロセスにも影響する」理由（重要）

子プロセス（app.js）が `fs.readFile(huge)` を呼んだとき、
**子のヒープが膨れるだけで親 nproxy には直接影響しない**。

しかし以下の経路で親に波及する:

1. 子が読み込んだ巨大データを `process.stdout.write(buf)` で書き出す
2. その chunk は **stdout pipe を通じて親 nproxy の stdin（=子から見たstdout）に流れ込む**
3. nproxy 側で `string 化` や `蓄積` をしていると、親もヒープが膨れる
4. 親が消費しきれなければ pipe バッファが詰まり、子の write が blocking になる
5. 結果、子が hang し、見かけ上「I/O が止まった」状態になる

**結論**: fs I/O を直接フックする必要はない。
**fs I/O が間接的に発生させる stdout chunk の量だけを観測すればよい**。

---

## 4. stdin / stdout / stderr の TTY/pipe 差異

### 4.1 TTY 判定

`process.stdin.isTTY` / `process.stdout.isTTY` で判定。
spawn された子プロセスから見ると親が pipe の場合 isTTY は `undefined`（false 扱い）。

### 4.2 chunk の形

| 経路 | chunk 型 | 既定 hwm |
|---|---|---|
| TTY (端末から) | `Buffer` (1バイトずつ来ることもある) | 16KB |
| pipe (リダイレクト, spawn) | `Buffer` (libuv が64KB単位でまとめる) | 16KB(Win) / 64KB |
| readline 経由 | `string` (行単位) | — |

TTY モードの stdin は **1キーストロークずつ来る** ため、
chunk サイズで判別する設計は危険。chunk を「意味を持たない最小単位」として扱うべき。

### 4.3 ANSI escape sequence の chunk 分断問題

ANSI escape (`\x1b[...m` 等) は最大十数バイト程度だが、
libuv の read 境界で **`\x1b[3` までで切れて、次のチャンクで `1m` が来る** ことが
ターミナルや SSH 越しの環境で頻発する。

→ nproxy は **chunk の境界で escape を切らずに保持してから渡す**ような
「解釈」をすると逆に壊れる。**素通しが正解**。

---

## 5. OOM が起きる典型ケース一覧

| # | シナリオ | 機序 |
|---|---|---|
| 1 | child の stdout を `data => buf += chunk` で全部 string 連結 | string immutability で毎回コピー、O(n²) |
| 2 | `readline` を stdin に貼り付け、改行が来ないままGB単位流入 | line バッファに蓄積、改行で初めて吐く |
| 3 | child で `fs.readFileSync(huge)` → `console.log` で吐く | child ヒープ膨張 + 親の蓄積 |
| 4 | nproxy が pipe しないで data イベントだけ拾い、stdout に書かない | 親に蓄積、消費されず GC 困難 |
| 5 | `setEncoding('utf8')` 後にバイナリが来た時の置換文字(U+FFFD)生成 | string ヒープ + 文字数増加 |
| 6 | ring buffer の size を毎回 grow する設計 | 縮退できず最大値で固定化 |
| 7 | stdin の TTY raw mode で escape が来たのを join して string化 | TTY 操作中ずっと滞留 |

---

## 6. nproxy 設計への示唆（Phase1 結論）

1. **pipe() を最大限信頼する**：`source.pipe(sink)` を貼ることで C++ 層で
   ReadStop/ReadStart が回り、OS レベルの backpressure が効く。
   余計なラップをしない設計が最強。

2. **chunk は決して string 化しない**：観測（サイズ計測等）は
   `chunk.length` で済む。string 化はメモリコスト＋GC 圧力＋エンコーディング事故の
   三重苦である。

3. **`process.memoryUsage().heapUsed` を policy のトリガにする**：
   fs I/O などの間接圧力もここに反映される。閾値で `NORMAL/PRESSURE/CRITICAL` を切る。

4. **ring buffer は「観測ログのため」だけ**：本流の chunk は必ず即時に
   下流へ pipe される。リングは「デバッグのため最近 N 個のメタ情報だけ」覚える形にする。

5. **ANSI / TTY は触らない**：素通し以外の選択肢は壊す方向にしか働かない。
