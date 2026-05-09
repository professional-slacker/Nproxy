# Phase3-4 詳細設計書: nproxy 内部構造

## 1. モジュール構成

`nproxy.js` 単一ファイルだが、内部は以下の責務単位で分割する。

| 責務 | 識別子 | 入力 | 出力 |
|---|---|---|---|
| 子プロセス起動 | `spawnChild(argv)` | argv | child reference |
| Stream中継 | `relay(src, sink, kind)` | src/sink/kind | (副作用) |
| chunk 観測 | `Observer` | chunk size/kind | RingMetaBuffer 追記 |
| メタリングバッファ | `RingMetaBuffer` | meta | 直近Nのmeta配列 |
| メモリ監視 | `MemoryPolicy` | (タイマ) | state遷移コールバック |
| シグナル中継 | `signalRelay(child)` | OSシグナル | child.kill |
| ログ出力 | `debugLog(...)` | text | stderr (デバッグ時のみ) |

## 2. chunk モデル

要件の規定どおり、chunk は **意味を持たない最小単位**として扱う。

### 2.1 階層

```
ByteChunk        ← 常時。Buffer / Uint8Array そのまま流す。サイズだけ観測。
   ↓ optional (PRESSURE/CRITICAL では作らない)
TextChunk        ← デバッグログで「先頭 N バイト」を見たい場合のみ
   ↓ optional (用途限定)
LineChunk        ← 行ベースの統計が欲しい場合のみ。今回は実装外
```

### 2.2 ByteChunk の観測（メタ情報のみ）

```js
// chunk: Buffer
const meta = {
  ts: Date.now(),
  kind: 'in' | 'out' | 'err',
  size: chunk.length,
  // memo: chunk の中身は決して保持しない
};
```

サイズは `chunk.length`（Buffer の場合バイト数）。
状態が NORMAL の時のみ、デバッグ用に **先頭 16 バイトだけ hex** で同梱可能とするが、
これは **観測のために行う最小限の string 化** であり、PRESSURE 状態では行わない。

## 3. stdin 制御

### 3.1 入力源の区別

| 入力 | 判定 | 挙動 |
|---|---|---|
| 手入力 (TTY) | `process.stdin.isTTY === true` | raw mode 切替えはしない。OS の cooked モードでそのまま受ける |
| パイプ | `isTTY` が undefined / false | pipe で直結 |
| ファイルリダイレクト | 同上 | 同上 |

3 種すべて **同じ pipe 1 本** で済む。区別はあくまで isTTY による情報表示用途。

### 3.2 実装方針

```js
process.stdin.pipe(child.stdin);
```

これだけで stdin の本流は完了。観測したい場合は `Readable.prototype.on('readable')`
ではなく、**StreamPipe の前段に "pipe-through" を挟む形ではなく**、
カウントだけが欲しいなら write 側を Proxy 化するのが簡潔。

ただし要件と実装の単純さのバランスから、本プロトタイプでは
「**Transform を挟まずに pipe する**」「**観測は write メソッドの軽量フックで行う**」を採用する。

詳細:

```js
// 書き込み観測のためにメソッドラップ（破壊しない）
function wrapWriteObserve(writable, kind) {
  const originalWrite = writable.write.bind(writable);
  writable.write = function (chunk, ...rest) {
    if (chunk && chunk.length) Observer.onChunk(kind, chunk.length);
    return originalWrite(chunk, ...rest);
  };
}
```

戻り値（false=backpressure）はそのまま伝搬する。**観測のためにブロックしない**。

## 4. stdout / stderr 制御

### 4.1 実装方針

```js
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
```

観測は同様に **sink 側 (process.stdout / process.stderr) の write メソッド**を
軽量フックする。

### 4.2 メモリ逼迫時の縮退

PRESSURE/CRITICAL に入った場合の挙動:

| 状態 | meta書き込み | デバッグ先頭バイト保持 |
|---|---|---|
| NORMAL | 全 chunk 記録（ring 1024件） | 先頭16Bを hex 化 |
| PRESSURE | size/ts のみ（ring 128件） | しない |
| CRITICAL | 観測停止 | しない |

「観測停止」とは Observer の onChunk を no-op にすることを指し、**pipe 自体は停止しない**。
chunk の OS への流量は維持される。これが「拒否しない／止めない」の実装。

## 5. 制御コード（ANSI escape）

### 5.1 方針

**触らない**。chunk 境界をまたぐ可能性があり、解釈すれば壊す。

具体的には:
- TTY 時は `process.stdout.isTTY` が true となり、そのまま端末がエスケープを解釈する
- pipe 時はエスケープがそのまま流れる（パーサ側の責務）
- nproxy はバイト単位で透過するだけ

### 5.2 観測上の扱い

`chunk.length` には ESC バイトも含まれる。**「文字数」ではなく「バイト数」で観測**することで
ESC を壊すリスクをゼロにする。

## 6. file I/O との関係

### 6.1 直接フックしない理由

- `fs.readFile` を monkey-patch すると child 起動方式（`require('fs')` のロード順）に
  依存して失敗する
- worker_threads / vm モジュールでロードした fs はフックできない
- 副作用が他ライブラリと衝突する

### 6.2 検知ポリシー

