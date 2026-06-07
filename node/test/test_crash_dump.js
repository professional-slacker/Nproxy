const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
process.env.NPROXY_AUTO = '1'; // Prevent intercept() on require
const { writeCrashDump, _crashDumpTracker, RATE_LIMIT } = require('../nproxy.js');

describe('writeCrashDump', () => {
  const cwd = process.cwd();
  const dumpFiles = [];

  after(() => {
    for (const f of dumpFiles) {
      try { fs.unlinkSync(f); } catch (_) {}
    }
  });

  // Reset rate limiter between tests
  afterEach(() => {
    _crashDumpTracker.clear();
  });

  it('writes a crash dump file with JSON content', () => {
    const w = (msg) => {}; // silent writer
    writeCrashDump('test_reason', 'monitoring', 0, w);

    // Find the dump file (newest)
    const files = fs.readdirSync(cwd).filter(f => f.startsWith('nproxy_crash_'));
    assert.ok(files.length > 0, 'crash dump file should exist');
    const dumpFile = path.join(cwd, files[files.length - 1]);
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

  it('writes crash dump with retry count', () => {
    const w = (msg) => {};
    writeCrashDump('emergency_no_recovery', 'emergency', 25, w);

    // Find the emergency dump file (different prefix)
    const files = fs.readdirSync(cwd).filter(f => f.startsWith('nproxy_emergency_'));
    assert.ok(files.length > 0, 'emergency crash dump file should exist');
    const dumpFile = path.join(cwd, files[files.length - 1]);
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
    assert.ok(lines.length > 0, 'should write to stderr');
    const all = lines.join('');
    assert.ok(all.includes('stderr_test'));
    assert.ok(all.includes('RSS:'));
    assert.ok(all.includes('heap:'));
  });

  it('handles writer function error gracefully', () => {
    // Should not throw
    writeCrashDump('no_writer', 'monitoring', 0, null);
    // Should not throw when writer is undefined
    writeCrashDump('undefined_writer', 'monitoring', 0, undefined);
  });

  it('rate limits repeated dumps with same reason', () => {
    const w = (msg) => {};
    const beforeCount = fs.readdirSync(cwd).filter(f => f.startsWith('nproxy_crash_')).length;
    
    // Write up to maxCount
    for (let i = 0; i < RATE_LIMIT.normal.maxCount; i++) {
      writeCrashDump('rate_limit_test', 'monitoring', 0, w);
    }
    const afterCount = fs.readdirSync(cwd).filter(f => f.startsWith('nproxy_crash_')).length;
    assert.strictEqual(afterCount - beforeCount, RATE_LIMIT.normal.maxCount);

    // Next write should be rate limited (no new file)
    writeCrashDump('rate_limit_test', 'monitoring', 0, w);
    const finalCount = fs.readdirSync(cwd).filter(f => f.startsWith('nproxy_crash_')).length;
    assert.strictEqual(finalCount, afterCount, 'should not create more files after rate limit');
  });

  it('includes error message and stack in dump', () => {
    const w = (msg) => {};
    const beforeCount = fs.readdirSync(cwd).filter(f => f.startsWith('nproxy_crash_')).length;
    
    const testError = new Error('test error message');
    testError.stack = 'Error: test error message\n    at test.js:1:1';
    writeCrashDump('error_test', 'monitoring', 0, w, testError);

    const afterCount = fs.readdirSync(cwd).filter(f => f.startsWith('nproxy_crash_')).length;
    assert.strictEqual(afterCount - beforeCount, 1, 'should create one dump file');
    
    const files = fs.readdirSync(cwd).filter(f => f.startsWith('nproxy_crash_'));
    const content = JSON.parse(fs.readFileSync(path.join(cwd, files[files.length - 1]), 'utf8'));
    assert.ok(content.error);
    assert.strictEqual(content.error.message, 'test error message');
    assert.ok(content.error.stack.includes('test error message'));
  });
});
