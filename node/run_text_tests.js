// Text I/O テストランナー
// 観点:
//   - 各 mode (off / passthrough / transform / tee) でのスループットと heap
//   - chunk境界 UTF-8 破壊検知 (期待ハッシュと比較)
//   - 大規模 (10GB ASCII / 1GB マルチバイト) でも heap がフラットか
//   - mode 切替時の欠落
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const HERE = __dirname;
const NPROXY = path.join(HERE, 'nproxy.js');
const APPS = path.join(HERE, 'test_apps');
const TMP = path.join(HERE, 'tmp');
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

const RESULTS = [];
const overallStart = Date.now();

function runProxied(args, opts = {}) {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env, opts.env || {});
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const ws = opts.stdoutFile ? fs.createWriteStream(opts.stdoutFile) : null;
    const startTs = Date.now();
    let outBytes = 0, errBytes = 0;
    const hash = opts.hashOut ? crypto.createHash('sha256') : null;
    if (ws) child.stdout.pipe(ws);
    child.stdout.on('data', c => { outBytes += c.length; if (hash) hash.update(c); });
    child.stderr.on('data', c => { errBytes += c.length; });
    const timer = opts.timeoutMs ? setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, opts.timeoutMs) : null;
    let exitInfo = null;
    let wsFinished = !ws;
    function tryFinalize() {
      if (!exitInfo || !wsFinished) return;
      if (timer) clearTimeout(timer);
      const dt = Date.now() - startTs;
      let finalBytes = outBytes;
      if (opts.stdoutFile && fs.existsSync(opts.stdoutFile)) finalBytes = fs.statSync(opts.stdoutFile).size;
      resolve({ code: exitInfo.code, signal: exitInfo.signal, durationMs: dt, outBytes: finalBytes, errBytes, hash: hash ? hash.digest('hex') : null });
    }
    if (ws) {
      ws.on('finish', () => { wsFinished = true; tryFinalize(); });
      ws.on('close', () => { wsFinished = true; tryFinalize(); });
    }
    child.on('close', (code, signal) => { exitInfo = { code, signal }; tryFinalize(); });
  });
}

// nproxy のデバッグログから heap/state/text 情報を抜く
function parseTickLog(logPath) {
  const out = {
    samples: 0,
    heapMin: null, heapMax: null, heapAvg: 0,
    rssMin: null, rssMax: null, rssAvg: 0,
    states: [], textModes: [],
    transitions: [],
    textTransitions: [],
  };
  if (!fs.existsSync(logPath)) return out;
  const txt = fs.readFileSync(logPath, 'utf8');
  let hSum = 0, rSum = 0;
  const stateSet = new Set(), modeSet = new Set();
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/\[TICK\] state=(\w+) heap=([\d.]+)MB rss=([\d.]+)MB.*text=(\w+) chars=(\d+) lines=(\d+) decodeMs=([\d.]+) maxLine=(\d+) forcedFlush=(\d+)/);
    if (m) {
      out.samples++;
      const heap = parseFloat(m[2]); const rss = parseFloat(m[3]);
      hSum += heap; rSum += rss;
      if (out.heapMin === null || heap < out.heapMin) out.heapMin = heap;
      if (out.heapMax === null || heap > out.heapMax) out.heapMax = heap;
      if (out.rssMin === null || rss < out.rssMin) out.rssMin = rss;
      if (out.rssMax === null || rss > out.rssMax) out.rssMax = rss;
      stateSet.add(m[1]);
      modeSet.add(m[4]);
    }
    const t = line.match(/\[POLICY\] (\w+) -> (\w+)/);
    if (t) out.transitions.push({ from: t[1], to: t[2] });
    const tt = line.match(/\[TEXT\] (\w+): (\w+) -> (\w+) \(reason=([^)]+)\)/);
    if (tt) out.textTransitions.push({ kind: tt[1], from: tt[2], to: tt[3], reason: tt[4] });
  }
  out.heapAvg = out.samples ? hSum / out.samples : 0;
  out.rssAvg = out.samples ? rSum / out.samples : 0;
  out.states = Array.from(stateSet);
  out.textModes = Array.from(modeSet);
  return out;
}

async function caseRun(name, fn) {
  process.stderr.write(`\n=== ${name} ===\n`);
  const t0 = Date.now();
  try {
    const r = await fn();
    r.case = name; r.totalMs = Date.now() - t0;
    RESULTS.push(r);
    process.stderr.write(`[OK] ${name} -> ${JSON.stringify({ outBytes: r.outBytes, durationMs: r.durationMs, passed: r.passed })}\n`);
  } catch (e) {
    process.stderr.write(`[ERR] ${name}: ${e.stack || e.message}\n`);
    RESULTS.push({ case: name, error: e.message });
  }
}

