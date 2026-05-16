'use strict';
const path = require('path');
const assert = require('assert').strict;
const { spawn } = require('child_process');

const NPROXY = path.join(__dirname, 'nproxy.js');
const APP = path.join(__dirname, 'test_apps', 'app_echo.js');

function log(...args) {
  process.stderr.write('[async_write_test] ' + args.join(' ') + '\n');
}

// ---- 1. passthroughモードで同期writeが動作する ----
async function test_passthrough_sync() {
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
      assert.ok(stdout.includes('hello'), 'passthrough should echo data');
      log('PASS passthrough_sync -> stdout:', JSON.stringify(stdout.substring(0, 50)));
      resolve();
    });

    child.on('error', reject);
  });
}

// ---- 2. strip-ansiモードで非同期writeが動作する ----
async function test_strip_ansi_async() {
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
      assert.ok(stdout.includes('hello'), 'strip-ansi should echo data');
      log('PASS strip_ansi_async -> stdout:', JSON.stringify(stdout.substring(0, 50)));
      resolve();
    });

    child.on('error', reject);
  });
}

// ---- 3. transformモードで非同期writeが動作する ----
async function test_transform_async() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [NPROXY, '--text=transform', APP], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stdin.write('hello\n');
    child.stdin.end();

    child.on('close', (code) => {
      assert.ok(stdout.includes('hello'), 'transform should echo data');
      log('PASS transform_async -> stdout:', JSON.stringify(stdout.substring(0, 50)));
      resolve();
    });

    child.on('error', reject);
  });
}

// ---- 4. 順序保証: 複数のwriteが順序通りに処理される ----
async function test_ordering_async() {
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
      log('PASS ordering_async -> stdout:', JSON.stringify(stdout.substring(0, 100)));
      resolve();
    });

    child.on('error', reject);
  });
}

// ---- 5. 大きなデータが非同期writeで正しく処理される ----
async function test_large_data_async() {
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
      log('PASS large_data_async -> stdout length:', stdout.length);
      resolve();
    });

    child.on('error', reject);
  });
}

// ---- メイン ----
async function main() {
  log('Starting async write tests...');

  try {
    await test_passthrough_sync();
    await test_strip_ansi_async();
    await test_transform_async();
    await test_ordering_async();
    await test_large_data_async();
    log('All async write tests passed!');
  } catch (err) {
    log('FAIL:', err.message);
    process.exit(1);
  }
}

main();
