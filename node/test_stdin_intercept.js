'use strict';
const path = require('path');
const assert = require('assert').strict;
const { spawn } = require('child_process');

const NPROXY = path.join(__dirname, 'nproxy.js');
const APP = path.join(__dirname, 'test_apps', 'app_stdin_echo.js');

function log(...args) {
  process.stderr.write('[stdin_test] ' + args.join(' ') + '\n');
}

// ---- 1. stdinがnproxyを経由して子プロセスに届く ----
async function test_stdin_intercept() {
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
      assert.strictEqual(stdout, 'hello\n', 'stdin should be echoed through nproxy');
      log('PASS stdin_intercept -> stdout:', JSON.stringify(stdout));
      resolve();
    });

    child.on('error', reject);
  });
}

// ---- 2. 複数行のstdinが順序通りに届く ----
async function test_stdin_ordering() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [NPROXY, APP], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    // 複数行を送信
    child.stdin.write('line1\n');
    child.stdin.write('line2\n');
    child.stdin.write('line3\n');
    child.stdin.end();

    child.on('close', (code) => {
      assert.strictEqual(stdout, 'line1\nline2\nline3\n', 'stdin order should be preserved');
      log('PASS stdin_ordering -> stdout:', JSON.stringify(stdout));
      resolve();
    });

    child.on('error', reject);
  });
}

// ---- 3. 大きなデータのstdinが正しく届く ----
async function test_stdin_large_data() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [NPROXY, APP], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    // 大きなデータを送信（1MB）
    const largeData = 'x'.repeat(1024 * 1024) + '\n';
    child.stdin.write(largeData);
    child.stdin.end();

    child.on('close', (code) => {
      assert.strictEqual(stdout, largeData, 'large stdin data should be preserved');
      log('PASS stdin_large_data -> length:', stdout.length);
      resolve();
    });

    child.on('error', reject);
  });
}

// ---- 4. stdinが閉じられると子プロセスのstdinも閉じる ----
async function test_stdin_end_propagation() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [NPROXY, APP], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    // すぐにstdinを閉じる
    child.stdin.end();

    child.on('close', (code) => {
      assert.strictEqual(stdout, '', 'stdin end should propagate to child');
      log('PASS stdin_end_propagation -> code:', code);
      resolve();
    });

    child.on('error', reject);
  });
}

// ---- メイン ----
async function main() {
  log('Starting stdin intercept tests...');

  try {
    await test_stdin_intercept();
    await test_stdin_ordering();
    await test_stdin_large_data();
    await test_stdin_end_propagation();
    log('All stdin intercept tests passed!');
  } catch (err) {
    log('FAIL:', err.message);
    process.exit(1);
  }
}

main();