- nproxy の `process.memoryUsage()` は **親プロセスのみ** を見る
- 子プロセスの fs I/O は親の memoryUsage には出ない
- ただし子が fs で読んだものを stdout に吐けば、その chunk が pipe を通る
  → **stdout/stderr の流量メトリクスで間接観測可能**
- 実装としては Observer に流量集計（直近 1 秒の bytes/sec）を追加し、
  policy 判定時に `heapUsed` と並列で見る

```js
// 流量監視（Observer 内）
let outBytes = 0;
let lastFlush = Date.now();
function onChunk(kind, size) {
  if (kind === 'out' || kind === 'err') outBytes += size;
}
function flowRate() {
  const now = Date.now();
  const dt = (now - lastFlush) / 1000;
  const r = outBytes / dt;
  outBytes = 0; lastFlush = now;
  return r; // bytes/sec
}
```

## 7. 可変リングバッファ

### 7.1 仕様

- 配列ベースの簡易リング
- メタ情報のみを格納（chunk 本体は格納しない）
- size を 1024 → 128 → 0 に動的に縮退
- `resize(n)` で末尾から切り詰める

### 7.2 擬似コード

```js
class RingMetaBuffer {
  constructor(size) {
    this.size = size;
    this.buf = new Array(size);
    this.idx = 0;
    this.count = 0;
  }
  push(meta) {
    if (this.size === 0) return;
    this.buf[this.idx] = meta;
    this.idx = (this.idx + 1) % this.size;
    if (this.count < this.size) this.count++;
  }
  resize(newSize) {
    if (newSize === this.size) return;
    const items = this.toArray();   // 古い→新しい順で取り出し
    this.size = newSize;
    this.buf = new Array(newSize);
    this.idx = 0;
    this.count = 0;
    // 末尾 newSize 件のみ復元
    const start = Math.max(0, items.length - newSize);
    for (let i = start; i < items.length; i++) this.push(items[i]);
  }
  toArray() {
    // ... ring を順序付き配列で返す
  }
}
```

## 8. メモリ監視と policy 切替

### 8.1 評価ロジック

```js
function evaluate(memUsage) {
  const heap = memUsage.heapUsed;
  if (heap >= CRITICAL) return 'CRITICAL';
  if (heap >= PRESSURE) return 'PRESSURE';
  return 'NORMAL';
}
```

### 8.2 遷移時の処理

```js
function onTransition(prev, next) {
  if (next === 'PRESSURE') {
    Observer.disableHexPreview();
    Ring.resize(128);
  } else if (next === 'CRITICAL') {
    Observer.disable();          // chunk 観測自体を停止
    Ring.resize(0);
    if (global.gc) global.gc();  // --expose-gc 時のみ
  } else if (next === 'NORMAL') {
    Observer.enable();
    Observer.enableHexPreview();
    Ring.resize(1024);
  }
}
```

**重要**: 遷移時にも passthrough 自体は止めない。
あくまで「観測のための副作用」を縮退するだけ。

## 9. シグナル中継

`SIGINT` (Ctrl+C) / `SIGTERM` を受けたら子プロセスへ転送する。
中継しないと nproxy だけ死んで子が孤児プロセスになる。

```js
['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((sig) => {
  process.on(sig, () => {
    if (!child.killed) child.kill(sig);
    // 自分は止めない。子の exit イベントで終わる
  });
});
```

## 10. 終了処理

- 子の `exit` で親も `process.exit(child.exitCode)`
- 親が殺されたら子に SIGTERM を送る（unhandled rejection の保険）
- 双方向 pipe は `'end'` で自然に閉じる

## 11. 例外取り扱い

| 例外 | 取扱 |
|---|---|
| 子起動失敗 (ENOENT) | エラーメッセージを stderr に書いて exit(127) |
| 子のハングアップ (SIGPIPE) | 親 stdout が閉じられた → SIGPIPE を子へ伝播し終了 |
| 親 stdin EOF | child.stdin を end()。子側で `process.stdin.on('end')` が走る |

## 12. デバッグ機構

`NPROXY_DEBUG=1` の時のみ `process.stderr` ではなく **別 fd（既定3、ファイル）** に
観測ログを吐く。stderr に混ぜると app.js のエラー出力と混じるため。

```js
const logFd = process.env.NPROXY_DEBUG
  ? fs.openSync(process.env.NPROXY_LOG || './nproxy.debug.log', 'a')
  : null;
function dlog(s) { if (logFd) fs.writeSync(logFd, s + '\n'); }
```

## 13. 評価ポイントへの対応マッピング

| 要件 | 設計上の対応 |
|---|---|
| chunk をどう扱っているか | ByteChunk 1階層、Buffer のまま、size のみ観測 |
| OOM をどこで防いでいるか | (a) chunk を保持しない (b) hex preview を NORMAL のみ (c) ring を縮退 (d) C++ pipe による backpressure |
| stdin/stdout/file I/O を同一思想 | すべて「**流量＋親のmemoryUsage**」の 2 軸で見る。fs は親に出ないが流量経由で出る |
| 拒否/止めない | pipe は常時。policy は副作用観測のみ縮退 |
| string無制限蓄積禁止 | NORMAL 時の hex16 だけが string。それ以外は触らない |
