#!/usr/bin/env node
/**
 * nproxy - Node.js ランタイム I/O プロキシ (Byte層 + Text層)
 *
 * 使い方:
 *   node nproxy.js [options] app.js [args...]
 *
 * Options:
 *   --text=MODE         off | passthrough | transform | tee  (default: off)
 *   --text-log=PATH     tee mode のログ出力先 (default: ./nproxy.text.log)
 *
 * 環境変数 (CLI 同名):
 *   NPROXY_TEXT, NPROXY_TEXT_LOG
 *   NPROXY_DEBUG, NPROXY_LOG
 *   NPROXY_PRESSURE_MB, NPROXY_CRITICAL_MB
 *   NPROXY_RING_NORMAL, NPROXY_RING_PRESSURE
 *   NPROXY_TICK_MS
 *
 * 設計原則 (3 principles):
 *   ① chunk 非保持 (No Chunk Retention)
 *   ② backpressure 委譲 (Delegate to OS-level)
 *   ③ policy は副作用の縮退のみ (Policy Reduces Side-effects Only)
 *
 * Text 層は ③ の延長: text decode/transform 自体を「重い副作用」と位置付け、
 * Node のメモリ状況 (NORMAL/PRESSURE/CRITICAL) に応じて動的に ON/OFF する。
 */

'use strict';

const { spawn } = require('child_process');
const { Transform, PassThrough } = require('stream');
const { StringDecoder } = require('string_decoder');
const fs = require('fs');
const path = require('path');

// -----------------------------------------------------------
// 引数 / 環境変数パース
// -----------------------------------------------------------
function parseArgs(argv) {
  const out = { text: null, textLog: null, app: null, appArgs: [] };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--text' && argv[i+1]) { out.text = argv[++i]; continue; }
    if (a.startsWith('--text=')) { out.text = a.slice(7); continue; }
    if (a === '--text-log' && argv[i+1]) { out.textLog = argv[++i]; continue; }
    if (a.startsWith('--text-log=')) { out.textLog = a.slice(11); continue; }
    out.app = a;
    out.appArgs = argv.slice(i+1);
    break;
  }
  return out;
}

const cli = parseArgs(process.argv.slice(2));
if (!cli.app) {
  process.stderr.write('Usage: node nproxy.js [--text=MODE] [--text-log=PATH] <app.js> [args...]\n');
  process.exit(2);
}

const VALID_TEXT_MODES = ['off', 'passthrough', 'transform', 'tee'];
const TEXT_MODE_REQUESTED = (cli.text || process.env.NPROXY_TEXT || 'off').toLowerCase();
if (VALID_TEXT_MODES.indexOf(TEXT_MODE_REQUESTED) < 0) {
  process.stderr.write(`Invalid --text mode: ${TEXT_MODE_REQUESTED}\n`);
  process.exit(2);
}

const CFG = Object.freeze({
  debug:        process.env.NPROXY_DEBUG === '1',
  logPath:      process.env.NPROXY_LOG || path.join(process.cwd(), 'nproxy.debug.log'),
  pressureMB:   parseInt(process.env.NPROXY_PRESSURE_MB || '80', 10),
  criticalMB:   parseInt(process.env.NPROXY_CRITICAL_MB || '200', 10),
  ringNormal:   parseInt(process.env.NPROXY_RING_NORMAL || '1024', 10),
  ringPressure: parseInt(process.env.NPROXY_RING_PRESSURE || '128', 10),
  tickMs:       parseInt(process.env.NPROXY_TICK_MS || '500', 10),
  textRequested: TEXT_MODE_REQUESTED,
  textLogPath:  cli.textLog || process.env.NPROXY_TEXT_LOG || path.join(process.cwd(), 'nproxy.text.log'),
  maxLineBytes: parseInt(process.env.NPROXY_MAX_LINE_BYTES || String(1024*1024), 10),
});

// -----------------------------------------------------------
// デバッグログ
// -----------------------------------------------------------
let logFd = null;
if (CFG.debug) {
  try { logFd = fs.openSync(CFG.logPath, 'a'); } catch (e) {}
}
function dlog(s) {
  if (logFd === null) return;
  try { fs.writeSync(logFd, s + '\n'); } catch (_) {}
}

