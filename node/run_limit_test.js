// Node ランタイム限界テストランナー
// 目的: 設計の破綻点ではなく、Node + libuv + OS pipe の "天井" を測る
//
// 観測:
//   - 出力ファイルサイズの推移（stall 検知）
//   - 子プロセス起動から exit までの所要時間
//   - スループット
//   - nproxy 側の tick ログから heap/rss/state を後解析
//
// 使い方:
//   node run_limit_test.js [MB]
//   既定 MB = 5120 (= 5GB)
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HERE = __dirname;
const NPROXY = path.join(HERE, 'nproxy.js');
const APP = path.join(HERE, 'test_apps', 'app_big_stdout.js');
const TMP = path.join(HERE, 'tmp');
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

const MB = parseInt(process.argv[2] || '5120', 10);
const TARGET_BYTES = MB * 1024 * 1024;

const OUT_FILE = path.join(TMP, `limit_${MB}MB.out.bin`);
const LOG_FILE = path.join(TMP, `limit_${MB}MB.log`);
const RESULT_FILE = path.join(TMP, `limit_${MB}MB.result.json`);

// 念のため過去の出力を削除
try { fs.unlinkSync(OUT_FILE); } catch (_) {}
try { fs.unlinkSync(LOG_FILE); } catch (_) {}

console.error(`[limit] target=${MB}MB (${TARGET_BYTES} bytes)`);
console.error(`[limit] nproxy=${NPROXY}`);
console.error(`[limit] app=${APP}`);

// ストリーミング出力先
const ws = fs.createWriteStream(OUT_FILE);

const env = Object.assign({}, process.env, {
  NPROXY_DEBUG: '1',
  NPROXY_LOG: LOG_FILE,
  NPROXY_TICK_MS: '500',
});

const startTs = Date.now();

const child = spawn(process.execPath, [NPROXY, APP, String(MB)], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.stdout.pipe(ws);

let errBuf = '';
child.stderr.on('data', (c) => { errBuf += c.toString(); });

// stall 監視: 5秒ごとに OUT_FILE のサイズを取得し、増えていなければカウント
const sizeHistory = [];
const STALL_THRESHOLD_TICKS = 6;     // 5sec * 6 = 30秒進捗なし → stall
let stallCount = 0;
let lastSize = 0;
let detectedStall = false;
let firstByteTs = null;

const sizeTick = setInterval(() => {
  let curSize = 0;
  try { curSize = fs.statSync(OUT_FILE).size; } catch (_) { return; }

  if (firstByteTs === null && curSize > 0) firstByteTs = Date.now();

  const dt = Date.now() - startTs;
  sizeHistory.push({ ts: dt, bytes: curSize });

  const delta = curSize - lastSize;
  if (delta === 0 && curSize < TARGET_BYTES) {
    stallCount++;
    if (stallCount >= STALL_THRESHOLD_TICKS && !detectedStall) {
      detectedStall = true;
      console.error(`[limit] *** STALL detected at ${curSize} bytes ***`);
    }
  } else {
    stallCount = 0;
  }
  lastSize = curSize;

  const pct = (curSize / TARGET_BYTES * 100).toFixed(1);
  const rate = dt > 0 ? (curSize / 1024 / 1024 / (dt / 1000)) : 0;
  console.error(`[limit] +${(dt/1000).toFixed(1)}s ${(curSize/1048576).toFixed(1)}MB/${MB}MB (${pct}%) rate=${rate.toFixed(1)}MB/s${detectedStall ? ' [STALL]' : ''}`);
}, 5000);

// 全体タイムアウト: 1秒あたり最低 5MB は出ると仮定して、その3倍を超えたら諦める
const HARD_TIMEOUT = Math.max(60000, (TARGET_BYTES / (5 * 1024 * 1024)) * 3 * 1000);
const hardTimer = setTimeout(() => {
  console.error(`[limit] HARD TIMEOUT after ${HARD_TIMEOUT}ms`);
  try { child.kill('SIGKILL'); } catch (_) {}
}, HARD_TIMEOUT);

child.on('exit', (code, signal) => {
  clearInterval(sizeTick);
  clearTimeout(hardTimer);
  ws.end();

  const dt = Date.now() - startTs;
  const finalSize = (fs.existsSync(OUT_FILE)) ? fs.statSync(OUT_FILE).size : 0;
  const passed = code === 0 && finalSize === TARGET_BYTES && !detectedStall;

  // tick ログ解析
  const tickStats = analyzeTickLog(LOG_FILE);

  const result = {
    targetMB: MB,
    targetBytes: TARGET_BYTES,
    finalBytes: finalSize,
    matchSize: finalSize === TARGET_BYTES,
    durationMs: dt,
    timeToFirstByteMs: firstByteTs ? (firstByteTs - startTs) : null,
    avgThroughputMBps: dt > 0 ? (finalSize / 1048576 / (dt / 1000)) : 0,
    exitCode: code,
    exitSignal: signal,
    detectedStall,
    stderrTail: errBuf.slice(-500),
    sizeHistory,
    tickStats,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    nodeVersion: process.version,
    timestamp: new Date().toISOString(),
    passed,
  };

  fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));

  console.error(`\n[limit] === RESULT ===`);
  console.error(`[limit] passed=${passed}`);
  console.error(`[limit] finalBytes=${finalSize}/${TARGET_BYTES}`);
  console.error(`[limit] durationMs=${dt}`);
  console.error(`[limit] avgThroughput=${result.avgThroughputMBps.toFixed(1)}MB/s`);
  console.error(`[limit] tickStats: heap min=${tickStats.heapMinMB}MB max=${tickStats.heapMaxMB}MB avg=${tickStats.heapAvgMB.toFixed(1)}MB samples=${tickStats.samples}`);
  console.error(`[limit] tickStats: rss  min=${tickStats.rssMinMB}MB max=${tickStats.rssMaxMB}MB avg=${tickStats.rssAvgMB.toFixed(1)}MB`);
  console.error(`[limit] state visited: ${tickStats.statesVisited.join(', ')}`);
  console.error(`[limit] result.json -> ${RESULT_FILE}`);
});

