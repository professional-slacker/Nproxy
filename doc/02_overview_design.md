# Phase2 概要設計書: nproxy 全体構成

## 1. プロセス構造

```
                +-----------------+
                |   ターミナル    |
                |  (TTY or pipe)  |
                +-------+---------+
                        | stdin / stdout / stderr
                        ▼
        +-------------------------------+
        |  nproxy (親 Node プロセス)    |
        |                               |
        |  - Stream中継器               |
        |  - chunk Observer             |
        |  - MemoryPolicy               |
        |  - RingMetaBuffer             |
        +---+-----+-----+-------+-------+
            |     |     |       ^
       stdin|     |stderr        |stdout
            ▼     ▼              |
        +-------------------------------+
        |  app.js (子 Node プロセス)    |
        |                               |
        |  - ユーザのアプリ             |
        |  - fs / console など自由に    |
        +-------------------------------+
```

- nproxy は通常の Node スクリプトとして起動する
- nproxy が `child_process.spawn(process.execPath, [appPath, ...args])` で子を生成
- 子の stdio は **pipe** で接続する（`stdio: 'pipe'`）
- nproxy 側の stdin/stdout/stderr と子の stdio を **`pipe()` で直結** する

## 2. I/O 分類

設計上、I/O を 2 系統に分ける。

### 2.1 直接制御対象（Direct I/O）

nproxy が中継する Stream。

| 方向 | source | sink |
|---|---|---|
| stdin pass | `process.stdin` | `child.stdin` |
| stdout pass | `child.stdout` | `process.stdout` |
| stderr pass | `child.stderr` | `process.stderr` |

これらは Node の `Readable.pipe(Writable)` で直結する。
nproxy は chunk を **観測するだけ** で介入しない。

### 2.2 間接的影響源（Indirect Pressure）

nproxy が直接フックしない（してはいけない）が、メモリ圧力の源となるもの。

- 子プロセス内の fs I/O
- 子プロセス内の net I/O
- 子プロセス内の `Buffer.alloc()` 等の手動確保

**これらは fs API を monkey-patch せず、nproxy 自身の `process.memoryUsage()` の
変動でのみ検知する。**

実際は fs I/O は子プロセスのヒープに乗るので、親 nproxy の memoryUsage には
直接は出ない。**ただし、子からの stdout chunk 流入量という形で間接観測できる**。

## 3. メモリ状態 × 挙動表

`process.memoryUsage().heapUsed` と RSS を基準に 3 状態を持つ。

| 状態 | 条件（既定値） | 観測ログ | RingMetaBuffer | 解釈処理 |
|---|---|---|---|---|
| NORMAL | heapUsed < 80MB | 詳細あり | フルサイズ(1024件) | string化など全許可 |
| PRESSURE | 80MB ≤ heapUsed < 200MB | サマリのみ | 縮退(128件) | string化禁止、chunkサイズ観測のみ |
| CRITICAL | heapUsed ≥ 200MB | 出力停止 | クリア&停止(0件) | 純粋 passthrough のみ |

- 閾値はコマンドライン or 環境変数で上書き可
- 状態遷移は 500ms 周期の polling で判定
- **どの状態でも passthrough は止めない**（要件「拒否しない」より）

## 4. コンポーネント構成図

```
┌─────────────────────────── nproxy.js ────────────────────────────┐
│                                                                   │
│   ┌──────────────┐     ┌──────────────┐    ┌─────────────────┐  │
│   │ ChildSpawner │────▶│  StreamRelay │◀──▶│   Observer      │  │
│   └──────┬───────┘     │ (stdin/out/  │    │ (chunk meta only)│  │
│          │             │  err pipe)   │    └────────┬────────┘  │
│          │             └──────┬───────┘             │            │
│          │                    │                     ▼            │
│          ▼                    │             ┌──────────────────┐ │
│   child_process.spawn         │             │ RingMetaBuffer   │ │
│                               │             │ (size, ts, kind) │ │
│                               │             └────────┬─────────┘ │
│                               │                      │           │
│                               ▼                      ▼           │
│                        ┌──────────────────────────────────────┐  │
│                        │        MemoryPolicy                  │  │
│                        │ NORMAL → PRESSURE → CRITICAL         │  │
│                        │ (process.memoryUsage 監視)           │  │
│                        └──────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

## 5. データフロー図

### 5.1 stdout/stderr フロー（子→親→ターミナル）

```
   child.stdout (Readable)
        │  chunk = Buffer
        │
        ├─[Observer.onChunk(kind='out', size=N, ts)]──▶ RingMetaBuffer
        │                                                │
        │ (passthrough: chunk そのものは保持しない)      │
        │                                                ▼
        ▼                                          MemoryPolicy
   process.stdout.write(chunk)
        │
        ▼
   ターミナル (or 上流のpipe)
```

ポイント:
- chunk は **2 系統に分岐しない**（コピーしない）。Observer は size と ts だけを抜く
- 観測情報（size/ts/kind）は **小さなオブジェクト**として RingMetaBuffer に積む
- chunk 自身は次の `write()` でカーネルへ渡され、Node ヒープから解放される

### 5.2 stdin フロー（ターミナル→親→子）

```
   process.stdin (Readable; TTY or pipe)
        │
        ├─[Observer.onChunk(kind='in', size=N)]
        │
        ▼
   child.stdin.write(chunk)
        │
        ▼ (子側で消費)
   app.js
```

### 5.3 backpressure の伝播

`pipe()` を使うことで、以下が **C++ 層で自動的に** 実現される。

```
      child.stdout がデータを出す
          ↓
      nproxy が write すると同期失敗 (sink full)
          ↓
      C++ 層が child.stdout の ReadStop を呼ぶ
          ↓
      libuv が poll を停止
          ↓
      kernel pipe buffer に詰まる
          ↓
      子の console.log が blocking になる
          ↓
      子が自然に出力速度を落とす
```

これは **ヒープ非依存の backpressure** であり、設計上の要である。
nproxy が `data` イベントを listen してしまうと paused/flowing が flowing に固定され、
この機構が効かなくなる。**よって `data` イベントは絶対に listen しない**。

## 6. 状態遷移の擬似コード

```js
function evaluate() {
  const m = process.memoryUsage();
  if (m.heapUsed >= CRITICAL_THRESHOLD) return 'CRITICAL';
  if (m.heapUsed >= PRESSURE_THRESHOLD) return 'PRESSURE';
  return 'NORMAL';
}

setInterval(() => {
  const next = evaluate();
  if (next !== current) {
    onTransition(current, next);
    current = next;
  }
}, 500).unref();   // ←子プロセス終了で nproxy も終わるように unref
```

## 7. 設計上の重要な「やらないこと」

| 誘惑 | 却下理由 |
|---|---|
| `data` イベントで chunk を奪う | flowing mode に固定し backpressure を破壊する |
| `setEncoding('utf8')` で文字列観測 | string ヒープ膨張 + バイナリ事故 |
| readline で行単位ログ | 改行が来ない巨大入力で OOM |
| ANSI escape をパース | chunk 分断で死ぬ。価値もない |
| fs を monkey-patch | 副作用が大きく仕様変更に追従できない |
| chunk を全て ring に保持 | 元データを保持した瞬間に passthrough の意味が消える |
| 入力を reject / pause で防衛 | 要件「止めない／拒否しない」に違反 |
