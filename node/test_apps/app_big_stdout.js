// 指定 MB を chunk 64KB で stdout に書く。stdout backpressure テスト用。
'use strict';
const targetMB = parseInt(process.argv[2] || '100', 10);
const chunkSize = 64 * 1024;
const chunk = Buffer.alloc(chunkSize, 0x41); // 'A'

let written = 0;
const target = targetMB * 1024 * 1024;

function writeMore() {
  while (written < target) {
    const ok = process.stdout.write(chunk);
    written += chunkSize;
    if (!ok) {
      // backpressure。drain を待つ
      process.stdout.once('drain', writeMore);
      return;
    }
  }
  process.stderr.write(`[app_big_stdout] done. wrote ${written} bytes\n`);
}
writeMore();
