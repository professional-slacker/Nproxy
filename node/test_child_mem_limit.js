'use strict';
const path = require('path');
const assert = require('assert').strict;
const { spawn } = require('child_process');

const NPROXY = path.join(__dirname, 'nproxy.js');
const APP = path.join(__dirname, 'test_apps', 'app_echo.js');

function log(...args) {
  process.stderr.write('[mem_limit_test] ' + args.join(' ') + '\n');
}

// ---- 1. 子プロセスのメモリ制限が設定される ----
async function test_mem_limit_set() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [NPROXY, APP], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.stdin.write('hello\n');
    child.stdin.end();

    child.on('close', (code) => {
      // メモリ制限のメッセージが表示されることを確認
      if (process.platform !== 'win32') {
        assert.ok(
          stderr.includes('child memory limit set to') || stderr.includes('warning: could not set child memory limit'),
          'memory limit message should be present'
        );
        // Verify address space comment in message
        if (stderr.includes('child memory limit set to')) {
          assert.ok(stderr.includes('address space'), 'should indicate address space limit');
        }
      }
      log('PASS mem_limit_set -> stderr:', JSON.stringify(stderr.substring(0, 100)));
      resolve();
    });

    child.on('error', reject);
  });
}

// ---- 2. メモリ制限の環境変数が機能する ----
async function test_mem_limit_env() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [NPROXY, APP], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NPROXY_CHILD_MEM_LIMIT_MB: '512' },
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.stdin.write('hello\n');
    child.stdin.end();

    child.on('close', (code) => {
      // 512MBのメモリ制限が設定されることを確認
      if (process.platform !== 'win32') {
        assert.ok(
          stderr.includes('child memory limit set to 512MB') || stderr.includes('warning: could not set child memory limit'),
          'memory limit message should show 512MB'
        );
      }
      log('PASS mem_limit_env -> stderr:', JSON.stringify(stderr.substring(0, 100)));
      resolve();
    });

    child.on('error', reject);
  });
}

// ---- 3. 子プロセスが正常に動作する ----
async function test_child_works() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [NPROXY, APP], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stdin.write('hello\n');
    child.stdin.end();

    child.on('close', (code) => {
      assert.ok(stdout.includes('hello'), 'child should echo data');
      log('PASS child_works -> stdout:', JSON.stringify(stdout.substring(0, 50)));
      resolve();
    });

    child.on('error', reject);
  });
}

// ---- メイン ----
async function main() {
  log('Starting child memory limit tests...');

  try {
    await test_mem_limit_set();
    await test_mem_limit_env();
    await test_child_works();
    log('All child memory limit tests passed!');
  } catch (err) {
    log('FAIL:', err.message);
    process.exit(1);
  }
}

main();
