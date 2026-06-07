# 三号機 (Alienware m15 / Windows 11) nproxy 検証メモ

## 環境
- **OS**: Windows 11
- **Node.js**: v24.15.0 (standalone zip, ポータブル版)
- **シェル**: PowerShell 7 / cmd
- **GPU**: NVIDIA 8GB (Alienware m15)

## Node.js セットアップ
- `C:\nproxy\node-v24.15.0-win-x64` に展開
- または `c:\work\Nproxy` にリポジトリを git clone

## 検証結果 (2026-05-15)

### preload mode 基本動作 ✅
```powershell
.\node.exe -r c:\work\Nproxy\node\nproxy.js -e "console.log('ok')"
```
- バナー表示: OK
- プロセス正常終了: OK (Linuxの `-e` hang は Windows では発生しない)

### tty 検出 ✅
```powershell
.\node.exe -r c:\work\Nproxy\node\nproxy.js -e "require('fs').writeFileSync('tty.txt', String(process.stdin.isTTY))"
```
- `tty.txt` → `true` (実ターミナルとして認識)

### 環境変数の設定方法
PowerShell 7:
```powershell
$env:NPROXY_TEXT="passthrough"; .\node.exe -r c:\work\Nproxy\node\nproxy.js -e "console.log('ok')"
```

cmd:
```cmd
set NPROXY_TEXT=passthrough
node.exe -r c:\work\Nproxy\node\nproxy.js -e "console.log('ok')"
```

## 特記事項
- Linux の `-e` preload mode で発生する hang バグは Windows では再現しない
- Node v24.15.0 でも正常動作 (Node v22 系でもおそらく問題ない)
- Visual Studio Pro が入っているので nheap_limit C++ addon のビルドが可能
- WSL2 にも環境あり (Ollama QWEN2:B7, Claude, Copilot)
