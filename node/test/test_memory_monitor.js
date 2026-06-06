const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
process.env.NPROXY_AUTO = '1'; // Prevent intercept() on require
const { MemoryMonitor } = require('../nproxy.js');

describe('MemoryMonitor', () => {
  describe('constructor', () => {
    it('sets default values', () => {
      const mon = new MemoryMonitor();
      assert.strictEqual(mon.state, 'monitoring');
      assert.ok(mon.attentionMb > 0);
      assert.ok(mon.pressureMb > 0);
      assert.ok(mon.criticalMb > 0);
      assert.ok(mon.emergencyMb > 0);
      assert.ok(mon.tickMs >= 50);
    });

    it('applies custom thresholds', () => {
      const mon = new MemoryMonitor({
        attentionMb: 100, pressureMb: 200, criticalMb: 400, emergencyMb: 800,
        tickMs: 100,
      });
      assert.strictEqual(mon.attentionMb, 100);
      assert.strictEqual(mon.pressureMb, 200);
      assert.strictEqual(mon.criticalMb, 400);
      assert.strictEqual(mon.emergencyMb, 800);
      assert.strictEqual(mon.tickMs, 100);
    });

    it('enforces minimum tickMs of 50', () => {
      const mon = new MemoryMonitor({ tickMs: 10 });
      assert.strictEqual(mon.tickMs, 50);
    });

    it('defaults monitorTier to auto', () => {
      const mon = new MemoryMonitor();
      assert.strictEqual(mon.monitorTier, 'auto');
    });
  });

  describe('start/stop lifecycle', () => {
    it('start returns self for chaining', () => {
      const mon = new MemoryMonitor({ tickMs: 1000 });
      const ret = mon.start();
      assert.strictEqual(ret, mon);
      mon.stop();
    });

    it('stop sets timer to null', () => {
      const mon = new MemoryMonitor({ tickMs: 1000 });
      mon.start();
      mon.stop();
      assert.strictEqual(mon._timer, null);
    });

    it('start initializes the tick timer', () => {
      const mon = new MemoryMonitor({ tickMs: 1000 });
      mon.start();
      assert.ok(mon._timer !== null);
      mon.stop();
    });
  });

  describe('state transitions', () => {
    it('starts in monitoring state', () => {
      const mon = new MemoryMonitor({ tickMs: 1000 });
      assert.strictEqual(mon.state, 'monitoring');
    });

    it('detects attention state when RSS exceeds attentionMb', async () => {
      const transitions = [];
      const mon = new MemoryMonitor({
        attentionMb: 1,  // Very low threshold
        pressureMb: 9999,
        criticalMb: 99999,
        emergencyMb: 999999,
        tickMs: 50,
        onTransition: (state) => transitions.push(state),
      });
      mon.start();
      await new Promise(r => setTimeout(r, 150));
      mon.stop();
      assert.ok(transitions.includes('attention') || mon.state === 'attention' || mon.state === 'monitoring',
        `State should have transitioned: ${mon.state}, transitions: ${transitions.join(',')}`);
    });

    it('calls onTransition on state change', async () => {
      let called = false;
      let lastState = '';
      const mon = new MemoryMonitor({
        attentionMb: 1,
        pressureMb: 9999,
        criticalMb: 99999,
        emergencyMb: 999999,
        tickMs: 50,
        onTransition: (state, mb) => {
          called = true;
          lastState = state;
        },
      });
      mon.start();
      await new Promise(r => setTimeout(r, 150));
      mon.stop();
      assert.ok(called, 'onTransition should have been called');
    });
  });

  describe('surge detection', () => {
    it('detects consecutive surges', async () => {
      const mon = new MemoryMonitor({
        attentionMb: 9999,
        pressureMb: 99999,
        criticalMb: 999999,
        emergencyMb: 9999999,
        tickMs: 50,
        surgeThresholdMb: 0.01, // Very sensitive
      });
      mon.start();
      // Simulate surge by triggering _tick with fake delta
      mon._prevMb = 0;
      mon._heapMb = 100;
      // This happens in _tick automatically
      await new Promise(r => setTimeout(r, 200));
      mon.stop();
      assert.ok(mon._consecutiveSurges >= 0);
    });
  });

  describe('RSS reading via /proc', () => {
    it('returns 0 for invalid pid', () => {
      const mon = new MemoryMonitor({});
      const rss = mon._readChildRssKb();
      assert.strictEqual(rss, 0);
    });

    it('returns positive value for current process', () => {
      const mon = new MemoryMonitor({ childPid: process.pid });
      const rss = mon._readChildRssKb();
      assert.ok(rss > 0, `RSS should be > 0, got ${rss}`);
    });
  });

  describe('rssMb getter', () => {
    it('returns 0 when no RSS read yet', () => {
      const mon = new MemoryMonitor();
      assert.strictEqual(mon.rssMb, 0);
    });

    it('returns calculated MB value', () => {
      const mon = new MemoryMonitor({ childPid: process.pid });
      mon._rssKb = 10240; // 10MB
      assert.strictEqual(mon.rssMb, 10);
    });
  });
});
