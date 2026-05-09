# Node.js Production 化計画

## 目標
nproxy.js を `node -r nproxy` でインターセプト可能にする。子プロセス spawn モードは維持。

## 要件

### 1. `-r` (preload) モード
- `node -r ./nproxy.js openclaude` で読み込まれたとき、自動で intercept 開始
- `process.stdin` を chunk (hwm) 単位で読み、String 結合させない
- `process.stdout.write` / `process.stderr.write` をラップ
- テキスト変換 (ANSI strip, UTF-8 正規化) を任意適用
- メモリ監視 (process.memoryUsage().heapUsed) を開始
- 既存プロセスコードに一切の変更不要

### 2. 子 spawn モード (既存維持)
- `node nproxy.js [--text=...] -- command` で子プロセス起動
- stdin/stdout/stderr 双方向中継

### 3. 観測・制御

| 機能 | 子 spawn モード | -r モード |
|---|---|---|
| メモリ監視 | child RSS (OS) | process.memoryUsage() |
| backpressure | OS pipe (自然) | 読み取り停止(chunk未消費) |
| text transform | フル対応 | stdout/stderr フック内 |

## 実装方針

### `-r` モードの検出
```js
// nproxy.js 末尾
if (require.main === module) {
  // CLI mode: spawn child
} else {
  // -r mode: intercept
  intercept();
}
```

### intercept() のやること
1. `process.stdin.setEncoding('utf-8')` → `readable` イベントで chunk 読み
2. `process.stdout._write` をラップ（必要ならテキスト変換）
3. `process.stderr._write` をラップ
4. `setInterval` で `process.memoryUsage().heapUsed` 監視
5. 状態に応じて chunk サイズ調整 or 読み取り停止

### テキスト変換のオプション
環境変数で制御:
- `NPROXY_TEXT=passthrough` (default)
- `NPROXY_TEXT=strip-ansi`
- `NPROXY_TEXT=transform`

### メモリポリシー
| 状態 | heapUsed 閾値 (MB) | 動作 |
|---|---|---|
| Normal | < 512 | 通常読み取り |
| Pressure | 512 - 1024 | chunk 停止、変換オフ |
| Critical | > 1024 | 読み取り再開、最小限動作 |

## TODO

### Phase 1: intercept コア (完了)
- [x] `-r` モード検出 (require.main === module)
- [x] `intercept()` の実装
  - [x] stdout.write ラップ + テキスト処理
  - [x] stderr.write ラップ + テキスト処理
- [x] 基本テスト (echo アプリで動作確認)

### Phase 2: メモリ監視 (完了)
- [x] `process.memoryUsage()` 定期監視
- [x] 状態遷移と通知 (normal → pressure → critical)
- [x] MemoryMonitor クラス実装

### Phase 3: テキスト変換
- [x] ANSI strip
- [ ] UTF-8 正規化 (NFC/NFD)
- [x] 環境変数制御 (NPROXY_TEXT)
- [ ] chunk 分割制御 (メモリ状態に応じて chunk サイズ調整)

### Phase 4: テスト・リリース
- [x] `-r` モードのテスト (echo アプリで動作確認)
- [ ] 既存 sub spawn モードの回帰テスト
- [ ] ドキュメント更新

## テスト手順

### Preload モード (`-r`)
```bash
# 基本動作
echo "hello" | NPROXY_AUTO=1 node -r ./node/nproxy.js node node/test_apps/app_echo.js

# ANSI strip
NPROXY_TEXT=strip-ansi NPROXY_AUTO=1 node -r ./node/nproxy.js openclaude

# 生の OpenClaude (インターセプトなしで起動確認)
node openclaude
```

### CLI mode (子 spawn)
```bash
# passthrough
echo "test" | node node/nproxy.js --text=passthrough node node/test_apps/app_echo.js

## ファイル構成 (変更後)
```
node/
├── nproxy.js          # メイン (intercept + spawn)
├── lib/
│   ├── intercept.js   # -r モードの実装
│   ├── monitor.js     # メモリ監視
│   └── transform.js   # テキスト変換
├── test_apps/         # 既存
├── testing/           # 既存
└── run_*.js           # 既存
```
