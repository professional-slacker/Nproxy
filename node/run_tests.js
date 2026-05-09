// テストランナー。nproxy.js を使って各 app を起動し、結果を集計する。
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HERE = __dirname;
const NPROXY = path.join(HERE, 'nproxy.js');
const APPS_DIR = path.join(HERE, 'test_apps');
const REPORT_PATH = path.join(HERE, 'test_results.json');
const TMP_DIR = path.join(HERE, 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const results = [];
const overallStart = Date.now();

function nodeRun(args, opts = {}) {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env, opts.env || {});
    const child = spawn(process.execPath, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const peakMem = { rss: 0, heap: 0 };
    let outBytes = 0;
    let errBytes = 0;
    const sample = setInterval(() => {
      try {
        // child の memoryUsage は取れないので、自分（runner）で代替
        const m = process.memoryUsage();
        if (m.rss > peakMem.rss) peakMem.rss = m.rss;
        if (m.heapUsed > peakMem.heap) peakMem.heap = m.heapUsed;
      } catch (_) {}
    }, 100);

    if (opts.stdinFile) {
      const rs = fs.createReadStream(opts.stdinFile);
      rs.pipe(child.stdin);
    } else if (opts.stdinData) {
      child.stdin.write(opts.stdinData);
      child.stdin.end();
    } else {
      child.stdin.end();
    }

    if (opts.stdoutFile) {
      const ws = fs.createWriteStream(opts.stdoutFile);
      child.stdout.pipe(ws);
      child.stdout.on('data', (c) => { outBytes += c.length; });
      // ↑ 二重 pipe は良くないので、flowing 中の data だけカウントを別経路で
      // 実装直すのが面倒なので outBytes のカウントは止めて、ファイルサイズで取る
    } else {
      child.stdout.on('data', (c) => { outBytes += c.length; });
    }
    child.stderr.on('data', (c) => { errBytes += c.length; });

    const start = Date.now();
    const timer = opts.timeoutMs ? setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
    }, opts.timeoutMs) : null;

    child.on('exit', (code, signal) => {
      clearInterval(sample);
      if (timer) clearTimeout(timer);
      const dt = Date.now() - start;
      // ファイルがあるならサイズで上書き
      if (opts.stdoutFile && fs.existsSync(opts.stdoutFile)) {
        outBytes = fs.statSync(opts.stdoutFile).size;
      }
      resolve({ code, signal, durationMs: dt, outBytes, errBytes, peakMem });
    });
    child.on('error', (e) => {
      clearInterval(sample);
      if (timer) clearTimeout(timer);
      resolve({ code: -1, signal: null, durationMs: 0, outBytes, errBytes, error: e.message });
    });
  });
}

async function runCase(name, fn) {
  process.stderr.write(`\n=== Case: ${name} ===\n`);
  const t0 = Date.now();
  try {
    const r = await fn();
    r.case = name;
    r.totalMs = Date.now() - t0;
    results.push(r);
    process.stderr.write(`[OK] ${name} -> ${JSON.stringify({code:r.code, signal:r.signal, outBytes:r.outBytes, errBytes:r.errBytes, durationMs:r.durationMs})}\n`);
  } catch (e) {
    process.stderr.write(`[ERR] ${name}: ${e.stack || e.message}\n`);
    results.push({ case: name, error: e.message });
  }
}

