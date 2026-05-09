// ANSI escape を含む出力を行う。透過＋chunk 分断耐性のテスト。
'use strict';
const lines = [
  '\x1b[31m[red] this is red\x1b[0m',
  '\x1b[32m[green] this is green\x1b[0m',
  '\x1b[1;33m[bold yellow]\x1b[0m',
  '\x1b[2J\x1b[H[clear screen]'
];
let i = 0;
const id = setInterval(() => {
  if (i >= lines.length * 50) { clearInterval(id); return; }
  process.stdout.write(lines[i % lines.length] + '\n');
  i++;
}, 5);
