# nproxy 実装レビューチェックリスト

> このチェックリストは以下の絶対要件を実装変更時に守るためのもの。
> **PR / コミット / リリース前**に通すこと。
> **1つでも No があれば設計違反**として変更を差し戻す。

### 絶対要件 (Must)

言語・実装を問わず nproxy の根幹。これらが動かなければ実装失敗。

1. **chunk 非保持** — chunk を passthrough する瞬間以外メモリに留めない。観測は size/ts/kind のメタのみ。違反 → OOM
2. **backpressure 委譲** — 自前バッファ禁止。OS poll の「読まない→詰まる→上流 blocking」に乗る。違反 → flowing-mode 固定で機構破壊
3. **policy は副作用の縮退のみ** — 本流は絶対に止めない／拒否しない。縮退は観測解像度・ring・text mode のみ。違反 → プロキシの存在意義が消える

---

## 使い方

1. 変更対象ファイル一覧を眺める
2. 下記チェックを順に確認
3. 該当しない項目は N/A、それ以外は Yes/No
4. **No が 1 つでもあれば設計違反として差し戻し**

---

## ✅ A. chunk 非保持 (No Chunk Retention)

| # | チェック項目 | OK基準 |
|---|---|---|
| A.1 | chunk をフィールド/クロージャ/コレクションに保持していないか | 中継用バッファは OS の pipe buffer のみ。自前 Vec/Buffer/String で蓄積しない |
| A.2 | 観測用に chunk の参照を保持していないか | 観測は size/ts/kind のメタ情報のみ。chunk 内容は保持しない |
| A.3 | リングバッファはメタ情報のみか | 内容スナップショットではなく size/kind/ts の履歴であること |
| A.4 | 10GB 流しても RSS が一定か | データサイズに対して RSS が非増加であること |
| A.5 | `data` イベントや `read()` の戻り値を別変数に代入して保持していないか | 読み取り→書き込みのライフタイムは同期的に行い、関数スコープを超えて保持しない |

---

## ✅ B. backpressure 委譲 (Delegate to OS-level)

| # | チェック項目 | OK基準 |
|---|---|---|
| B.1 | 読むのを止めることで子の write をブロックしているか | Rust: `Poll::Pending`、Node: `ReadStop`、Go: read しない |
| B.2 | 自前のバッファリングキューを積んでいないか | 内部キュー/チャネル経由で chunk を回していない。OS pipe buffer のみ |
| B.3 | メモリ圧力時に読み出しを間引いているか | Rust: `ReadGate`、Node: `ReadStop`/`ReadStart` 切り替え |
| B.4 | 読み出し再開を正しく通知しているか | `Poll::Pending` の waker / `ReadStart` 呼び出しが存在する |
| B.5 | 子プロセスの write がブロックされても nproxy がハングしないか | SIGTERM 等で正しく解放される経路がある |

---

## ✅ C. policy は副作用の縮退のみ (Policy Reduces Side-effects Only)

| # | チェック項目 | OK基準 |
|---|---|---|
| C.1 | CRITICAL 時も passthrough 自体は動き続けているか | text mode を off にしても byte 層の pipe は止めない |
| C.2 | メモリ圧力時に本流 chunk を **拒否** していないか | `drop()` しない。書き込まない選択はしない |
| C.3 | 縮退対象は観測/ring/text mode のみか | ログレベル低下、ring buffer 縮小、text 変換 off — すべて副作用 |
| C.4 | 状態遷移が本流ループに条件分岐を埋め込んでいないか | policy はサイドカー的に非同期通知。本流は常に同一経路 |

---

## ✅ D. シグナル中継

| # | チェック項目 | OK基準 |
|---|---|---|
| D.1 | SIGINT を親で握りつぶしていないか | `process.on('SIGINT')` 内で `child.kill(sig)` を呼んでいる |
| D.2 | SIGTERM を親で握りつぶしていないか | 同上 |
| D.3 | 子の exit code を親が継承しているか | `process.exit(code)` を呼んでいる |
| D.4 | 子がシグナル終了した場合、親も同じシグナルで終了するか | `process.kill(process.pid, signal)` が走る経路がある |
| D.5 | zombie プロセスを残す可能性がないか | `child.wait()` / `child.on('close')` で確実にリソース解放している |

---

## ✅ E. プロトコル漏れ込み防止

