#!/usr/bin/env node
// nproxy.js static test runner
// Usage: node run_all.js
'use strict';

const { run } = require('node:test');
const path = require('path');
const fs = require('fs');

const testDir = __dirname;
const testFiles = fs.readdirSync(testDir)
  .filter(f => f.startsWith('test_') && f.endsWith('.js'))
  .map(f => path.join(testDir, f))
  .sort();

console.log(`nproxy.js static test suite (${testFiles.length} test files)`);
console.log('='.repeat(60));

run({
  files: testFiles,
  concurrency: false,
  timeout: 30000,
}).then(() => {
  console.log('='.repeat(60));
  console.log('All tests completed.');
}).catch((err) => {
  console.error('Test run failed:', err);
  process.exit(1);
});
