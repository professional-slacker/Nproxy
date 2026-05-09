// stdin の内容をそのまま stdout に流す。透過テスト用。
'use strict';
process.stdin.pipe(process.stdout);
process.stdin.on('end', () => {
  process.stderr.write(`[app_echo] end of stdin\n`);
});
