// stdout と stderr を交互に出す
'use strict';
const N = parseInt(process.argv[2] || '500', 10);
let i = 0;
const id = setInterval(() => {
  if (i >= N) { clearInterval(id); return; }
  if (i % 2 === 0) process.stdout.write(`OUT line ${i}\n`);
  else process.stderr.write(`ERR line ${i}\n`);
  i++;
}, 1);
