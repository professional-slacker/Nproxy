# nproxy.js 設計書

## 概要

nproxy は Node.js I/O プロキシランタイム。OpenClaude などの CLI アプリケーションに対して、
メモリ監視・チャンク分割・ANSIエスケープ処理を提供する。

### 動作モード

| モード | 起動方法 | プロセス構成 | 用途 |
|--------|----------|-------------|------|
| Preload | `node -r ./nproxy.js app` | 同一プロセス | stdout/stderrをフック |
| CLI Pipe | `node nproxy.js -- app` | 親子プロセス | spawn + relay |
| CLI PTY | `node nproxy.js --pty -- app` | 親子プロセス | node-pty + TTY |

---

## 1. CLI引数パース (parseArgs, L28-45)

```js
function parseArgs(argv) {
  const out = { text: null, textLog: null, pty: false, app: null, appArgs: [] };
  // --text=mode / --text mode
  // --text-log=file / --text-log file
  // --pty / --no-pty
  // 最初の非オプション引数以降を app + appArgs と解釈
}
```

**パースルール**: `--key=value` と `--key value` の両形式をサポート。
最初の非オプション引数以降はアプリケーション引数として扱う。

---

## 2. テキスト処理 (createTextProcessor, L50-103)

### 3モード

| mode | 動作 | 使用例 |
|------|------|--------|
| `passthrough` | 何もしない（デフォルト） | Ink系アプリ |
| `strip-ansi` | ANSI制御コード除去 | ログ収集 |
| `transform` | strip-ansi + Unicode NFC正規化 | テキスト処理 |

### ANSI除去ロジック (L64-91)

```js
const keepFinal = new Set(['A','B','C','D','G','H','J','K','S','T','f','H','m','s','u','n','l','h']);
```

- **保持**: カーソル移動(A B C D G H f)、消去(J K)、SGR(m)、スクロール(S T)、
  セーブ/リストア(s u)、デバイスステータス(n)、カーソル表示/非表示(l h) 
- **除去**: DEC私用モード(?>)、OSC(\x1b]...)、DCS(\x1bP...)、SOS/PM/APC
- **例外**: `\x1b[?25h` / `\x1b[?25l` (カーソル表示/非表示) は常に保持

---

## 3. メモリ監視 (MemoryMonitor, L106-251)

### 5段階状態マシン

```
monitoring ──→ attention ──→ pressure ──→ critical ──→ emergency
     ↑            │              │             │            │
     └────────────┴──────────────┴─────────────┴────────────┘ (recovered)
```

### 閾値 (デフォルト、envで上書き可)

| 状態 | env変数 | デフォルト |
|------|---------|-----------|
| attention | NPROXY_ATTENTION_MB | 256 MB |
| pressure | NPROXY_PRESSURE_MB | 512 MB |
| critical | NPROXY_CRITICAL_MB | 1024 MB |
| emergency | NPROXY_EMERGENCY_MB | 1280 MB |
| 監視間隔 | NPROXY_TICK_MS | 200ms (最小50ms) |

### メモリ計測

```js
// Preload mode: 自プロセスのRSSを計測
heapMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
heapUsedMb = Math.round(usage.heapUsed / 1024 / 1024);
effectiveMb = Math.max(heapUsedMb, heapMb);

// CLI mode: 子プロセスのRSSを /proc/{pid}/status から読む
this._rssKb = readFileSync(`/proc/${this.childPid}/status`).match(/VmRSS:\s+(\d+)\s+kB/m);
```

### スパイク検出 (L186-193)

```js
// V8 heap/externalの急増を検出 (String.split, 大量配列操作)
const heapDelta = usage.heapUsed - this._prevHeapUsed;
const extDelta = usage.external - this._prevExternal;
spikeMb = Math.max(heapDelta, extDelta) / 1024 / 1024;

// 1回目のスパイク → 警告
// 2回目の連続スパイク → emergency直接遷移
if (spikeMb > 100 && this._spikeCount >= 1) {
  newState = 'emergency';
}
```

### サージ検出 (L221-226)

```js
// 1tickでsurgeThreshold(デフォルト32MB)以上の増加 → attention
if (delta >= this._surgeThreshold) { newState = 'attention'; }
// surgeThreshold/2(16MB)の増加が2回連続 → attention
if (delta >= this._surgeThreshold / 2 && this._consecutiveSurges >= 2) { newState = 'attention'; }
```