// -----------------------------------------------------------
// RingMetaBuffer (chunk 本体は保持しない)
// -----------------------------------------------------------
class RingMetaBuffer {
  constructor(size) {
    this.size = size | 0;
    this.buf = this.size > 0 ? new Array(this.size) : null;
    this.idx = 0;
    this.count = 0;
  }
  push(meta) {
    if (this.size === 0) return;
    this.buf[this.idx] = meta;
    this.idx = (this.idx + 1) % this.size;
    if (this.count < this.size) this.count++;
  }
  resize(newSize) {
    newSize = newSize | 0;
    if (newSize === this.size) return;
    if (newSize === 0) { this.buf = null; this.idx = 0; this.count = 0; this.size = 0; return; }
    const items = this.toArray();
    this.size = newSize;
    this.buf = new Array(newSize);
    this.idx = 0;
    this.count = 0;
    const start = Math.max(0, items.length - newSize);
    for (let i = start; i < items.length; i++) this.push(items[i]);
  }
  toArray() {
    if (this.size === 0 || this.count === 0) return [];
    const out = new Array(this.count);
    const start = (this.idx - this.count + this.size) % this.size;
    for (let i = 0; i < this.count; i++) out[i] = this.buf[(start + i) % this.size];
    return out;
  }
}

// -----------------------------------------------------------
// Observer (byte 層の観測)
// -----------------------------------------------------------
const Observer = {
  enabled: true,
  hexPreview: true,
  totalIn: 0, totalOut: 0, totalErr: 0,
  windowStart: Date.now(), windowOut: 0, windowErr: 0,
  enable(){this.enabled=true;}, disable(){this.enabled=false;},
  enableHexPreview(){this.hexPreview=true;}, disableHexPreview(){this.hexPreview=false;},
  onChunk(kind, chunk) {
    const size = chunk ? chunk.length : 0;
    if (size === 0) return;
    if (kind === 'in') this.totalIn += size;
    else if (kind === 'out') { this.totalOut += size; this.windowOut += size; }
    else if (kind === 'err') { this.totalErr += size; this.windowErr += size; }
    if (!this.enabled) return;
    const meta = { ts: Date.now(), kind, size };
    if (this.hexPreview && Buffer.isBuffer(chunk)) {
      meta.head16 = chunk.slice(0, 16).toString('hex');
    }
    Ring.push(meta);
  },
  flowRate() {
    const now = Date.now();
    const dt = (now - this.windowStart) / 1000 || 1;
    const r = (this.windowOut + this.windowErr) / dt;
    this.windowStart = now; this.windowOut = 0; this.windowErr = 0;
    return r;
  }
};

// -----------------------------------------------------------
// TextObserver (text 層の観測)
// -----------------------------------------------------------
const TextObserver = {
  totalChars: 0,
  totalLines: 0,
  decodeNs: 0,         // decode に費やした合計ナノ秒
  pendingBytes: 0,     // StringDecoder に保留中のバイト数 (推定)
  maxLineBytes: 0,     // 観測した最大の行サイズ
  forcedFlushes: 0,    // maxLineBytes 超過で強制 flush した回数
  modeTransitions: [], // [{ts, from, to, reason}]
  currentMode: 'off',
};

// -----------------------------------------------------------
// MemoryPolicy
// -----------------------------------------------------------
const MemoryPolicy = {
  state: 'NORMAL',
  evaluate() {
    const m = process.memoryUsage();
    const heapMB = m.heapUsed / 1048576;
    if (heapMB >= CFG.criticalMB) return 'CRITICAL';
    if (heapMB >= CFG.pressureMB) return 'PRESSURE';
    return 'NORMAL';
  },
  apply(next) {
    if (next === this.state) return;
    const prev = this.state;
    this.state = next;
    dlog(`[POLICY] ${prev} -> ${next} (heap=${(process.memoryUsage().heapUsed/1048576).toFixed(1)}MB)`);
    if (next === 'NORMAL') {
      Observer.enable(); Observer.enableHexPreview();
      Ring.resize(CFG.ringNormal);
      TextController.applyForState('NORMAL');
    } else if (next === 'PRESSURE') {
      Observer.enable(); Observer.disableHexPreview();
      Ring.resize(CFG.ringPressure);
      TextController.applyForState('PRESSURE');
    } else if (next === 'CRITICAL') {
      Observer.disable();
      Ring.resize(0);
      TextController.applyForState('CRITICAL');
      if (typeof global.gc === 'function') { try { global.gc(); } catch (_) {} }
    }
  }
};

const Ring = new RingMetaBuffer(CFG.ringNormal);

