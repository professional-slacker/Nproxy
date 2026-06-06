const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
process.env.NPROXY_AUTO = '1'; // Prevent intercept() on require
const { writeCrashDump } = require('../nproxy.js');

describe('writeCrashDump', () => {
  const cwd = process.cwd();
  const dumpFiles = [];

  after(() => {
    for (const f of dumpFiles) {
      try { fs.unlinkSync(f); } catch (_) {}
    }
  });

  it('writes a crash dump file with JSON content', () => {
    const w = (msg) => {}; // silent writer
    writeCrashDump('test_reason', 'monitoring', 0, w);

    // Find the dump file
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

    const files = fs.readdirSync(cwd).filter(f => f.startsWith('nproxy_crash_'));
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
});
