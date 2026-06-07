const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
process.env.NPROXY_AUTO = '1';
const { writeCrashDump, _crashDumpTracker, RATE_LIMIT } = require('../nproxy.js');

const crashDir = path.join(os.tmpdir(), 'nproxy_crashes');

function listDumps(prefix) {
  try {
    return fs.readdirSync(crashDir).filter(f => f.startsWith(prefix || ''));
  } catch (_) {
    return [];
  }
}

function latestDump(prefix) {
  const files = listDumps(prefix);
  if (files.length === 0) return null;
  return path.join(crashDir, files[files.length - 1]);
}

describe('writeCrashDump', () => {
  const dumpFiles = [];

  before(() => {
    fs.mkdirSync(crashDir, { recursive: true });
  });

  after(() => {
    for (const f of dumpFiles) {
      try { fs.unlinkSync(f); } catch (_) {}
    }
  });

  afterEach(() => {
    _crashDumpTracker.clear();
  });

  it('writes a crash dump file to tmpdir', () => {
    const w = (msg) => {};
    writeCrashDump('test_reason', 'monitoring', 0, w);

    const files = listDumps('nproxy_crash_');
    assert.ok(files.length > 0, 'crash dump file should exist in tmpdir');
    const dumpFile = latestDump('nproxy_crash_');
    assert.ok(dumpFile);
    dumpFiles.push(dumpFile);

    const content = JSON.parse(fs.readFileSync(dumpFile, 'utf8'));
    assert.strictEqual(content.reason, 'test_reason');
    assert.strictEqual(content.state, 'monitoring');
    assert.strictEqual(content.retries, 0);
    assert.ok(content.timestamp);
    assert.ok(content.memory);
    assert.ok(content.memory.rss_mb > 0);
    assert.ok(content.v8);
    assert.ok(content.v8.heap_size_limit_mb > 0);
    assert.ok(content.process);
    assert.strictEqual(content.process.pid, process.pid);
  });

  it('writes emergency dump with different prefix', () => {
    const w = (msg) => {};
    writeCrashDump('emergency_no_recovery', 'emergency', 25, w);

    const files = listDumps('nproxy_emergency_');
    assert.ok(files.length > 0, 'emergency crash dump file should exist');
    const dumpFile = latestDump('nproxy_emergency_');
    assert.ok(dumpFile);
    dumpFiles.push(dumpFile);

    const content = JSON.parse(fs.readFileSync(dumpFile, 'utf8'));
    assert.strictEqual(content.reason, 'emergency_no_recovery');
    assert.strictEqual(content.state, 'emergency');
    assert.strictEqual(content.retries, 25);
  });

  it('writes stderr messages via writer function', () => {
    const lines = [];
    const w = (msg) => { lines.push(msg); };
    writeCrashDump('stderr_test', 'critical', 3, w);
    assert.ok(lines.length > 0);
    const all = lines.join('');
    assert.ok(all.includes('stderr_test'));
    assert.ok(all.includes('RSS:'));
    assert.ok(all.includes('heap:'));
  });

  it('handles writer function error gracefully', () => {
    writeCrashDump('no_writer', 'monitoring', 0, null);
    writeCrashDump('undefined_writer', 'monitoring', 0, undefined);
  });

  it('rate limits repeated dumps with same reason', () => {
    const w = (msg) => {};
    const beforeCount = listDumps('nproxy_crash_').length;

    for (let i = 0; i < RATE_LIMIT.normal.maxCount; i++) {
      writeCrashDump('rate_limit_test', 'monitoring', 0, w);
    }
    const afterCount = listDumps('nproxy_crash_').length;
    assert.strictEqual(afterCount - beforeCount, RATE_LIMIT.normal.maxCount);

    writeCrashDump('rate_limit_test', 'monitoring', 0, w);
    const finalCount = listDumps('nproxy_crash_').length;
    assert.strictEqual(finalCount, afterCount, 'should not create more files after rate limit');
  });

  it('includes error message and stack in dump', () => {
    const w = (msg) => {};
    const beforeCount = listDumps('nproxy_crash_').length;

    const testError = new Error('test error message');
    testError.stack = 'Error: test error message\n    at test.js:1:1';
    writeCrashDump('error_test', 'monitoring', 0, w, testError);

    const afterCount = listDumps('nproxy_crash_').length;
    assert.strictEqual(afterCount - beforeCount, 1);

    const dumpFile = latestDump('nproxy_crash_');
    assert.ok(dumpFile);
    const content = JSON.parse(fs.readFileSync(dumpFile, 'utf8'));
    assert.ok(content.error);
    assert.strictEqual(content.error.message, 'test error message');
    assert.ok(content.error.stack.includes('test error message'));
  });

  it('includes child info in dump', () => {
    const w = (msg) => {};
    const beforeCount = listDumps('nproxy_crash_').length;

    const childInfo = { exitCode: 1, command: '/usr/bin/node', args: ['-e', 'throw'] };
    writeCrashDump('child_exit', 'monitoring', 0, w, null, childInfo);

    const afterCount = listDumps('nproxy_crash_').length;
    assert.strictEqual(afterCount - beforeCount, 1);

    const dumpFile = latestDump('nproxy_crash_');
    assert.ok(dumpFile);
    const content = JSON.parse(fs.readFileSync(dumpFile, 'utf8'));
    assert.strictEqual(content.reason, 'child_exit');
    assert.ok(content.child);
    assert.strictEqual(content.child.exitCode, 1);
    assert.strictEqual(content.child.command, '/usr/bin/node');
  });
});
