# Phase10 設計書: ランタイム Text I/O 層

## 1. 主題

> 「Byte chunk を string に decode しても、設計原則を保てるか」

これまでの設計は **「string 化しないことで OOM を防ぐ」** という方向だった。
本フェーズはあえて **string 化を許容する** 領域を作る。
ただしそれは **Node のメモリ状況に応じて自動的に切り替わる動的な機能**であり、
原則「拒否しない／止めない／覚えない」と矛盾しない実装でなければならない。

ユーザ要件:

> nproxyに統合。Nodeのメモリ使用状況での自動可能にする。
>
> Text 処理仕様: (a) decode→そのまま、(b) decode→加工、(c) decode→tee 全部入り
>
> データ: ASCII / マルチバイト両方 (比較バッチ)

## 2. UTF-8 chunk 境界問題

UTF-8 は 1〜4 バイト可変長。Stream の chunk 境界 (libuv の 64KB 単位) は
**マルチバイト文字の途中で切れる可能性がある**。

```
chunk[N] : ... E3 81 (← "あ" の途中で切れた)
chunk[N+1]: 82 ... ("あ" の残り)
```

**素朴な実装** (`chunk.toString('utf8')`) はそれぞれの chunk を独立に decode し、
不完全なバイト列を **U+FFFD (置換文字)** に変換してしまう。これは破壊。

**正しい実装** は Node 標準の `string_decoder.StringDecoder`:

```js
const { StringDecoder } = require('string_decoder');
const dec = new StringDecoder('utf8');
chunk1 → dec.write(chunk1)  // 不完全な末尾は内部保留
chunk2 → dec.write(chunk2)  // 前回の保留と結合してから decode
// 終了時:
dec.end()                   // 残った保留を flush
```

調査: `lib/string_decoder.js` より、保留バッファサイズは **C++ binding 内の固定 kSize** で、
chunk のサイズに関係なく定数。これが本フェーズの「string 化してもメモリ爆発しない」根拠。

## 3. Text I/O の3モード

### 3.1 モードA: decode → そのまま再出力 (passthrough-text)

```
Buffer chunk → StringDecoder → string → sink.write(string)
```

- 「string 化だけ」の最小実装
- 効果: chunk 境界の UTF-8 破壊が起きない (StringDecoder の責務)
- **検証点**: pipe が詰まらないか、heap が増えないか

### 3.2 モードB: decode → 加工 → 再出力 (transform)

```
Buffer chunk → StringDecoder → string → 行単位処理 → string → sink.write
```

加工例 (本実装):
- 行頭にタイムスタンプ付与: `[2026-05-08T10:23:45.123Z] original line\n`
- 行番号付与: `   12345 | original line\n`

- **検証点**: 行バッファリングが暴走しないか、改行のない巨大入力で OOM しないか
- 行バッファは **policy 連動で上限を持つ**: 1MB を超えたら強制 flush

### 3.3 モードC: decode → tee (multiplex)

```
Buffer chunk → StringDecoder → string ─┬→ sink.write (terminal)
                                         └→ logFileStream.write
```

- ログファイルへ string で書き出し（バイナリではなくテキストとして）
- pipe を 2 系統同時運用
- **検証点**: 一方が遅くてもう一方がフルスループットの時、backpressure が両方に正しく波及するか

## 4. メモリ自動連動 (本フェーズの核心)

### 4.1 拡張された state 機械

| state | byte層 (既存) | text層 (新規) |
|---|---|---|
| NORMAL | 詳細観測, ring 1024 | text-on-by-config (要求があれば有効) |
| PRESSURE | サマリ, ring 128 | **text-AUTO-OFF** (重い加工は停止) |
| CRITICAL | 観測停止, ring 0 | **text-完全OFF** (decode すらしない) |

### 4.2 切り替えセマンティクス

text 処理は **動的に ON/OFF できる Transform チェーン** とする。

- ON時: `child.stdout → TextTransform → process.stdout`
- OFF時: `child.stdout → process.stdout` (直結)

切り替えは **完全同期で、進行中の chunk を破壊せずに**:
1. 新しい chunk が来たら policy を確認
2. ON→OFF 遷移時: StringDecoder を `end()` して保留バイトを flush
3. OFF→ON 遷移時: 新規 StringDecoder を生成
4. **これらの間に chunk が来たら必ずそのまま下流へ流す** (止めない原則)

### 4.3 自動 OFF が起きるシナリオ例

