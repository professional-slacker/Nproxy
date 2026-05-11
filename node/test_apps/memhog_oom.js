'use strict';
// Memory hog: fills V8 heap with JS objects to trigger real OOM.
// With NPROXY_AUTO=1, nproxy should detect pressure and apply backpressure.
// With NPROXY_AUTO=0, node should crash with OOM at ~256MB (--max-old-space-size).

const TARGET_HOGS = parseInt(process.argv[2] || '2000000', 10);
const BATCH_SIZE = 20000;
const HOLD_MS = 300;

const hogs = [];

function log(msg) {
  process.stderr.write(`[memhog] ${msg}\n`);
}

function allocateBatch(n) {
  for (let i = 0; i < n; i++) {
    // Create large objects to fill V8 heap quickly
    const obj = {};
    for (let k = 0; k < 50; k++) {
      obj['k' + k] = 'x'.repeat(100);
    }
    hogs.push(obj);
  }
}

async function main() {
  log(`target=${TARGET_HOGS} objects`);

  let total = 0;
  for (let batch = 0; total < TARGET_HOGS; batch++) {
    allocateBatch(BATCH_SIZE);
    total += BATCH_SIZE;
    log(`allocated ${total} objects`);
    await new Promise(r => setTimeout(r, HOLD_MS));
  }

  log(`reached ${TARGET_HOGS} objects — survived!`);
  log('NPROXY_GUARD=ACTIVE');

  await new Promise(r => setTimeout(r, 5000));
  log('exiting normally');
}

main().catch(e => {
  log(`FATAL: ${e.message}`);
  process.exit(1);
});
