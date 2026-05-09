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
- 子プロセスの PID を取得し、`/proc/<pid>/status` (VmRSS) を定期的に読む
- 4GB 超過 → PRESSURE 状態（ログ出力）
- 6GB 超過 → CRITICAL 状態 → 子プロセスを強制終了 (SIGKILL)

## メモリポリシー

| 状態 | 閾値 | 動作 |
|---|---|---|
| NORMAL | RSS < memory-pressure | 通常中継 |
| PRESSURE | memory-pressure ≤ RSS < memory-critical | ログ出力, 監視強化 |
| CRITICAL | RSS ≥ memory-critical | 子プロセス強制終了 |

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
nproxy --text=tee --log-file=/tmp/nproxy.log -- claude_code

# 3. 通常の中継のみ (監視なし)
nproxy -- claude_code
```

## 制約

- メモリ監視は Linux procfs 依存 (Windows/macOS 未対応)
- nproxy は子プロセスの stdout/stderr のみ中継。stdin は親→子への一方方向。
- シグナル中継対応 (SIGINT/SIGTERM を子プロセスへ転送)