ユーザは `--text=transform` で起動。Nodeのメモリ圧力が上がる:

```
時刻        heap   state       textMode
00:00:00    2MB    NORMAL      transform
00:00:05    50MB   NORMAL      transform
00:00:10    85MB   PRESSURE    OFF (自動)         ← ここで切替
00:00:30    50MB   NORMAL      transform (復帰)
```

このとき:
- chunk 自体は停止しない
- ON→OFF 切替で残っていた保留 UTF-8 バイトは flush され、欠落しない
- 直結に切り替わった後の chunk は byte のまま流れる
- (副作用) 行頭タイムスタンプは PRESSURE 中だけ付かなくなる

これは「**重い text 加工は副作用**であり、policy で副作用を縮退する」という
当初設計と完全に整合する。

## 5. 同一思想の徹底

### 5.1 chunk 非保持 (text 層でも)

- StringDecoder の保留は **C++ binding 内の固定サイズ kSize** (8 bytes 程度)
- string 自体も **書き出し直後に参照を切る**
- ring に格納するのは **string 自体ではなくサイズ・行数のメタ情報のみ**

### 5.2 backpressure 委譲 (text 層でも)

- Transform は Readable/Writable Duplex なので backpressure は自動伝搬
- `transform()` 内で `this.push(string)` した戻り値を**捨てない**
- `false` が返れば次の chunk 処理は callback() 完了で待機

### 5.3 policy 縮退のみ (text 層が新たに対象)

- text 加工自体が「重い副作用」と位置付けられた
- policy は副作用全般を縮退対象とし、本流 (byte passthrough) は止めない

## 6. 実装上の構造

```
        ┌─ Mode 'off' (default)  → byte 直結 (既存実装と同じ)
        │
nproxy ─┼─ Mode 'passthrough'    → child.stdout
        │                          ─.pipe(TextDecoder)
        │                          ─.pipe(process.stdout)
        │
        ├─ Mode 'transform'      → child.stdout
        │                          ─.pipe(TextDecoder)
        │                          ─.pipe(LineTransform)
        │                          ─.pipe(process.stdout)
        │
        └─ Mode 'tee'            → child.stdout
                                   ─.pipe(TextDecoder)
                                   ─.pipe(TextTee)   (process.stdout & file)
```

## 7. CLI 拡張

```
node nproxy.js [--text=MODE] [--text-log=PATH] app.js [args...]
```

| フラグ | 意味 |
|---|---|
| `--text=off` | text 処理しない（既定） |
| `--text=passthrough` | StringDecoder 経由で string 化、そのまま出力 |
| `--text=transform` | StringDecoder + 行頭ts/行番号付与 |
| `--text=tee` | StringDecoder + 標準出力 + ログファイル両方 |
| `--text-log=PATH` | tee モードのログ出力先 (既定: `./nproxy.text.log`) |

環境変数でも同等指定可能 (`NPROXY_TEXT`, `NPROXY_TEXT_LOG`)。

## 8. 行バッファの上限

transform モードでは行単位処理のため改行までを内部に保持する。
**改行のない巨大入力対策**として:

```
maxLineBytes = 1MB
```

を超えたら **改行を待たずに強制 flush** する。これは原則「string無制限蓄積禁止」の遵守。

## 9. 観測指標 (Phase10 で新規追加)

| 指標 | 取得方法 |
|---|---|
| decoded chars/sec | TextTransform 内でカウント |
| byte→string 変換コスト (μs) | 各 chunk の前後 hrtime 差分 |
| pending bytes (StringDecoder) | `decoder.lastNeed` 等を観測 |
| max line buffer size | LineTransform 内のピーク |
| text mode transitions | `[TEXT] off → transform` 等のログ |
| chunk 境界破壊検知 | 出力 hash と「期待」hash を比較 |

## 10. 期待される結果（仮説）

| 観点 | 期待 |
|---|---|
| 10GB ASCII passthrough | スループット低下 < 30% (decode の純粋コスト) |
| 10GB ASCII transform | スループット低下 < 60% (行解析コスト) |
| マルチバイト境界 | 出力ハッシュが入力と一致 (StringDecoder で破壊なし) |
| heap | NORMAL 時のみ 5〜20MB に増えるが、サイズ非依存でフラット |
| PRESSURE 自動 OFF | 閾値突破で text mode が off に切り替わる |
| 切替時の欠落 | 0 バイト |
