# Windows 版 nproxy タスクリスト

## 前提
- OpenClaude が Windows で動く場合を想定
- 今の Linux 版 `-r preload` がベース
- Rust 版は Phase 9 で別途対応

## Windows の Node.js 違い

### 1. `-r` preload
- ✅ 動く (Node.js on Windows)
- 問題なし

### 2. `process.stdout.write` フック
- ✅ 動く (純 JS)
- 問題なし

### 3. `process.memoryUsage()`
- ✅ 動く (V8 の API)
- 問題なし

### 4. `/dev/tty`
- ❌ Windows に存在しない
- OpenClaude が直接開いてる部分は Windows で動かない
- → nproxy の管轄外（OpenClaude 側の対応が必要）

### 5. `child_process.spawn`
- ✅ 動く
- パス区切りが `\` になるので注意

### 6. `setRawMode(true)`
- ❌ Windows では既定で raw mode 相当
- `setRawMode()` 自体はエラーにならないが効果は限定的

### 7. ANSI / ConPTY
- ✅ Windows 10+ の ConPTY 対応
- Ink の制御コードは Windows Terminal / VS Code 統合ターミナルで通る
- `ENABLE_VIRTUAL_TERMINAL_PROCESSING` が必要（Node.js は自動設定？確認）

### 8. SIGWINCH
- ❌ Windows に存在しない
- リサイズ検知に別方式が必要（`readline` の `resize` イベント？）

### 9. `node-pty`
- ⚠️ ビルドが必要
- Windows では winpty または ConPTY ベースで動作
- `npm install -g node-pty` でビルドできるが、Visual Studio Build Tools が必要

### 10. パス区切り
- `/usr/bin/openclaude` → Windows パスに変更
- `require('/usr/lib/node_modules/node-pty')` も Windows パスに

## タスクリスト

### Phase W1: Windows 動作確認
- [ ] Node.js on Windows で `node -r nproxy.js openclaude` が動くか
- [ ] `process.stdout.write` フックが正しく動作するか
- [ ] `process.memoryUsage()` の値が取得できるか

### Phase W2: ConPTY 対応
- [ ] ConPTY モードを追加（`child_process.spawn` に `detached: true` 等）
- [ ] `SIGWINCH` 代替を実装（`readline` resize イベント or ポーリング）

### Phase W3: node-pty on Windows
- [ ] Windows で node-pty がビルドできるか確認
- [ ] 代替: ConPTY 直接 API 経由（`conpty.js` など）

### Phase W4: パス対応
- [ ] `require('/usr/lib/...')` の Windows パス対応
- [ ] 引数のパス区切りを自動変換
- [ ] インストールスクリプトの Windows 対応

### Phase W5: CI / 配布
- [ ] GitHub Actions で Windows テスト
- [ ] npm パッケージ化（`@nproxy/io` など）

## 保留（nproxy 管轄外）
- OpenClaude の `/dev/tty` 直接読み取り → OpenClaude 側の対応が必要
- Windows 版 OpenClaude の配布 → Gitlawb 次第

## 参考
- Windows ConPTY API: https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session
- node-pty Windows ビルド: https://github.com/microsoft/node-pty