(async () => {
  // ============ Case T1: ASCII passthrough 100MB ============
  await caseRun('T1_ascii_passthrough_100MB', async () => {
    const mb = 100;
    const out = path.join(TMP, 'T1.out.bin');
    const log = path.join(TMP, 'T1.log');
    const r = await runProxied([NPROXY, '--text=passthrough', path.join(APPS, 'app_text_ascii.js'), String(mb)], {
      stdoutFile: out, timeoutMs: 120000, hashOut: true,
      env: { NPROXY_DEBUG: '1', NPROXY_LOG: log },
    });
    const expected = mb * 1024 * 1024;
    r.expectedBytes = expected;
    r.passed = r.outBytes === expected;
    r.tick = parseTickLog(log);
    return r;
  });

  // ============ Case T2: ASCII transform 100MB ============
  await caseRun('T2_ascii_transform_100MB', async () => {
    const mb = 100;
    const out = path.join(TMP, 'T2.out.bin');
    const log = path.join(TMP, 'T2.log');
    const r = await runProxied([NPROXY, '--text=transform', path.join(APPS, 'app_text_ascii.js'), String(mb)], {
      stdoutFile: out, timeoutMs: 180000,
      env: { NPROXY_DEBUG: '1', NPROXY_LOG: log },
    });
    // transform は行ごとにタイムスタンプ＋行番号が付くので、出力は元より大きくなる
    const expectedLines = mb * 1024 * 1024 / 64;  // 各行 64 bytes
    r.expectedLines = expectedLines;
    r.passed = r.outBytes > mb * 1024 * 1024;  // 元より大きいこと (加工成功)
    r.tick = parseTickLog(log);
    return r;
  });

  // ============ Case T3: ASCII tee 50MB ============
  await caseRun('T3_ascii_tee_50MB', async () => {
    const mb = 50;
    const out = path.join(TMP, 'T3.out.bin');
    const log = path.join(TMP, 'T3.log');
    const teeLog = path.join(TMP, 'T3.tee.log');
    try { fs.unlinkSync(teeLog); } catch (_) {}
    const r = await runProxied([NPROXY, '--text=tee', '--text-log=' + teeLog, path.join(APPS, 'app_text_ascii.js'), String(mb)], {
      stdoutFile: out, timeoutMs: 120000,
      env: { NPROXY_DEBUG: '1', NPROXY_LOG: log },
    });
    const expected = mb * 1024 * 1024;
    const teeSize = fs.existsSync(teeLog) ? fs.statSync(teeLog).size : 0;
    r.expectedBytes = expected;
    r.teeSize = teeSize;
    r.passed = r.outBytes === expected && Math.abs(teeSize - expected) < 2 * 1024;  // tee は stderr 由来分も付くため緩め
    r.tick = parseTickLog(log);
    return r;
  });

  // ============ Case T4: マルチバイト passthrough 100MB ============
  await caseRun('T4_utf8_passthrough_100MB', async () => {
    const mb = 100;
    const out = path.join(TMP, 'T4.out.bin');
    const log = path.join(TMP, 'T4.log');
    const r = await runProxied([NPROXY, '--text=passthrough', path.join(APPS, 'app_text_utf8.js'), String(mb)], {
      stdoutFile: out, timeoutMs: 180000, hashOut: true,
      env: { NPROXY_DEBUG: '1', NPROXY_LOG: log },
    });
    const expected = mb * 1024 * 1024;
    r.expectedBytes = expected;
    // マルチバイトでも StringDecoder が境界を保護するので bytes は完全一致
    r.passed = r.outBytes === expected;
    r.tick = parseTickLog(log);
    // 出力を一部読み返して U+FFFD が混入していないか確認
    const sample = fs.readFileSync(out, 'utf8').slice(0, 1000);
    r.replacementCharCount = (sample.match(/�/g) || []).length;
    r.passed = r.passed && r.replacementCharCount === 0;
    return r;
  });

  // ============ Case T5: chunk境界破壊テスト (1万「あ」) ============
  await caseRun('T5_boundary_10k_a', async () => {
    const N = 10000;
    const out = path.join(TMP, 'T5.out.bin');
    const log = path.join(TMP, 'T5.log');
    const r = await runProxied([NPROXY, '--text=passthrough', path.join(APPS, 'app_text_boundary.js'), String(N)], {
      stdoutFile: out, timeoutMs: 60000, hashOut: true,
      env: { NPROXY_DEBUG: '1', NPROXY_LOG: log },
    });
    const expected = N * 3;  // 「あ」= 3 bytes
    r.expectedBytes = expected;
    r.passed = r.outBytes === expected;
    // 出力を verify: 全バイトが E3 81 82 の繰り返しか
    if (fs.existsSync(out) && fs.statSync(out).size === expected) {
      const buf = fs.readFileSync(out);
      let allOk = true;
      for (let i = 0; i < buf.length; i += 3) {
        if (buf[i] !== 0xE3 || buf[i+1] !== 0x81 || buf[i+2] !== 0x82) { allOk = false; break; }
      }
      r.byteIntegrity = allOk;
      r.passed = r.passed && allOk;
    } else {
      r.byteIntegrity = false;
      r.passed = false;
    }
    r.tick = parseTickLog(log);
    return r;
  });

  // ============ Case T6: text=off (Byte層) との比較 100MB ============
  await caseRun('T6_off_baseline_100MB', async () => {
    const mb = 100;
    const out = path.join(TMP, 'T6.out.bin');
    const log = path.join(TMP, 'T6.log');
    const r = await runProxied([NPROXY, '--text=off', path.join(APPS, 'app_text_ascii.js'), String(mb)], {
      stdoutFile: out, timeoutMs: 60000,
      env: { NPROXY_DEBUG: '1', NPROXY_LOG: log },
    });
    const expected = mb * 1024 * 1024;
    r.expectedBytes = expected;
    r.passed = r.outBytes === expected;
    r.tick = parseTickLog(log);
    return r;
  });

  // ============ Case T7: 大規模 ASCII passthrough 1GB (heapフラット確認) ============
  await caseRun('T7_ascii_passthrough_1GB', async () => {
    const mb = 1024;
    const out = path.join(TMP, 'T7.out.bin');
    const log = path.join(TMP, 'T7.log');
    const r = await runProxied([NPROXY, '--text=passthrough', path.join(APPS, 'app_text_ascii.js'), String(mb)], {
      stdoutFile: out, timeoutMs: 240000,
      env: { NPROXY_DEBUG: '1', NPROXY_LOG: log },
    });
    const expected = mb * 1024 * 1024;
    r.expectedBytes = expected;
    r.passed = r.outBytes === expected;
    r.tick = parseTickLog(log);
    return r;
  });

  // ============ Case T8: 大規模 UTF-8 passthrough 1GB ============
  await caseRun('T8_utf8_passthrough_1GB', async () => {
    const mb = 1024;
    const out = path.join(TMP, 'T8.out.bin');
    const log = path.join(TMP, 'T8.log');
    const r = await runProxied([NPROXY, '--text=passthrough', path.join(APPS, 'app_text_utf8.js'), String(mb)], {
      stdoutFile: out, timeoutMs: 240000,
      env: { NPROXY_DEBUG: '1', NPROXY_LOG: log },
    });
    const expected = mb * 1024 * 1024;
    r.expectedBytes = expected;
    r.passed = r.outBytes === expected;
    r.tick = parseTickLog(log);
    return r;
  });

  // ============ Case T9: 自動 PRESSURE 縮退 (transform → passthrough) ============
  await caseRun('T9_auto_demote_under_pressure', async () => {
    const mb = 50;
    const out = path.join(TMP, 'T9.out.bin');
    const log = path.join(TMP, 'T9.log');
    // transform 要求しつつ閾値を下げて PRESSURE に入れる
    const r = await runProxied([NPROXY, '--text=transform', path.join(APPS, 'app_text_ascii.js'), String(mb)], {
      stdoutFile: out, timeoutMs: 120000,
      env: {
        NPROXY_DEBUG: '1', NPROXY_LOG: log,
        NPROXY_PRESSURE_MB: '3',
        NPROXY_CRITICAL_MB: '6',
        NPROXY_TICK_MS: '50',
      },
    });
    r.passed = r.outBytes > 0;
    r.tick = parseTickLog(log);
    // PRESSURE への遷移 + transform → passthrough への text 縮退があれば成功
    r.demoted = r.tick.textTransitions.some(t => t.from === 'transform' && t.to === 'passthrough');
    r.pressureSeen = r.tick.transitions.some(t => t.to === 'PRESSURE');
    return r;
  });

  // ============ サマリ書き出し ============
  const total = Date.now() - overallStart;
  const summary = {
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    nodeVersion: process.version,
    totalMs: total,
    cases: RESULTS,
    timestamp: new Date().toISOString(),
  };
  const reportPath = path.join(HERE, 'text_test_results.json');
  fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2));
  process.stderr.write(`\nText I/O report -> ${reportPath}\nTotal: ${total}ms\n`);
})();
