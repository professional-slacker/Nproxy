// 巨大ファイルを fs.createReadStream で読み込み、stdout に流す。
// fs I/O 起因のメモリ圧力が間接的に親に届くか（流量経由で）の確認。
'use strict';
const fs = require('fs');
const path = process.argv[2];
if (!path) {
  process.stderr.write('usage: node app_fs_huge.js <file>\n');
  process.exit(2);
}
const rs = fs.createReadStream(path);
rs.on('end', () => process.stderr.write('[app_fs_huge] end\n'));
rs.on('error', (e) => {
  process.stderr.write(`[app_fs_huge] error: ${e.message}\n`);
  process.exit(1);
});
rs.pipe(process.stdout);
