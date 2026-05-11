'use strict';
// Memory hog test app: allocates memory in steps and reports usage.
// Used to verify nproxy memory backpressure.

const SLOW_ALLOC_MB = 512;    // grow slowly to this
const BURST_ALLOC_MB = 2048;  // then burst to trigger OOM guard
const HOLD_MS = 3000;

const chunks = [];

function report(msg, mb) {
  process.stdout.write(`[memhog] ${msg}: ${Math.round(mb)}MB\n`);
}

function alloc(mb) {
  // Allocate ~mb megabytes using Buffers (won't be GC'd until replaced)
  const size = Math.min(mb, 128); // 128MB per chunk to avoid fragmentation
  for (let i = 0; i < Math.ceil(mb / size); i++) {
    const buf = Buffer.alloc(size * 1024 * 1024, 'x');
    chunks.push(buf);
  }
}

async function main() {
  const mode = process.argv[2] || 'slow';
  
  if (mode === 'slow') {
    report('slow-alloc-start', SLOW_ALLOC_MB);
    // Allocate gradually
    for (let step = 64; step <= SLOW_ALLOC_MB; step += 64) {
      alloc(64);
      report('progress', step);
      await new Promise(r => setTimeout(r, HOLD_MS));
    }
    report('slow-alloc-done', SLOW_ALLOC_MB);
  } else if (mode === 'burst') {
    report('burst-alloc-start', BURST_ALLOC_MB);
    alloc(BURST_ALLOC_MB);
    report('burst-alloc-done', BURST_ALLOC_MB);
  } else if (mode === 'stream') {
    // Continuous streaming output (simulates Ink output under pressure)
    report('stream-start', 0);
    for (let i = 0; i < 500; i++) {
      process.stdout.write(`LINE ${i}: ${'x'.repeat(80)}\n`);
      await new Promise(r => setTimeout(r, 50));
    }
    report('stream-done', 0);
  }
  
  // Hold to observe state
  await new Promise(r => setTimeout(r, 10000));
  report('exiting', 0);
}

main().catch(e => {
  process.stderr.write(`Error: ${e.message}\n`);
  process.exit(1);
});
