# Latest Task — nproxy preload mode 動作確認

## 日時
2026-05-10

## 起動コマンド (passthrough, preload mode)
```bash
NPROXY_MEMLOG=60 NPROXY_TEXT=passthrough NPROXY_AUTO=1 node -r ./node/nproxy.js /usr/bin/openclaude 2>/tmp/nproxy.log
```

## 状態

| Mode | 状態 | 問題 |
|------|------|------|
| `passthrough` | ✅ OK | 表示正常、色付き、操作可能。OOM警戒で memlog推奨 |
| `strip-ansi` | ⚠️ 修正済み | Ink 制御保持版に書き換え。--print は通った。対話モード要確認 |
| `transform` | ⚠️ 修正済み | strip-ansi 同等。--print は通った。対話モード要確認 |
| `--print` モード | ✅ OK | strip-ansi/transform とも正しい応答。`1+1=2` |

## レイアウトテスト項目 (doc/test_layout.md に記載)
iPhone からの確認は保留。PC でテスト項目を実行する必要あり：
- ASCIIアート表示
- コマンド一覧ポップアップ (`/`)
- 応答インジケータ上書き (`* Slithering…`)
- iPhone 改行送信 (1回で送信)
- 色表示
- 大量出力 (フレーム描画)

## 前回からの変更点

### createTextProcessor() 再実装 (Ink 制御保持)
- keepFinal: SGR(m), カーソル移動(A B C D G H f), 消去(J K), スクロール(S T), 保存/復元(s u)
- DECプライベート(`?`/`>`), OSC8ハイパーリンク, DCSシーケンスを削除
- coalescing を passthrough 限定。transform/strip-ansi は直接書き込みで Ink フレーム境界維持

### メモリログ機能
- `NPROXY_MEMLOG=60` で60秒ごとに stderr へ RSS/heap/ext 出力
- pressure/critical 遷移は自動通知＋チャンク制限

## TODO
1. レイアウトテスト項目の実行 (PCで / 押下含め確認)
2. 長期間運用テスト（passthrough で OOM 発生有無の確認）
3. 問題なければ Phase 4 完了
4. Rust移行は Phase 9 に先送り