---

## 4. モニター階層 (installMonitorTier, L253-333)

### auto (デフォルト)
- 起動時は rss 相当（プロトタイプ非破壊、軽量）
- `attention` 状態以上で自動昇格: rss → split（SlicedString対策 + pre-split GC）
- `critical` 状態以上で自動昇格: split → array（Array プロキシ有効化）
- 昇格は一方通行（ラチェット）。降格しない
- 昇格時に1行stderrログ出力

### rss
- プロトタイプ変更なし。MemoryMonitorのtickループのみで動作

### split
- `String.prototype.split` をラップ
- **事前検出**: `v8.getHeapStatistics().used_heap_size / heap_size_limit` の比率計算
  - > 0.85: GC実行 + 警告
  - > 0.95: state変更 (critical または emergency)
- **事後検出**: split結果の使用後ヒープ差分
  - > 50MB かつ `mon._spikeCount >= 1` → emergency

### array
- `Array.prototype.push/splice/unshift/concat` をラップ
- 50000要素以上の追加操作でヒープ増加を計測
- > 50MB増加で警告

---

## 5. Intercept モード (intercept, L336-577)

### バナー表示 (L350-368)

```js
const BANNER_ANCHOR = '✦ Any model. Every tool. Zero limits. ✦';
```

OpenClaudeのウェルカムメッセージにバナー文字列をインジェクト。
- stdout.writeでanchor検出 → 1度だけ緑枠バナーを挿入
- 3秒フォールバックタイマー → anchor非検出時はstderrに直接出力

### チャンク分割サイズ (L377-380)

```js
MAX_CHUNK_NORMAL     = 262144  // 256KB — 常時分割
MAX_CHUNK_ATTENTION  = 262144  // 256KB — 注意時
MAX_CHUNK_PRESSURE   =  65536  // 64KB  — 圧迫時
MAX_CHUNK_CRITICAL   =   4096  // 4KB   — 危険時
```

### coalescing (L382-408)

passthroughモードでstdout.writeを同tick内でバッファリング:
- `COALESCE_MAX = 65536` (64KB) 超えたら即フラッシュ
- `setImmediate` で非同期フラッシュ
- `bypassCoalesce` (メモリ圧迫時) はバッファリングせず直接分割書き込み

### stdout.write フック (L424-464)

```js
process.stdout.write = function (chunk, encoding, callback) {
  // 1. バナーanchor検出 → インジェクト
  // 2. passthrough → coalesceBufに追加 → 非同期フラッシュ
  // 3. strip-ansi/transform → 即時処理後書き込み
};
```

### stderr.write フック (L469-480)

常時チャンク分割 + テキスト処理。passthroughでもcoalescing無効。

### 状態遷移ハンドラ (L495-546)

| 遷移先 | 動作 |
|--------|------|
| emergency | chunk=4KB, coalesceフラッシュ, bypass=true, GC実行, 最大3回リトライ後exit(1) |
| critical | chunk=4KB, coalesceフラッシュ, bypass=true |
| pressure | chunk=64KB, passthrough→strip-ansi自動切替, coalesceフラッシュ |
| attention | chunk=256KB |
| monitoring | chunk=256KB, bypass=false, textMode復帰 |

### NearHeapLimitCallback (L551-562)

```js
try {
  const nheap = require('./nheap_limit');
  if (nheap.available) {
    nheap.register(() => {
      if (monitor.state !== 'emergency') {
        monitor.state = 'emergency';
        monitor._onTransition('emergency', process.memoryUsage().rss / 1024 / 1024);
      }
    });
  }
} catch (_) { /* addon not built */ }
```

V8のOOM直前に発火するC++ addon。ヒープ制限を1.25倍に拡張しつつ、
JSコールバックでemergency遷移をトリガーする。

### Periodic Memory Log (L564-576)

`NPROXY_MEMLOG=60` で60秒ごとにRSS/heapUsed/external/stateを出力。

---

## 6. CLI モード (runCLI, L580-770)

### PTY モード (L611-655)
- `node-pty` ライブラリを使用
- TTYエミュレーションにより子プロセスがisTTY=trueで動作
- 端末サイズ変更(SIGWINCH)を子に伝搬

