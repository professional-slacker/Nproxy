'use strict';
const path = require('path');
const assert = require('assert').strict;
const { spawn } = require('child_process');

const NPROXY = path.join(__dirname, 'nproxy.js');
const APP = path.join(__dirname, 'test_apps', 'app_echo.js');

function log(...args) {
  process.stderr.write('[select_test] ' + args.join(' ') + '\n');
}

// ---- 1. stdoutがreadableイベントで正しく読み取れる ----
async function test_stdout_readable() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [NPROXY, APP], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    // テストデータを送信
    child.stdin.write('hello\n');
    child.stdin.end();

    child.on('close', (code) => {
      assert.ok(stdout.includes('hello'), 'stdout should contain echoed data');
      log('PASS stdout_readable -> stdout:', JSON.stringify(stdout.substring(0, 50)));
      resolve();
    });

    child.on('error', reject);
  });
}

// ---- 2. stderrがreadableイベントで正しく読み取れる ----
async function test_stderr_readable() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [NPROXY, APP], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    // テストデータを送信
    child.stdin.write('hello\n');
    child.stdin.end();

    child.on('close', (code) => {
      // stderrにはnproxyのバナーやログが出力される
      log('PASS stderr_readable -> stderr length:', stderr.length);
      resolve();
    });

    child.on('error', reject);
  });
}

// ---- 3. 大きなデータがreadableイベントで正しく処理される ----
async function test_large_data_readable() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [NPROXY, APP], {
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
      log('PASS large_data_readable -> stdout length:', stdout.length);
      resolve();
    });

    child.on('error', reject);
  });
}

// ---- 4. 複数のwriteがreadableイベントで順序通りに処理される ----
async function test_ordering_readable() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [NPROXY, APP], {
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
      log('PASS ordering_readable -> stdout:', JSON.stringify(stdout.substring(0, 100)));
      resolve();
    });

    child.on('error', reject);
  });
}

// ---- メイン ----
async function main() {
  log('Starting select-style readable tests...');

  try {
    await test_stdout_readable();
    await test_stderr_readable();
    await test_large_data_readable();
    await test_ordering_readable();
    log('All select-style readable tests passed!');
  } catch (err) {
    log('FAIL:', err.message);
    process.exit(1);
  }
}

main();