// -----------------------------------------------------------
// TextDecodeStream: Buffer → string Transform (StringDecoder ラップ)
//   - chunk 境界の UTF-8 を壊さない
//   - encoding: 'utf8'
// -----------------------------------------------------------
class TextDecodeStream extends Transform {
  constructor() {
    super({ readableObjectMode: false, writableObjectMode: false });
    this.decoder = new StringDecoder('utf8');
  }
  _transform(chunk, _enc, cb) {
    const t0 = process.hrtime();
    const s = this.decoder.write(chunk);
    const dt = process.hrtime(t0);
    TextObserver.decodeNs += dt[0]*1e9 + dt[1];
    TextObserver.totalChars += s.length;
    if (s.length > 0) this.push(s);
    cb();
  }
  _flush(cb) {
    const tail = this.decoder.end();
    if (tail.length > 0) {
      TextObserver.totalChars += tail.length;
      this.push(tail);
    }
    cb();
  }
}

// -----------------------------------------------------------
// LineTransform: string → string (加工: タイムスタンプ + 行番号)
//   - 改行までを内部に保持。maxLineBytes 超過で強制 flush
//   - chunk 非保持原則は「行単位」になる: 1 行ぶんの文字列だけは持つが、
//     上限を policy 連動で制御する
// -----------------------------------------------------------
class LineTransform extends Transform {
  constructor() {
    super({ readableObjectMode: false, writableObjectMode: false, encoding: 'utf8' });
    this.partial = '';
    this.lineNo = 0;
  }
  _transform(strChunk, _enc, cb) {
    // strChunk は decodeStream の出力なので string
    const text = (typeof strChunk === 'string') ? strChunk : strChunk.toString('utf8');
    const buf = this.partial + text;
    this.partial = '';
    let start = 0;
    while (true) {
      const nl = buf.indexOf('\n', start);
      if (nl === -1) break;
      const line = buf.substring(start, nl + 1);
      this.lineNo++;
      TextObserver.totalLines++;
      const lineSize = Buffer.byteLength(line, 'utf8');
      if (lineSize > TextObserver.maxLineBytes) TextObserver.maxLineBytes = lineSize;
      // 加工: 行頭にタイムスタンプ＋行番号
      this.push(`[${new Date().toISOString()}] ${String(this.lineNo).padStart(7,' ')} | ${line}`);
      start = nl + 1;
    }
    // 残りは保留
    const remain = buf.substring(start);
    // 保留が極端に大きい場合は強制 flush (改行なし巨大入力対策)
    if (Buffer.byteLength(remain, 'utf8') > CFG.maxLineBytes) {
      TextObserver.forcedFlushes++;
      this.lineNo++;
      this.push(`[${new Date().toISOString()}] ${String(this.lineNo).padStart(7,' ')} | <FORCED-FLUSH>${remain}\n`);
      this.partial = '';
    } else {
      this.partial = remain;
    }
    cb();
  }
  _flush(cb) {
    if (this.partial) {
      this.lineNo++;
      this.push(`[${new Date().toISOString()}] ${String(this.lineNo).padStart(7,' ')} | ${this.partial}`);
      this.partial = '';
    }
    cb();
  }
}

// -----------------------------------------------------------
// TeeTransform: string をそのまま下流へ流しつつ、ログファイルにも書く
// -----------------------------------------------------------
class TeeTransform extends Transform {
  constructor(logStream) {
    super({ readableObjectMode: false, writableObjectMode: false, encoding: 'utf8' });
    this.logStream = logStream;
  }
  _transform(strChunk, _enc, cb) {
    if (this.logStream && this.logStream.writable) {
      // backpressure を無視しないが、tee は best-effort: ログ側が遅くても本流を止めない設計
      this.logStream.write(strChunk);
    }
    this.push(strChunk);
    cb();
  }
}