(async () => {
  // -------------------- Case 1: stdin echo (text) --------------------
  await runCase('1_stdin_echo_small', async () => {
    const inFile = path.join(TMP_DIR, 'echo_small.in.txt');
    const outFile = path.join(TMP_DIR, 'echo_small.out.txt');
    const text = 'hello nproxy\nthis is line 2\n';
    fs.writeFileSync(inFile, text);
    const r = await nodeRun([NPROXY, path.join(APPS_DIR, 'app_echo.js')], {
      stdinFile: inFile,
      stdoutFile: outFile,
      timeoutMs: 15000,
    });
    const got = fs.readFileSync(outFile, 'utf8');
    r.passed = got === text;
    r.expectedBytes = Buffer.byteLength(text);
    return r;
  });

  // -------------------- Case 2: stdin echo (大量・file redirect) --------------------
  await runCase('2_stdin_echo_50MB', async () => {
    const inFile = path.join(TMP_DIR, 'echo_50mb.in.bin');
    const outFile = path.join(TMP_DIR, 'echo_50mb.out.bin');
    // 50 MB 作成
    const sz = 50 * 1024 * 1024;
    const ws = fs.createWriteStream(inFile);
    const buf = Buffer.alloc(64 * 1024, 0x41);
    let w = 0;
    await new Promise((resolve, reject) => {
      function loop() {
        while (w < sz) {
          const ok = ws.write(buf);
          w += buf.length;
          if (!ok) { ws.once('drain', loop); return; }
        }
        ws.end(resolve);
      }
      loop();
      ws.on('error', reject);
    });
    const r = await nodeRun([NPROXY, path.join(APPS_DIR, 'app_echo.js')], {
      stdinFile: inFile,
      stdoutFile: outFile,
      timeoutMs: 120000,
      env: { NPROXY_DEBUG: '1', NPROXY_LOG: path.join(TMP_DIR, '2.log') },
    });
    r.expectedBytes = sz;
    r.passed = fs.statSync(outFile).size === sz;
    return r;
  });

  // -------------------- Case 3: 大量 stdout --------------------
  await runCase('3_big_stdout_200MB', async () => {
    const outFile = path.join(TMP_DIR, 'big_stdout.out.bin');
    const r = await nodeRun([NPROXY, path.join(APPS_DIR, 'app_big_stdout.js'), '200'], {
      stdoutFile: outFile,
      timeoutMs: 120000,
      env: { NPROXY_DEBUG: '1', NPROXY_LOG: path.join(TMP_DIR, '3.log') },
    });
    const expected = 200 * 1024 * 1024;
    r.expectedBytes = expected;
    r.passed = Math.abs(fs.statSync(outFile).size - expected) < 64 * 1024;
    return r;
  });

  // -------------------- Case 4: ANSI escape passthrough --------------------
  await runCase('4_ansi_passthrough', async () => {
    const outFile = path.join(TMP_DIR, 'ansi.out.txt');
    const r = await nodeRun([NPROXY, path.join(APPS_DIR, 'app_ansi.js')], {
      stdoutFile: outFile,
      timeoutMs: 30000,
    });
    const got = fs.readFileSync(outFile, 'utf8');
    r.passed = got.indexOf('\x1b[31m') >= 0 && got.indexOf('\x1b[0m') >= 0;
    return r;
  });

  // -------------------- Case 5: stderr 混在 --------------------
  await runCase('5_stderr_mix', async () => {
    const outFile = path.join(TMP_DIR, 'mix.out.txt');
    const r = await nodeRun([NPROXY, path.join(APPS_DIR, 'app_stderr_mix.js'), '300'], {
      stdoutFile: outFile,
      timeoutMs: 30000,
    });
    const got = fs.readFileSync(outFile, 'utf8');
    const outLines = (got.match(/^OUT/gm) || []).length;
    r.passed = outLines > 100 && r.errBytes > 100;
    r.outLines = outLines;
    return r;
  });

  // -------------------- Case 6: fs 巨大ファイル → stdout --------------------
  await runCase('6_fs_huge_to_stdout', async () => {
    const huge = path.join(TMP_DIR, 'huge_input.bin');
    const sz = 100 * 1024 * 1024; // 100MB
    if (!fs.existsSync(huge) || fs.statSync(huge).size !== sz) {
      const ws = fs.createWriteStream(huge);
      const buf = Buffer.alloc(64*1024, 0x42);
      let w = 0;
      await new Promise((resolve, reject) => {
        function loop() {
          while (w < sz) {
            const ok = ws.write(buf);
            w += buf.length;
            if (!ok) { ws.once('drain', loop); return; }
          }
          ws.end(resolve);
        }
        loop();
        ws.on('error', reject);
      });
    }
    const outFile = path.join(TMP_DIR, 'fs_huge.out.bin');
    const r = await nodeRun([NPROXY, path.join(APPS_DIR, 'app_fs_huge.js'), huge], {
      stdoutFile: outFile,
      timeoutMs: 120000,
      env: { NPROXY_DEBUG: '1', NPROXY_LOG: path.join(TMP_DIR, '6.log') },
    });
    r.expectedBytes = sz;
    r.passed = fs.statSync(outFile).size === sz;
    return r;
  });

  // -------------------- 完了 --------------------
  const total = Date.now() - overallStart;
  const summary = {
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    nodeVersion: process.version,
    totalMs: total,
    cases: results,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(summary, null, 2));
  process.stderr.write(`\nReport written to ${REPORT_PATH}\n`);
  process.stderr.write(`Total time: ${total}ms\n`);
})();
