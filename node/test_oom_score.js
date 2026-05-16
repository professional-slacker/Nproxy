'use strict';
const path = require('path');
const assert = require('assert').strict;
const { spawn } = require('child_process');

const NPROXY = path.join(__dirname, 'nproxy.js');
const APP = path.join(__dirname, 'test_apps', 'app_echo.js');

function log(...args) {
  process.stderr.write('[oom_score_test] ' + args.join(' ') + '\n');
}

// ---- 1. OOMスコアが設定される ----
async function test_oom_score_set() {
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
      // OOMスコアのメッセージが表示されることを確認
      if (process.platform === 'linux') {
        assert.ok(
          stderr.includes('child OOM score adjusted to') || stderr.includes('warning: could not adjust OOM score'),
          'OOM score message should be present'
        );
      }
      log('PASS oom_score_set -> stderr:', JSON.stringify(stderr.substring(0, 100)));
      resolve();
    });

    child.on('error', reject);
  });
}

// ---- 2. OOMスコアの環境変数が機能する ----
async function test_oom_score_env() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [NPROXY, APP], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NPROXY_OOM_SCORE_ADJ: '-1000' },
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.stdin.write('hello\n');
    child.stdin.end();

    child.on('close', (code) => {
      // -1000のOOMスコアが設定されることを確認
      if (process.platform === 'linux') {
        assert.ok(
          stderr.includes('child OOM score adjusted to -1000') || stderr.includes('warning: could not adjust OOM score'),
          'OOM score message should show -1000'
        );
      }
      log('PASS oom_score_env -> stderr:', JSON.stringify(stderr.substring(0, 100)));
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
  log('Starting OOM score tests...');

  try {
    await test_oom_score_set();
    await test_oom_score_env();
    await test_child_works();
    log('All OOM score tests passed!');
  } catch (err) {
    log('FAIL:', err.message);
    process.exit(1);
  }
}

main();
