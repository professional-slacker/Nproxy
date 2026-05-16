'use strict';
// stdinからの入力をstdoutにエコーするテストアプリ
// nproxyのstdin介在をテストするために使用

process.stdin.on('data', (chunk) => {
  process.stdout.write(chunk);
});

process.stdin.on('end', () => {
  process.exit(0);
});
