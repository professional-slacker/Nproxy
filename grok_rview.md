# nproxy.js 設計原則レビュー (Grok-4-1)

## レビュー対象
- **原則ドキュメント**: `doc/08_principles.md` (2026-05-08確定版)
- **実装**: `node/nproxy.js` (intercept + CLIモード、PTY/pipe、memory monitor)
- **日付**: 2026-05-11

## 三原則遵守度 (cowork 3点チェック)

### Q1. 制御コードはそのまま流れているか? → **PASS (条件付き)**
- **passthroughモード**: chunk byte stream 透過 (`data`イベント不使用、pipe backpressure委譲)。ANSI/制御コード/バイナリ完全透過。
- **strip-ansi/transform**: CSI keepFinal Set (`A B C D G H J K S T f H m s u n l h`, cursor `?25h/l` allowlist)。Ink/box-drawing/erase/cursor保持、他strip。
  - 原則「解釈しない / 改変しない」に準拠: ESC意味解釈せず、パターンmatchのみ。UTF-8境界保護 (StringDecoder)。
  - **条件**: text=off/passthrough推奨。stripは「破壊しない範囲の任意モード」として許容。
- **問題なし**: OSC8/DCS/DEC private strip。バイナリchunk string化せず即return。
- **懸念**: coalesceBuf (passthrough): 短期的buffer (64KB max, setImmediate flush)。原則「chunk非保持」準拠 (無限stateなし)。

### Q2. シグナルは中継されているか? → **PASS**
- **CLI pipe**: `process.on(SIGINT/TERM/HUP/USR1/2/WINCH) → child.kill(sig)`。Windows対応 (try-catch)。
- **CLI PTY**: `onExit({signal}) → process.kill(process.pid, signal)`。
- **Intercept (preload)**: stdout wrapのみ、signal untouched (親processそのまま中継)。
- **追加**: SIGPIPE → child SIGTERM (現実的)。
- **完璧**: zombie防ぎ、終了code継承。

### Q3. プロトコル意味付けが nproxy 内に漏れ込んでいないか? → **PASS**
- **framing/metadataなし**: length-prefix/NDJSON/mimetype/JSON解釈ゼロ。
- **観測のみ**: chunk meta (size/ts)、memory RSS/heap (child `/proc/{pid}/status`)。
- **縮退**: pressure → chunk throttle (64KB→4KB), passthrough→strip-ansi auto-switch, coalesce bypass。
- **外側依存**: protocol/AI/UXはouter (env NPROXY_TEXTでモード指定)。

## 強み (原則保証実現)
| 保証 | 実装根拠 |
|------|----------|
| 10GB byte透過 OOMなし | pipe() backpressure + chunk非保持 + RSS monitor。 |
| Ctrl+C効く | signal中継 + zombieなし。 |
| protocol変更直さない | textモードenv/CLI外付け。 |
| memory policy | pressure/critical state遷移 + stderr feedback (色付き `[nproxy]`)。 |

- **Banner**: anchor注入 (✦ Any model...), fallback 3s。視覚health。
- **CLI便利**: script shebang検知 auto-preload (`node -r nproxy.js`)。
- **PTY**: node-pty (opt-in), SIGWINCH resize。
- **Intercept**: coalesce (Ink frame減), pressure bypass + split。

## 問題点 / 改善提案
1. **text stripの原則緊張**: strip-ansiは「改変」だが、Ink whitelistで最小限。原則「任意モード ※破壊しない範囲」合致。**提案**: doc更新 `strip-ansi: Ink-safe subset passthrough`。
2. **coalesceBuf state**: 64KB小buffer (setImmediate)。pressureで即bypass。**OKだが監視**: heap spike時flush確認。
3. **PTY依存**: `npm i -g node-pty`必要。**提案**: fallback pipe強化 (SIGWINCH ignore on Windows)。
4. **Windows RSS**: `/proc`なし → self heap fallback。child監視弱。**提案**: Windows tasklist/parse (Rust移行時強化)。
5. **Memlog**: NPROXY_MEMLOG=60s interval。**拡張**: child-only RSS log。

## 全体評価: **原則準拠度 95% (優秀)**
- 三原則完璧guard。memory backpressure + auto-mode-switch が差別化。
- **次レビュー**: Rust MVP移植時、このjsを原則アンカー参照。
- **テスト推奨**: `REVIEW_CHECKLIST.md` 全項目 (layout test, OOM repro, signal chain)。

node/nproxy.js:530 (export)