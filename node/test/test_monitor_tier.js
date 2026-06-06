const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
process.env.NPROXY_AUTO = '1'; // Prevent intercept() on require
const { MemoryMonitor, installMonitorTier } = require('../nproxy.js');

describe('installMonitorTier', () => {
  describe('rss tier (default)', () => {
    it('does not wrap String.prototype.split', () => {
      const mon = new MemoryMonitor({ monitorTier: 'rss' });
      installMonitorTier(mon);
      // split should still work correctly
      const parts = 'a,b,c'.split(',');
      assert.deepStrictEqual(parts, ['a', 'b', 'c']);
    });
  });

  describe('split tier', () => {
    it('wraps String.prototype.split', () => {
      const mon = new MemoryMonitor({ monitorTier: 'split' });
      installMonitorTier(mon);
      const parts = 'hello,world'.split(',');
      assert.deepStrictEqual(parts, ['hello', 'world']);
    });

    it('split still works correctly after wrapping', () => {
      const mon = new MemoryMonitor({ monitorTier: 'split' });
      installMonitorTier(mon);
      const parts = 'a::b::c'.split('::');
      assert.deepStrictEqual(parts, ['a', 'b', 'c']);
    });

    it('split with limit works correctly', () => {
      const mon = new MemoryMonitor({ monitorTier: 'split' });
      installMonitorTier(mon);
      const parts = 'a,b,c,d'.split(',', 2);
      assert.deepStrictEqual(parts, ['a', 'b']);
    });

  it('split with regex works correctly', () => {
    const mon = new MemoryMonitor({ monitorTier: 'split' });
    installMonitorTier(mon);
    const parts = 'a1b2c3'.split(/\d/);
    // Native JS split with trailing separator match produces empty tail
    assert.deepStrictEqual(parts, ['a', 'b', 'c', '']);
  });

    it('sets _tierInstalled flag', () => {
      const mon = new MemoryMonitor({ monitorTier: 'split' });
      installMonitorTier(mon);
      assert.strictEqual(mon._tierInstalled, true);
    });
  });

  describe('array tier', () => {
    it('wraps Array.prototype methods', () => {
      const mon = new MemoryMonitor({ monitorTier: 'array' });
      installMonitorTier(mon);
      const arr = [1, 2, 3];
      arr.push(4, 5);
      assert.strictEqual(arr.length, 5);
      assert.strictEqual(arr[4], 5);
    });

    it('Array.push still works after wrapping', () => {
      const mon = new MemoryMonitor({ monitorTier: 'array' });
      installMonitorTier(mon);
      const arr = [];
      arr.push('a');
      arr.push('b', 'c');
      assert.deepStrictEqual(arr, ['a', 'b', 'c']);
    });

    it('Array.splice still works after wrapping', () => {
      const mon = new MemoryMonitor({ monitorTier: 'array' });
      installMonitorTier(mon);
      const arr = ['a', 'b', 'c', 'd'];
      const removed = arr.splice(1, 2);
      assert.deepStrictEqual(arr, ['a', 'd']);
      assert.deepStrictEqual(removed, ['b', 'c']);
    });

    it('Array.unshift still works after wrapping', () => {
      const mon = new MemoryMonitor({ monitorTier: 'array' });
      installMonitorTier(mon);
      const arr = ['b', 'c'];
      arr.unshift('a');
      assert.deepStrictEqual(arr, ['a', 'b', 'c']);
    });

    it('Array.concat still works after wrapping', () => {
      const mon = new MemoryMonitor({ monitorTier: 'array' });
      installMonitorTier(mon);
      const r = ['a', 'b'].concat(['c', 'd']);
      assert.deepStrictEqual(r, ['a', 'b', 'c', 'd']);
    });

    it('sets _arrayProxyInstalled flag', () => {
      const mon = new MemoryMonitor({ monitorTier: 'array' });
      installMonitorTier(mon);
      assert.strictEqual(mon._arrayProxyInstalled, true);
    });
  });

  describe('auto tier', () => {
    it('does nothing initially (delayed promotion)', () => {
      const mon = new MemoryMonitor({ monitorTier: 'auto' });
      installMonitorTier(mon);
      assert.strictEqual(mon._tierInstalled, false);
      assert.strictEqual(mon._arrayProxyInstalled, false);
    });
  });

  describe('tier independence', () => {
    it('rss tier does not install split wrapper', () => {
      const mon1 = new MemoryMonitor({ monitorTier: 'rss' });
      installMonitorTier(mon1);
      assert.strictEqual(mon1._tierInstalled, false);
    });

    it('split tier does not install array proxy', () => {
      const mon = new MemoryMonitor({ monitorTier: 'split' });
      installMonitorTier(mon);
      assert.strictEqual(mon._tierInstalled, true);
      assert.strictEqual(mon._arrayProxyInstalled, false);
    });
  });
});
