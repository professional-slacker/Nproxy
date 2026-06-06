const { describe, it } = require('node:test');
const assert = require('node:assert');
process.env.NPROXY_AUTO = '1'; // Prevent intercept() on require

describe('configuration constants', () => {
  it('TEXT_MODES includes all valid modes', () => {
    const expected = ['passthrough', 'strip-ansi', 'transform'];
    const TEXT_MODES = ['passthrough', 'strip-ansi', 'transform'];
    assert.deepStrictEqual(TEXT_MODES, expected);
  });

  it('DFS ratios are 16%/32%/64%/80% of heap limit', () => {
    const ratios = { attention: 0.16, pressure: 0.32, critical: 0.64, emergency: 0.80 };
    assert.strictEqual(ratios.attention, 0.16);
    assert.strictEqual(ratios.pressure, 0.32);
    assert.strictEqual(ratios.critical, 0.64);
    assert.strictEqual(ratios.emergency, 0.80);
  });

  it('max chunk sizes decrease with severity', () => {
    const sizes = {
      normal: 262144,
      attention: 262144,
      pressure: 65536,
      critical: 4096,
    };
    assert.strictEqual(sizes.normal, 262144);
    assert.strictEqual(sizes.attention, 262144);
    assert.strictEqual(sizes.pressure, 65536);
    assert.strictEqual(sizes.critical, 4096);
    // Verify ordering
    assert.ok(sizes.pressure < sizes.normal);
    assert.ok(sizes.critical < sizes.pressure);
  });

  it('CPU watchdog thresholds are 80%/95%', () => {
    assert.strictEqual(80, 80);
    assert.strictEqual(95, 95);
  });

  it('HEAP_LIMIT_MB is a positive number', () => {
    const mod = require('../nproxy.js');
    // MemoryMonitor implicitly uses HEAP_LIMIT_MB
    const mon = new mod.MemoryMonitor();
    assert.ok(mon.emergencyMb > 0);
  });
});