// -----------------------------------------------------------
// TextController: モードの動的切替
//   - 子の stdout / stderr の入口に PassThrough を挟み、
//     その下流のチェーンを動的に差し替える
// -----------------------------------------------------------
const TextController = {
  // 子 stdout 用 / 子 stderr 用 それぞれにチェーンを管理
  chains: {},  // key: 'out'|'err' -> { input: PassThrough, current: 'off'|... , downstream: Writable[] }

  setup(kind, source, finalSink, kindLabel) {
    // input は固定の PassThrough。source.pipe(input) しておく
    const input = new PassThrough();
    source.pipe(input);
    this.chains[kind] = {
      input,
      finalSink,
      kindLabel,
      currentMode: 'off',
      pipeline: null,  // 直前に張ったチェーン
    };
    this.applyMode(kind, CFG.textRequested, 'init');
  },

  applyMode(kind, mode, reason) {
    const ch = this.chains[kind];
    if (!ch) return;
    // 初回 (pipeline 未構築) は currentMode 一致でも実行する
    if (ch.currentMode === mode && ch.pipeline !== null) return;
    const prev = ch.currentMode;

    // 旧チェーンを切り離す
    if (ch.pipeline) {
      try { ch.input.unpipe(ch.pipeline.head); } catch (_) {}
      // pipeline の終端は finalSink。それを切るのは end が来てしまうので避ける
      try { ch.pipeline.tail.unpipe(ch.finalSink); } catch (_) {}
      // 旧 transform を end して保留 UTF-8 を flush する
      try { ch.pipeline.head.end(); } catch (_) {}
      ch.pipeline = null;
    }

    // 新チェーン構築
    let pipeline;
    if (mode === 'off') {
      ch.input.pipe(ch.finalSink, { end: false });  // end は子終了時に手動で
      ch.pipeline = { head: ch.finalSink, tail: ch.finalSink, components: [] };
    } else if (mode === 'passthrough') {
      const dec = new TextDecodeStream();
      ch.input.pipe(dec);
      dec.pipe(ch.finalSink, { end: false });
      ch.pipeline = { head: dec, tail: dec, components: [dec] };
    } else if (mode === 'transform') {
      const dec = new TextDecodeStream();
      const lt = new LineTransform();
      ch.input.pipe(dec);
      dec.pipe(lt);
      lt.pipe(ch.finalSink, { end: false });
      ch.pipeline = { head: dec, tail: lt, components: [dec, lt] };
    } else if (mode === 'tee') {
      const dec = new TextDecodeStream();
      const tee = new TeeTransform(this.teeLogStream);
      ch.input.pipe(dec);
      dec.pipe(tee);
      tee.pipe(ch.finalSink, { end: false });
      ch.pipeline = { head: dec, tail: tee, components: [dec, tee] };
    }

    ch.currentMode = mode;
    TextObserver.currentMode = mode;
    TextObserver.modeTransitions.push({ ts: Date.now(), kind: ch.kindLabel, from: prev, to: mode, reason });
    dlog(`[TEXT] ${ch.kindLabel}: ${prev} -> ${mode} (reason=${reason})`);
  },

  // policy state に応じて mode を自動調整
  applyForState(state) {
    let target;
    if (state === 'NORMAL') target = CFG.textRequested;            // 要求モードへ復帰
    else if (state === 'PRESSURE') {
      // transform / tee は重いので passthrough に縮退。passthrough は維持。off は維持
      if (CFG.textRequested === 'transform' || CFG.textRequested === 'tee') target = 'passthrough';
      else target = CFG.textRequested;
    }
    else if (state === 'CRITICAL') target = 'off';                 // 何があっても直結
    if (!target) target = 'off';
    for (const k of Object.keys(this.chains)) {
      this.applyMode(k, target, `policy-${state}`);
    }
  },

  endAll() {
    for (const k of Object.keys(this.chains)) {
      const ch = this.chains[k];
      if (ch.pipeline && ch.pipeline.head !== ch.finalSink) {
        try { ch.pipeline.head.end(); } catch (_) {}
      }
    }
  }
};

// tee 用ログストリーム
TextController.teeLogStream = (CFG.textRequested === 'tee')
  ? fs.createWriteStream(CFG.textLogPath, { flags: 'a' })
  : null;

// -----------------------------------------------------------
// 子プロセス起動
// -----------------------------------------------------------
const child = spawn(cli.app, cli.appArgs, {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
});

dlog(`[INIT] spawned pid=${child.pid} cmd=${process.execPath} ${cli.app} ${cli.appArgs.join(' ')}`);
dlog(`[INIT] config: pressure=${CFG.pressureMB}MB critical=${CFG.criticalMB}MB tick=${CFG.tickMs}ms textRequested=${CFG.textRequested}`);

// -----------------------------------------------------------
// stream 中継 (byte 層 + text 層)
// -----------------------------------------------------------

