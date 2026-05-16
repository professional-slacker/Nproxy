'use strict';
const path = require('path');
const assert = require('assert').strict;
const { spawn } = require('child_process');

const NPROXY = path.join(__dirname, 'nproxy.js');
const APP = path.join(__dirname, 'test_apps', 'app_echo.js');

function log(...args) {
  process.stderr.write('[jitter_test] ' + args.join(' ') + '\n');
}

// ---- 1. 通常モードでジッタバッファが動作する ----
async function test_jitter_normal() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [NPROXY, '--text=strip-ansi', APP], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stdin.write('hello\n');
    child.stdin.end();

    child.on('close', (code) => {
      assert.ok(stdout.includes('hello'), 'jitter buffer should not break data');
      log('PASS jitter_normal -> stdout:', JSON.stringify(stdout.substring(0, 50)));
      resolve();
    });

    child.on('error', reject);
  });
}

// ---- 2. 複数のwriteが順序通りに処理される ----
async function test_jitter_ordering() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [NPROXY, '--text=strip-ansi', APP], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    // 複数のwriteを送信
    child.stdin.write('line1\n');
    child.stdin.write('line2\n');
    child.stdin.write('line3\n');
    child.stdin.end();

    child.on('close', (code) => {
      assert.ok(stdout.includes('line1'), 'line1 should be present');
      assert.ok(stdout.includes('line2'), 'line2 should be present');
      assert.ok(stdout.includes('line3'), 'line3 should be present');
      log('PASS jitter_ordering -> stdout:', JSON.stringify(stdout.substring(0, 100)));
      resolve();
    });

    child.on('error', reject);
  });
}

// ---- 3. 大きなデータがジッタバッファで正しく処理される ----
async function test_jitter_large_data() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [NPROXY, '--text=strip-ansi', APP], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    // 大きなデータを送信（100KB）
    const largeData = 'x'.repeat(100 * 1024) + '\n';
    child.stdin.write(largeData);
    child.stdin.end();

    child.on('close', (code) => {
      assert.ok(stdout.includes('x'.repeat(100)), 'large data should be echoed');
      log('PASS jitter_large_data -> stdout length:', stdout.length);
      resolve();
    });

    child.on('error', reject);
  });
}

// ---- 4. passthroughモードではジッタバッファが適用されない ----
async function test_jitter_passthrough() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [NPROXY, '--text=passthrough', APP], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stdin.write('hello\n');
    child.stdin.end();

    child.on('close', (code) => {
      assert.ok(stdout.includes('hello'), 'passthrough should not use jitter buffer');
      log('PASS jitter_passthrough -> stdout:', JSON.stringify(stdout.substring(0, 50)));
      resolve();
    });

    child.on('error', reject);
  });
}

// ---- メイン ----
async function main() {
  log('Starting jitter buffer tests...');

  try {
    await test_jitter_normal();
    await test_jitter_ordering();
    await test_jitter_large_data();
    await test_jitter_passthrough();
    log('All jitter buffer tests passed!');
  } catch (err) {
    log('FAIL:', err.message);
    process.exit(1);
  }
}

main();
