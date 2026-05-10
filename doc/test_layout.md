# OpenClaude レイアウト確認テスト (nproxy transform/strip-ansi)

## テスト対象
```bash
NPROXY_TEXT=transform NPROXY_AUTO=1 node -r ./node/nproxy.js /usr/bin/openclaude
NPROXY_TEXT=strip-ansi NPROXY_AUTO=1 node -r ./node/nproxy.js /usr/bin/openclaude
```

## テスト項目

### 1. ASCIIアート表示
**期待**: 連続行で崩れず表示
**テスト**: `print ascii art` や `print Nproxy logo`
**確認**: 1行ずつ改行分断なし

### 2. コマンド一覧ポップアップ
**期待**: / 押して一覧正常表示
**テスト**: `/` 押す
**確認**: リストが整列、選択可能

### 3. 応答インジケータ上書き
**期待**: * Slithering… が `\r` で上書き
**テスト**: 長い応答を待つ
**確認**: 位置固定、改行なし

### 4. iPhone 入力 (改行送信)
**期待**: 1回改行で送信
**テスト**: iPhone Safari/キーボードで入力→改行
**確認**: 2回押さず送信

### 5. 色表示
**期待**: 色付きテキスト正常
**テスト**: `/help` やエラーメッセージ
**確認**: 色再現、SGR シーケンス保持

### 6. 大量出力 (フレーム描画)
**期待**: 高速出力で崩れず
**テスト**: 大量ログ出力コマンド
**確認**: スクロール正常、フレーム同期

## 結果記録
| モード | ASCII | コマンド一覧 | インジケータ | iPhone入力 | 色 | 大量出力 |
|--------|-------|--------------|--------------|------------|----|----------|
| passthrough | ✅ | ✅ | ✅ | ? | ✅ | ✅ |
| strip-ansi | | | | | | |
| transform | | | | | | |

## 問題診断
- 崩れ原因: chunk 境界 `\n` 追加, CSI 削除によるカーソル制御喪失
