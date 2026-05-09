// chunk境界破壊テスト用。マルチバイト文字を確実に「途中で」切るチャンク分割で書く。
// 「あ」(E3 81 82) を1万回出力するが、3バイトをわざと chunk 境界でばらす:
//   chunk[0] = "E3 81"  (2 bytes)
//   chunk[1] = "82 E3 81 82 ..." (本来の続き + 次の文字達)
// これを許せば結果のテキストには U+FFFD が混入する。
// nproxy が正しく StringDecoder を使っていれば、出力は元と完全一致する。
'use strict';
const N = parseInt(process.argv[2] || '10000', 10);
const ch = Buffer.from('あ', 'utf8');  // E3 81 82
// 全部繋げてから細かいchunkに分割する
const all = Buffer.alloc(ch.length * N);
for (let i = 0; i < N; i++) ch.copy(all, i * ch.length);
// 1バイト, 2バイト, 3バイト, 5バイト... の不揃いchunkに分けて書く
let pos = 0;
const sizes = [1, 2, 3, 5, 7, 11, 13];
let i = 0;
function loop() {
  while (pos < all.length) {
    const sz = sizes[i++ % sizes.length];
    const slice = all.slice(pos, Math.min(pos + sz, all.length));
    const ok = process.stdout.write(slice);
    pos += slice.length;
    if (!ok) { process.stdout.once('drain', loop); return; }
  }
  process.stderr.write(`[app_text_boundary] wrote ${pos} bytes (${N} 'あ' chars)\n`);
}
loop();