### Pipe モード (L656-768)
- スクリプト検出 (L662-672):
  - `.js/.mjs/.cjs` ファイル → `node -r nproxy.js script.js` でspawn
  - `node` in shebang → 同上
  - それ以外(バイナリ) → 直接spawn
- stdout/stderrリレー + バックプレッシャー (L689-739):
  - emergency/critical: 子プロセスのstdioをpause → コールバックでresume
  - pressure: pause → write完了後にresume
  - normal: 通常write + drainイベント制御
- シグナル中継 (L758-763): SIGINT/SIGTERM/SIGHUP/SIGUSR1/SIGUSR2/SIGWINCH

### 子プロセスRSS監視 (L742-756)
- `/proc/{pid}/status` のVmRSSをポーリング
- 状態に応じて `childMonState` を更新 → リレー制御

---

## 7. エントリポイント (L773-780)

```js
if (require.main === module) {
  runCLI();  // 直接起動 → CLIモード
}
intercept();  // require時 → Preloadモード (常時intercept)

module.exports = { intercept, MemoryMonitor, createTextProcessor, installMonitorTier };
```

---

## 8. 環境変数一覧

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| NPROXY_TEXT | passthrough | テキスト処理モード |
| NPROXY_ATTENTION_MB | 256 | attention閾値(MB) |
| NPROXY_PRESSURE_MB | 512 | pressure閾値(MB) |
| NPROXY_CRITICAL_MB | 1024 | critical閾値(MB) |
| NPROXY_EMERGENCY_MB | 1280 | emergency閾値(MB) |
| NPROXY_TICK_MS | 200 | 監視間隔(ms) |
| NPROXY_MONITOR | auto | モニター階層 (rss/split/array/auto) |
| NPROXY_MEMLOG | 0 | 定期ログ間隔(秒) |
| NPROXY_PTY | 0 | PTYモード有効化 |
| NPROXY_AUTO | - | CLI spawn時に自動設定 |

---

## 9. アーキテクチャ図

```
Preload Mode (同一プロセス):
  ┌─────────────────────────────────────────────┐
  │  nproxy.js (intercept)                      │
  │  ┌─────────┐  ┌────────────────────────┐    │
  │  │ stdout  │  │ MemoryMonitor          │    │
  │  │ write   │──│ 5-stage state machine  │    │
  │  │ フック  │  │ 200ms tick            │    │
  │  ├─────────┤  │ surge/spike detection │    │
  │  │ stderr  │  │ installMonitorTier    │    │
  │  │ write   │  │ (split/array proxy)   │    │
  │  │ フック  │  └────────────────────────┘    │
  │  ├─────────┤  ┌────────────────────────┐    │
  │  │chunk分  │  │ NearHeapLimitCallback  │    │
  │  │割/     │  │ (C++ addon)            │    │
  │  │バナー  │  └────────────────────────┘    │
  │  └─────────┘                               │
  │  OpenClaude アプリケーションロジック        │
  └─────────────────────────────────────────────┘

CLI Pipe Mode (親子プロセス):
  ┌──────────┐    pipe    ┌─────────────┐
  │ nproxy   │ stdout ←──│ OpenClaude  │
  │ (parent) │ stderr ←──│ (child)     │
  │          │    pipe    │ -r nproxy   │
  │ signal   │ ────────→│              │
  │ relay    │   kill()  │             │
  │ childMon │           │             │
  │ /proc/RSS│           │             │
  └──────────┘           └─────────────┘
```

---

## 10. OOM対策スタック

```
Layer 1: chunk分割 (常時256KB)
  ─ 巨大writeによる一発のメモリ確保を制限

Layer 2: pre-split 検出 (split tier)
  ─ split実行前にヒープ比率>0.85でGC, >0.95でstate変更

Layer 3: NearHeapLimitCallback (C++ addon)
  ─ V8 OOM直前に発火 → ヒープ拡張 + emergency遷移

Layer 4: 5段階MemoryMonitor (200ms polling)
  ─ RSS+heapUsed で5段階状態遷移
  ├─ monitoring → 正常
  ├─ attention  → chunk=256KB
  ├─ pressure   → chunk=64KB, strip-ansi自動切替
  ├─ critical   → chunk=4KB, bypassCoalesce
  └─ emergency  → GC, 3回リトライ後 exit(1)
```

