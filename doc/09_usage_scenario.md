# nproxy 実行イメージ

## 背景

OpenClaude (Node.js/V8) が Intl.Segmenter のセグメンテーション処理で OOM を起こした。

```
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
  └→ v8::internal::JSSegments::CreateSegmentDataObject で確保失敗
```

これを防ぐために nproxy をラッパーとして使い、子プロセスのメモリ使用量を監視して閾値超過時に強制終了する。

## 基本実行イメージ

```
OpenClaude (ホストプロセス)
  └── nproxy --text=passthrough --memory-pressure=4000 --memory-critical=6000
        └── claude_code (実処理, 例: セグメンテーション, 大量テキスト処理)
```

- nproxy は子プロセスの stdin/stdout を中継する（--text=passthrough）
- 子プロセスのメモリ使用量（RSS + heapUsedのmax）を定期的に監視
- 256MB 超過 → attention状態（チャンク分割開始）
- 512MB 超過 → pressure状態（I/O制限）
- 1024MB 超過 → critical状態（チャンク4KB + coalesce bypass）
- 1280MB 超過 → emergency状態（GC実行、3回リトライ後終了）

## メモリポリシー（5段階）

| 状態 | 閾値（既定値） | 動作 |
|---|---|---|
| monitoring | RSS < 256MB | 通常中継 |
| attention | 256MB ≤ RSS < 512MB | チャンク分割開始 |
| pressure | 512MB ≤ RSS < 1024MB | textモード切替、I/O制限 |
| critical | 1024MB ≤ RSS < 1280MB | チャンク4KB + coalesce bypass |
| emergency | RSS ≥ 1280MB | GC実行、3回リトライ後終了 |

- 閾値は環境変数で上書き可 (`NPROXY_ATTENTION_MB`, `NPROXY_PRESSURE_MB`, `NPROXY_CRITICAL_MB`, `NPROXY_EMERGENCY_MB`)
- 子プロセスは強制終了しない（信号は中継するが、nproxyからSIGKILLは送らない）

## 実際に OOM が起きたケース (Intl.Segmenter)

OpenClaude が大量テキストに対して `Intl.Segmenter` で単語分割を実行した際、
V8 ヒープ上に SegmentDataObject が大量生成され、GC が解放しきれずにヒープ制限を超過。

```
JSSegments::CreateSegmentDataObject
  → JSSegmentIterator::Next
    → Builtin_SegmentIteratorPrototypeNext
      → (V8 GC: allocation failure)
        → FATAL ERROR: Reached heap limit
```

nproxy で子プロセス化すれば、この OOM が起きてもホストプロセスに影響は出ない。
必要に応じて子プロセスを再起動すれば継続稼働可能。

## 実行コマンド例

```bash
# 1. 最小: passthrough + メモリ監視
nproxy --text=passthrough --memory-pressure=4000 --memory-critical=6000 -- claude_code

# 2. transform モードでログ採取
nproxy --text=transform -- claude_code

# 3. 通常の中継のみ (監視なし)
nproxy -- claude_code
```

## 制約

- メモリ監視は Linux procfs 依存 (Windows/macOS 未対応)
- nproxy は子プロセスの stdout/stderr のみ中継。stdin は親→子への一方方向。
- シグナル中継対応 (SIGINT/SIGTERM を子プロセスへ転送)