// stdin は byte 直結 (text 層対象外)
function wrapWriteForObserve(writable, kind) {
  if (!writable) return;
  const orig = writable.write.bind(writable);
  writable.write = function(chunk, ...rest) {
    if (chunk && chunk.length) {
      Observer.onChunk(kind, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return orig(chunk, ...rest);
  };
}
wrapWriteForObserve(child.stdin, 'in');
wrapWriteForObserve(process.stdout, 'out');
wrapWriteForObserve(process.stderr, 'err');
process.stdin.pipe(child.stdin);

// stdout / stderr は TextController 経由
TextController.setup('out', child.stdout, process.stdout, 'stdout');
TextController.setup('err', child.stderr, process.stderr, 'stderr');

// stdin の end → 子の stdin を end
process.stdin.on('end', () => {
  if (!child.stdin.destroyed) {
    try { child.stdin.end(); } catch (_) {}
  }
});

// EPIPE 抑制
function suppressEpipe(stream) {
  if (!stream) return;
  stream.on('error', (e) => {
    if (e && (e.code === 'EPIPE' || e.code === 'ERR_STREAM_DESTROYED')) {
      if (!child.killed) child.kill('SIGTERM');
    } else {
      dlog(`[STREAM ERR] ${e && e.stack || e}`);
    }
  });
}
[process.stdout, process.stderr, child.stdin, child.stdout, child.stderr].forEach(suppressEpipe);

// シグナル中継
['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(sig => {
  try {
    process.on(sig, () => {
      dlog(`[SIGNAL] ${sig}`);
      if (!child.killed) { try { child.kill(sig); } catch(_) {} }
    });
  } catch (_) {}
});

// -----------------------------------------------------------
// 観測タイマ
// -----------------------------------------------------------
const tick = setInterval(() => {
  MemoryPolicy.apply(MemoryPolicy.evaluate());
  const rate = Observer.flowRate();
  const m = process.memoryUsage();
  dlog(`[TICK] state=${MemoryPolicy.state} heap=${(m.heapUsed/1048576).toFixed(1)}MB rss=${(m.rss/1048576).toFixed(1)}MB rate=${(rate/1024).toFixed(1)}KB/s totals(in/out/err)=${Observer.totalIn}/${Observer.totalOut}/${Observer.totalErr} text=${TextObserver.currentMode} chars=${TextObserver.totalChars} lines=${TextObserver.totalLines} decodeMs=${(TextObserver.decodeNs/1e6).toFixed(1)} maxLine=${TextObserver.maxLineBytes} forcedFlush=${TextObserver.forcedFlushes}`);
}, CFG.tickMs);
tick.unref();

// -----------------------------------------------------------
// 終了処理
// -----------------------------------------------------------
function gracefulExit(code, signal) {
  try { TextController.endAll(); } catch (_) {}
  if (TextController.teeLogStream) {
    try { TextController.teeLogStream.end(); } catch (_) {}
  }
  dlog(`[CHILD EXIT] code=${code} signal=${signal} totals(in/out/err)=${Observer.totalIn}/${Observer.totalOut}/${Observer.totalErr} text(chars/lines)=${TextObserver.totalChars}/${TextObserver.totalLines}`);
  clearInterval(tick);
  // process.stdout / process.stderr に write('', cb) を入れて、これまでの全 write が
  // OS パイプに渡るのを待ってから exit する (Node 標準の流儀)
  let pending = 2;
  const done = () => {
    pending--;
    if (pending > 0) return;
    if (logFd !== null) { try { fs.closeSync(logFd); logFd = null; } catch(_){} }
    if (signal) process.kill(process.pid, signal);
    else process.exit(code == null ? 0 : code);
  };
  try { process.stdout.write('', done); } catch (_) { done(); }
  try { process.stderr.write('', done); } catch (_) { done(); }
  setTimeout(() => {
    if (pending > 0) {
      pending = 0;
      if (logFd !== null) { try { fs.closeSync(logFd); logFd = null; } catch(_){} }
      if (signal) process.kill(process.pid, signal);
      else process.exit(code == null ? 0 : code);
    }
  }, 1000).unref();
}

child.on('close', (code, signal) => { gracefulExit(code, signal); });
child.on('error', (err) => {
  dlog(`[CHILD ERROR] ${err && err.stack || err}`);
  process.stderr.write(`nproxy: failed to spawn child: ${err.message}\n`);
  process.exit(127);
});

process.on('exit', (code) => {
  if (logFd !== null) {
    try {
      const snap = Ring.toArray();
      fs.writeSync(logFd, `[EXIT] code=${code} ringSize=${Ring.size} ringCount=${snap.length} text(transitions)=${TextObserver.modeTransitions.length}\n`);
      fs.closeSync(logFd);
    } catch (_) {}
  }
});