*設計書作成日: 2026-05-12*
*対象ファイル: node/nproxy.js (781行)*

---

## 11. emergency の先 — 設計思想 (STATUS #14)

### 課題: HTTP的即死モデルからの脱却

nproxy はメモリ逼迫時に `process.exit(1)` で即死する。しかし:
- nproxy は「システムが簡単に落ちすぎるから」生まれたプログラム
- それが簡単に落ちるのは本末転倒
- HTTPは「1リクエスト→1レスポンス→終了」だが、CLI アプリはセッション中に泥臭いネゴシーションが必要
- メインフレームのように「通知→あがき→リトライ→復元→分離→最後にダンプ」が理想

### 理想的な状態遷移 (6段階)

```
monitoring → attention → pressure → critical → emergency → fatal → dump death
```

| 状態 | 役割 |
|------|------|
| monitoring | 正常動作 |
| attention | 軽い警告 (stderr通知) |
| pressure | リソース節約 (text mode ダウングレード、GC強制) |
| critical | 子プロセスとの分離準備、ダンプ準備開始 |
| emergency | 最終リトライ (nheap_limit再発火、メモリ回復全力試行) |
| fatal | ダンプ書き込み、外部通知 (ファイル/シグナル) |
| dump death | `process.abort()` または沈黙 (exit はしない) |

**原則:** nproxy は見張り番であって処刑人ではない。殺すかどうかは OS の OOM killer やユーザーの判断。

### ダイイングメッセージ (fatal ダンプ)

`process.exit` の前に以下をファイルに書き出す:
- `process.memoryUsage()` の詳細
- `/proc/self/status`
- 子プロセス状態
- 状態遷移履歴
- ファイル名: `nproxy_dump_<pid>_<timestamp>.json`

---

## 12. 入力のファイル化パイプライン (STATUS #14 補足)

### 課題: 大量入力で待たされない

ユーザーが 1GB のテキストを貼り付けたとき、全量をメモリに読み込んでから判断しては遅い。
入力は「待てない」— ユーザーは入力した瞬間にフィードバックを期待する。

### 設計: 即ファイル化パイプライン

```
                    ┌─── [通常: チャンク制御ストリーム] ──> 子プロセスへ (256KB制限)
                    │
[生の入力 Buffer] ──┼─── [緊急: 呼吸困難 / GC介入] ──────> メモリ解放を待つ
                    │
                    └─── [臨界/巨大入力: 即ファイル化] ───> fs.writeSync / tmpファイル
                                                                 │
                                                                 └──> 子プロセスへパス通知
```

### 入口での流量制御

1. stdin の `data` イベントで chunk 累積サイズを監視
2. 閾値 (例: 50MB) を超えたら即座に子プロセスの stdin を閉じる
3. 超過分は `/dev/null` に捨てる or ファイルに書きつつ子プロセスには渡さない
4. ユーザーに「入力が大きすぎます」を stderr で通知

### テンポラリファイルへの逃がし

- 小さい入力 (< 10MB): メモリバッファ (今のまま)
- 大きい入力 (> 10MB): テンポラリファイル `/tmp/nproxy_stdin_<pid>` に切り替え
- 巨大な入力 (> 1GB): 遮断 + ダンプ

**原則:** チャンク単位で判断する。全部読み終わってから「1GBでした」では手遅れ。

### ディスク逼迫対策

- ファイル化先を専用ディレクトリ `/tmp/nproxy/` に分離
- 起動時に利用可能容量をチェック
- ファイル化開始時に `df` で空き容量確認、不足なら即座に fatal
- ファイル化中も定期的に空き容量をチェック

---

## 13. process.title フォーマット

### フォーマット

```
<appName> -via nproxy::<state>
```

### 表示例

| 状態 | ps表示 |
|------|--------|
| monitoring | `openclaude -via nproxy::monitoring` |
| attention | `openclaude -via nproxy::attention` |
| pressure | `openclaude -via nproxy::pressure` |
| critical | `openclaude -via nproxy::critical` |
| emergency | `openclaude -via nproxy::emergency` |

### 設計意図

- アプリ名を先頭に: 識別性向上
- `nproxy::` 形式: 状態が一目で分かる
- メモリ値は表示しない (ps の出力を簡潔に保つ)
