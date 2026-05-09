// 指定 MB の ASCII テキストを stdout に出す。
// 1 行 = 64 バイト (63文字 + \n)。改行ありで Text I/O テスト用。
'use strict';
const targetMB = parseInt(process.argv[2] || '100', 10);
const target = targetMB * 1024 * 1024;
const lineBody = 'A'.repeat(63);   // 63 chars
const line = lineBody + '\n';      // 64 bytes
const lineBuf = Buffer.from(line, 'utf8');
// chunk 単位は 64KB = 1024 行ぶん
const chunkLines = 1024;
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
  process.stderr.write(`[app_text_ascii] done. wrote ${written} bytes\n`);
}
loop();
