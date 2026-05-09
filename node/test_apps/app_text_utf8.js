// 指定 MB の UTF-8 マルチバイトテキストを stdout に出す。
// 1 行 = 「あいうえお」を10回 + 改行 = 30文字 * 3バイト + 1 = 91バイト
// chunk境界がマルチバイトの中で切れてもStringDecoderで正しく復元できるかテスト
'use strict';
const targetMB = parseInt(process.argv[2] || '100', 10);
const target = targetMB * 1024 * 1024;
const lineBody = 'あいうえお'.repeat(10);
const line = lineBody + '\n';
const lineBuf = Buffer.from(line, 'utf8');  // 91 bytes
// chunk = 大体 64KB ぶんの行を一気に
const chunkLines = Math.floor(64 * 1024 / lineBuf.length);
const chunkBuf = Buffer.alloc(lineBuf.length * chunkLines);
for (let i = 0; i < chunkLines; i++) {
  lineBuf.copy(chunkBuf, i * lineBuf.length);
}
let written = 0;
function loop() {
  while (written < target) {
    const left = target - written;
    const buf = (left < chunkBuf.length) ? chunkBuf.slice(0, left) : chunkBuf;
    const ok = process.stdout.write(buf);
    written += buf.length;
    if (!ok) {
      process.stdout.once('drain', loop);
      return;
    }
  }
  process.stderr.write(`[app_text_utf8] done. wrote ${written} bytes\n`);
}
loop();