| # | チェック項目 | OK基準 |
|---|---|---|
| E.1 | message framing コードが入っていないか | length-prefix parser/encoder、boundary 検出がない |
| E.2 | NDJSON / JSON-RPC / multipart の解釈がないか | `JSON.parse(chunk)` が本流にない |
| E.3 | filename / mimetype / size などの metadata 付与処理がないか | これらの key を作る/読む処理が本流にない |
| E.4 | サイズ上限を **強制** (拒否) していないか | 観測ログに警告は出しても本流は止めない |
| E.5 | 認証・暗号化・圧縮を nproxy 内で行っていないか | これらは外部の責務 |
| E.6 | アプリ依存の設定 (LLM endpoint 等) を読み込んでいないか | nproxy の env 変数は I/O 制御だけに限る |

---

## ✅ F. 性能基準 (補助)

原則 A〜C を守った上で、性能基準も維持する。

| # | チェック項目 | 基準 (Node / Rust) |
|---|---|---|
| F.1 | 10GB byte 透過のスループット | ≥ 800 MB/s |
| F.2 | 10GB byte 透過時の RSS (max) | データサイズに対してフラット |
| F.3 | 10GB text passthrough の RSS (max) | ≤ 30 MB |
| F.4 | UTF-8 chunk 境界保護 | byteIntegrity = true |
| F.5 | PRESSURE/CRITICAL 状態遷移テスト | 動作確認済み |
| F.6 | 既存テストスイート | 全 PASS |

---

## レビュー結果テンプレ (PR 本文に貼る)

```markdown
## nproxy Review Checklist

### A. chunk 非保持
- [ ] A.1 chunk を保持していない
- [ ] A.2 観測はメタのみ
- [ ] A.3 ring はメタ情報のみ
- [ ] A.4 大容量で RSS 一定
- [ ] A.5 読み取り後即書き込み

### B. backpressure 委譲
- [ ] B.1 読まないで止めている
- [ ] B.2 自前キューがない
- [ ] B.3 圧力時に読み出し間引き
- [ ] B.4 再開通知がある
- [ ] B.5 ハングしない

### C. policy 縮退のみ
- [ ] C.1 本流は動き続ける
- [ ] C.2 chunk を拒否しない
- [ ] C.3 縮退は副作用のみ
- [ ] C.4 サイドカー方式

### D. シグナル中継
- [ ] D.1 SIGINT 中継
- [ ] D.2 SIGTERM 中継
- [ ] D.3 exit code 継承
- [ ] D.4 シグナル伝播
- [ ] D.5 zombie 禁止

### E. プロトコル漏れ込み
- [ ] E.1 framing なし
- [ ] E.2 JSON 解釈なし
- [ ] E.3 metadata 付与なし
- [ ] E.4 サイズ強制なし
- [ ] E.5 認証/暗号化なし
- [ ] E.6 アプリ設定なし

### F. 性能基準
- [ ] F.1 ≥ 800 MB/s
- [ ] F.2 RSS フラット
- [ ] F.3 text RSS ≤ 30MB
- [ ] F.4 UTF-8 境界保護
- [ ] F.5 状態遷移テスト
- [ ] F.6 既存テスト PASS
```

---

## 失敗例 (Anti-pattern)

```js
// ❌ NG: data イベントで chunk を保持 (A.1 違反)
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
});

// ❌ NG: 自前リングバッファで chunk をキューイング (B.2 違反)
const queue = [];
child.stdout.on('data', (chunk) => { queue.push(chunk); });

// ❌ NG: サイズ上限で本流を止める (C.2 違反)
if (totalBytes > MAX) { child.kill(); }

// ❌ NG: SIGINT を握りつぶす (D.1 違反)
process.on('SIGINT', () => {});

// ❌ NG: framing を nproxy 内に (E.1 違反)
function parseFrame(chunk) { /* length-prefix parser */ }
```

```js
// ✅ OK: pipe で透過
child.stdout.pipe(process.stdout);

// ✅ OK: メタだけ観測
process.stdout.write = (chunk, ...rest) => {
  Observer.onChunk('out', chunk.length);   // size のみ
  return orig(chunk, ...rest);             // chunk は触らない
};

// ✅ OK: シグナル中継
process.on('SIGINT', () => child.kill('SIGINT'));

// ✅ OK: 観測としてのサイズ警告 (C.2 違反しない)
if (totalBytes > WARN_THRESHOLD) log('[WARN] large transfer');
```

---

## 改訂履歴

| 日付 | 内容 |
|---|---|
| 2026-05-08 | 初版作成 |
| 2026-05-10 | 絶対要件ベースに全面改訂 (chunk非保持/backpressure委譲/policy縮退のみ) |