// nproxy のデバッグログから heap/rss/state を抽出
function analyzeTickLog(logPath) {
  const result = {
    samples: 0,
    heapMinMB: null, heapMaxMB: null, heapAvgMB: 0,
    rssMinMB:  null, rssMaxMB:  null, rssAvgMB:  0,
    statesVisited: [],
    transitions: [],
  };
  if (!fs.existsSync(logPath)) return result;
  const txt = fs.readFileSync(logPath, 'utf8');
  const lines = txt.split(/\r?\n/);
  let heapSum = 0, rssSum = 0;
  const stateSet = new Set();
  for (const line of lines) {
    const tickMatch = line.match(/\[TICK\] state=(\w+) heap=([\d.]+)MB rss=([\d.]+)MB/);
    if (tickMatch) {
      const state = tickMatch[1];
      const heap = parseFloat(tickMatch[2]);
      const rss = parseFloat(tickMatch[3]);
      stateSet.add(state);
      result.samples++;
      heapSum += heap;
      rssSum += rss;
      if (result.heapMinMB === null || heap < result.heapMinMB) result.heapMinMB = heap;
      if (result.heapMaxMB === null || heap > result.heapMaxMB) result.heapMaxMB = heap;
      if (result.rssMinMB === null || rss < result.rssMinMB) result.rssMinMB = rss;
      if (result.rssMaxMB === null || rss > result.rssMaxMB) result.rssMaxMB = rss;
    }
    const polMatch = line.match(/\[POLICY\] (\w+) -> (\w+)/);
    if (polMatch) result.transitions.push({ from: polMatch[1], to: polMatch[2] });
  }
  result.heapAvgMB = result.samples > 0 ? heapSum / result.samples : 0;
  result.rssAvgMB = result.samples > 0 ? rssSum / result.samples : 0;
  result.statesVisited = Array.from(stateSet);
  return result;
}
