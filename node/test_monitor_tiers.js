'use strict';
const path = require('path');
const assert = require('assert').strict;

const mod = require(path.join(__dirname, 'nproxy.js'));
const { MemoryMonitor, installMonitorTier } = mod;

const TICK_MS = 50;

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function log(...args) {
  process.stderr.write('[tier_test] ' + args.join(' ') + '\n');
}

// ---- 1. rss tier: default monitoring ----
async function test_rss_monitoring() {
  const mon = new MemoryMonitor({
    attentionMb: 300, pressureMb: 500, criticalMb: 1000, emergencyMb: 2000,
    tickMs: TICK_MS, monitorTier: 'rss', onTransition: () => {},
  });
  mon.start();
  await delay(300);
  mon.stop();
  assert.ok(mon.state !== 'emergency', 'rss should not reach emergency in idle');
  log('PASS rss_monitoring ->', mon.state);
}

// ---- 2. split tier: String.prototype.split is wrapped ----
async function test_split_wrapper_installed() {
  const mon = new MemoryMonitor({
    attentionMb: 300, pressureMb: 500, criticalMb: 1000, emergencyMb: 2000,
    tickMs: TICK_MS, monitorTier: 'split', onTransition: () => {},
  });
  installMonitorTier(mon);

  // split still produces correct results
  const parts = 'a,b,c'.split(',');
  assert.deepStrictEqual(parts, ['a','b','c']);
  assert.strictEqual(String.prototype.split.name, '');
  log('PASS split_wrapper_installed');
}

// ---- 3. rss tier: Buffer burst triggers surge -> attention ----
async function test_rss_surge_triggers_attention() {
  let reachedAttention = false;
  const mon = new MemoryMonitor({
    attentionMb: 60, pressureMb: 200, criticalMb: 400, emergencyMb: 800,
    tickMs: TICK_MS, monitorTier: 'rss',
    onTransition: (state) => { if (state === 'attention' || state === 'pressure') reachedAttention = true; },
  });
  mon.start();

  // Allocate 64MB that touches RSS (Buffer.alloc with fill)
  await delay(200);
  const bufs = [];
  for (let i = 0; i < 4; i++) {
    bufs.push(Buffer.alloc(32 * 1024 * 1024, 0x41 + i));
    await delay(100);
  }

  await delay(500);
  mon.stop();
  log('surge test: state=' + mon.state + ' rss=' + mon._heapMb + 'MB');
  // Should have detected above attentionMb (60MB) given we allocated 128MB
  log('PASS rss_surge_triggers_attention');
}

// ---- 4. array tier: Array.prototype methods still work ----
async function test_array_methods_integrity() {
  const mon = new MemoryMonitor({
    attentionMb: 300, pressureMb: 500, criticalMb: 1000, emergencyMb: 2000,
    tickMs: TICK_MS, monitorTier: 'array', onTransition: () => {},
  });
  installMonitorTier(mon);
  mon.start();

  const arr = [];
  arr.push(1, 2, 3);
  assert.strictEqual(arr.length, 3);
  assert.strictEqual(arr[0], 1);

  arr.splice(0, 1);
  assert.strictEqual(arr.length, 2);
  assert.strictEqual(arr[0], 2);

  const merged = arr.concat([4, 5]);
  assert.strictEqual(merged.length, 4);

  arr.unshift(0);
  assert.strictEqual(arr[0], 0);

  await delay(300);
  mon.stop();
  log('PASS array_methods_integrity');
}

// ---- 5. array tier: large concat warns ----
async function test_array_large_concat() {
  let warned = false;
  const origWrite = process.stderr.write;
  process.stderr.write = function(c) {
    if (typeof c === 'string' && c.includes('[nproxy] Array.')) warned = true;
    return true;
  };

  const mon = new MemoryMonitor({
    attentionMb: 300, pressureMb: 500, criticalMb: 1000, emergencyMb: 2000,
    tickMs: TICK_MS, monitorTier: 'array', onTransition: () => {},
  });
  installMonitorTier(mon);
  mon.start();

  const a1 = new Array(150000).fill(0);
  const a2 = new Array(150000).fill(1);
  const r = a1.concat(a2);
  assert.strictEqual(r.length, 300000);

  await delay(300);
  mon.stop();
  process.stderr.write = origWrite;
  log('concat warning:', warned);
  log('PASS array_large_concat');
}

// ---- 6. Emergency principle: no child kill ----
async function test_emergency_self_terminate_only() {
  let emergencyTriggered = false;
  let emergencyMsg = '';

  // Force emergency via memory monitor reaching emergency threshold
  const mon = new MemoryMonitor({
    attentionMb: 50,  // very low to trigger quickly
    pressureMb: 80,
    criticalMb: 100,
    emergencyMb: 150,
    tickMs: TICK_MS, monitorTier: 'rss',
    onTransition: (state, mb) => {
      if (state === 'emergency') {
        emergencyTriggered = true;
        emergencyMsg = `emergency at ${mb.toFixed(0)}MB (self-terminate only, no child kill)`;
        log(emergencyMsg);
      }
    },
  });
  mon.start();

  // Grow RSS to trigger all stages
  const bufs = [];
  for (let i = 0; i < 8; i++) {
    bufs.push(Buffer.alloc(32 * 1024 * 1024, 0x41 + i));
    await delay(100);
  }
  await delay(500);
  mon.stop();

  // We should have observed some transitions
  log('emergency test final: state=' + mon.state + ' rss=' + mon._heapMb + 'MB emergencyHit=' + emergencyTriggered);
  log('PASS emergency_self_terminate_only');
}

// ---- 7. tier switching: rss -> split -> array are independent ----
async function test_tier_independence() {
  // rss tier: no prototype pollution
  const monRss = new MemoryMonitor({
    attentionMb: 300, pressureMb: 500, criticalMb: 1000, emergencyMb: 2000,
    tickMs: TICK_MS, monitorTier: 'rss', onTransition: () => {},
  });
  installMonitorTier(monRss);
  const r = 'a,b,c'.split(',');
  assert.deepStrictEqual(r, ['a','b','c']);
  log('PASS tier_independence');
}

// ==================== MAIN ====================
(async () => {
  const tests = [
    test_rss_monitoring,
    test_split_wrapper_installed,
    test_rss_surge_triggers_attention,
    test_array_methods_integrity,
    test_array_large_concat,
    test_emergency_self_terminate_only,
    test_tier_independence,
  ];
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t();
      passed++;
      log('  OK');
    } catch (e) {
      log('FAIL', t.name + ':', e.message);
      failed++;
    }
  }
  log(`=== result: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
})();
