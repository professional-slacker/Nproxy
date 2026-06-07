'use strict';

// ============================================================
// nproxy.js — Runtime I/O Proxy
//
// Usage:
//   CLI mode (spawn child):   node nproxy.js [opts] -- command
//   Preload mode (intercept): node -r ./nproxy.js app
//
// Principles:
//   1. Control codes pass through unmodified
//   2. Signals are relayed
//   3. Protocol layer is outside nproxy
// ============================================================

// ---- TRACE logging (internal, non-public) ----
let traceLogPath = null;
let traceEnabled = false;

function initTraceLogger() {
  if (process.env.NPROXY_TRACE_WRITE) {
    traceEnabled = true;
    if (process.env.NPROXY_TRACE_LOG) {
      traceLogPath = process.env.NPROXY_TRACE_LOG;
    } else {
      traceLogPath = require('path').join(process.cwd(), 'nproxy_trace.log');
    }
    // Touch the file
    try {
      require('fs').appendFileSync(traceLogPath, '');
    } catch (e) {
      // ignore
    }
  }
}

function traceLog(line) {
  if (!traceEnabled || !traceLogPath) return;
  try {
    require('fs').appendFileSync(traceLogPath, line + '\n');
  } catch (e) {
    // ignore write errors
  }
}

initTraceLogger();

// ---- Memory guard thresholds (auto-scaled to V8 heap limit) ----
// Base DFS values calibrated for ~1600MB default heap.
// Ratios: attention=16%, pressure=32%, critical=64%, emergency=80%.
const HEAP_LIMIT_MB = (() => {
  try { return require('v8').getHeapStatistics().heap_size_limit / 1024 / 1024; } catch (_) { return 1600; }
})();
const DFS_ATTENTION_MB  = Math.round(HEAP_LIMIT_MB * 0.16);
const DFS_PRESSURE_MB   = Math.round(HEAP_LIMIT_MB * 0.32);
const DFS_CRITICAL_MB   = Math.round(HEAP_LIMIT_MB * 0.64);
const DFS_EMERGENCY_MB  = Math.round(HEAP_LIMIT_MB * 0.80);
const DEFAULT_ATTENTION_MB = parseInt(process.env.NPROXY_ATTENTION_MB || String(DFS_ATTENTION_MB), 10);
const DEFAULT_PRESSURE_MB  = parseInt(process.env.NPROXY_PRESSURE_MB || String(DFS_PRESSURE_MB), 10);
const DEFAULT_CRITICAL_MB  = parseInt(process.env.NPROXY_CRITICAL_MB || String(DFS_CRITICAL_MB), 10);
const DEFAULT_EMERGENCY_MB = parseInt(process.env.NPROXY_EMERGENCY_MB || String(DFS_EMERGENCY_MB), 10);
const DEFAULT_TICK_MS = parseInt(process.env.NPROXY_TICK_MS || '200', 10);
const DEFAULT_MONITOR = process.env.NPROXY_MONITOR || 'auto'; // auto | rss | split | array

// Debug levels: 1=chunk split, 2=memory summary, 3=divergence warn, 4=state detail, 5=full dump
const DEBUG_LEVEL = parseInt(process.env.NPROXY_DEBUG || '0', 10);
function debugLog(level, msg) {
  if (DEBUG_LEVEL >= level) process.stderr.write(`\x1b[90m[nproxy:dbg${level}] ${msg}\x1b[0m\n`);
}

// Track if child process exited abnormally (CLI mode) to avoid duplicate crash dumps
let _childExitedAbnormally = false;

// Stdin Flow Controller — manages input rate based on memory state
// Instead of replacing process.stdin (getter-only), monkey-patches on/addListener/once/read.
// Intercepts stdin data flow and controls rate based on monitor.state.
class StdinFlowController {
  constructor(monitor) {
    this.monitor = monitor;
    this.realStdin = process.stdin;
    this.appHandlers = { data: [], end: [], error: [], readable: [] };
    this.tempFile = null;
    this.tempFd = null;
    this.fileMode = false;
    this.replayTimer = null;
    this.replayRate = 65536; // 64KB/s replay rate
    this.bytesWritten = 0;
    this.bytesReplayed = 0;
    this._origOn = null;
    this._origAddListener = null;
    this._origPrependListener = null;
    this._origOnce = null;
    this._origRemoveListener = null;
    this._patched = false;
    this._ended = false;
    this._inputHandlerCount = 0;
  }

  start() {
    if (!this.realStdin) return;
    // Save original on BEFORE patching — internal handlers must use origOn
    const origOn = this.realStdin.on.bind(this.realStdin);
    this._patchMethods();
    this._patched = true;
    this._pendingBuffer = [];
    this._pendingEnd = false;
    // Internal handlers use origOn (real EventEmitter) — NOT the patched version
    if (DEBUG_LEVEL >= 5) process.stderr.write(`[nproxy:dbg5] stdin raw: readable=${this.realStdin.readable}, isTTY=${!!this.realStdin.isTTY}\n`);
    origOn.call(this.realStdin, 'data', (chunk) => {
      this._pendingBuffer.push(chunk);
      if (this.appHandlers.data.length > 0) this._flushPending();
    });
    origOn.call(this.realStdin, 'end', () => {
      this._pendingEnd = true;
      if (this.appHandlers.data.length > 0) this._flushPending();
      this._handleEnd();
    });
    origOn.call(this.realStdin, 'error', (err) => this._handleError(err));
    // Unref stdin so it doesn't keep the event loop alive in preload mode.
    // It will be reffed when the host app registers a data/readable handler.
    if (typeof this.realStdin.unref === 'function') this.realStdin.unref();
    this._pollState();
  }

  _flushPending() {
    if (DEBUG_LEVEL >= 5) process.stderr.write(`[nproxy:dbg5] _flushPending: buffer=${this._pendingBuffer.length}, handlers=${this.appHandlers.data.length}\n`);
    // Flush data chunks BEFORE end — otherwise app gets 'end' before all data
    for (const chunk of this._pendingBuffer.splice(0)) {
      this._handleData(chunk);
    }
    if (this._pendingEnd && this.appHandlers.data.length > 0) this._handleEnd();
  }

  _patchMethods() {
    const ctrl = this;
    const patchedEvents = new Set(['data', 'end', 'error', 'readable']);

    this._origOn = this.realStdin.on.bind(this.realStdin);
    this.realStdin.on = function (event, handler) {
      if (patchedEvents.has(event)) {
        ctrl.appHandlers[event].push(handler);
        if (event === 'data' || event === 'readable') {
          ctrl._inputHandlerCount++;
          if (ctrl._inputHandlerCount === 1 && typeof ctrl.realStdin.ref === 'function') ctrl.realStdin.ref();
        }
        if (DEBUG_LEVEL >= 5) process.stderr.write(`[nproxy:dbg5] stdin.on('${event}') — appHandlers.${event}.length=${ctrl.appHandlers[event].length}\n`);
        if (event === 'data') ctrl._flushPending();
        return this;
      }
      return ctrl._origOn(event, handler);
    };

    this._origAddListener = this.realStdin.addListener.bind(this.realStdin);
    this.realStdin.addListener = this.realStdin.on;

    this._origPrependListener = this.realStdin.prependListener.bind(this.realStdin);
    this.realStdin.prependListener = function (event, handler) {
      if (patchedEvents.has(event)) {
        ctrl.appHandlers[event].unshift(handler);
        if (event === 'data' || event === 'readable') {
          ctrl._inputHandlerCount++;
          if (ctrl._inputHandlerCount === 1 && typeof ctrl.realStdin.ref === 'function') ctrl.realStdin.ref();
        }
        if (event === 'data') ctrl._flushPending();
        return this;
      }
      return ctrl._origPrependListener(event, handler);
    };

    this._origOnce = this.realStdin.once.bind(this.realStdin);
    this.realStdin.once = function (event, handler) {
      if (patchedEvents.has(event)) {
        const wrapped = (...args) => {
          if (event === 'data' || event === 'readable') {
            ctrl._inputHandlerCount--;
            if (ctrl._inputHandlerCount <= 0 && typeof ctrl.realStdin.unref === 'function') ctrl.realStdin.unref();
          }
          handler(...args);
          const idx = ctrl.appHandlers[event].indexOf(wrapped);
          if (idx >= 0) ctrl.appHandlers[event].splice(idx, 1);
        };
        ctrl.appHandlers[event].push(wrapped);
        if (event === 'data' || event === 'readable') {
          ctrl._inputHandlerCount++;
          if (ctrl._inputHandlerCount === 1 && typeof ctrl.realStdin.ref === 'function') ctrl.realStdin.ref();
        }
        if (event === 'data') ctrl._flushPending();
        return this;
      }
      return ctrl._origOnce(event, handler);
    };

    this._origRemoveListener = this.realStdin.removeListener.bind(this.realStdin);
    this._origOff = this.realStdin.off.bind(this.realStdin);
    this.realStdin.removeListener = function (event, handler) {
      if (patchedEvents.has(event)) {
        const idx = ctrl.appHandlers[event].indexOf(handler);
        if (idx >= 0) {
          ctrl.appHandlers[event].splice(idx, 1);
          if (event === 'data' || event === 'readable') {
            ctrl._inputHandlerCount--;
            if (ctrl._inputHandlerCount <= 0 && typeof ctrl.realStdin.unref === 'function') ctrl.realStdin.unref();
          }
        }
        return this;
      }
      return ctrl._origRemoveListener(event, handler);
    };
    this.realStdin.off = this.realStdin.removeListener;
  }

  _unpatchMethods() {
    if (!this._patched) return;
    this.realStdin.on = this._origOn;
    this.realStdin.addListener = this._origAddListener;
    this.realStdin.prependListener = this._origPrependListener;
    this.realStdin.once = this._origOnce;
    this.realStdin.removeListener = this._origRemoveListener;
    this.realStdin.off = this._origOff;
    this._patched = false;
  }

  _pollState() {
    const state = this.monitor.state;
    if (state === 'critical' || state === 'emergency') {
      if (!this.fileMode) this._enterFileMode(state);
    } else if (this.fileMode && (state === 'monitoring' || state === 'attention')) {
      this._exitFileMode();
    }
    setTimeout(() => this._pollState(), 100).unref();
  }

  _handleData(chunk) {
    if (this.fileMode && this.tempFd) {
      const fs = require('fs');
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      fs.writeSync(this.tempFd, buf);
      this.bytesWritten += buf.length;
      return;
    }
    // Normal/attention/pressure: forward to app handlers, possibly split
    this._forwardToApp('data', chunk);
  }

  _handleError(err) {
    this._forwardToApp('error', err);
  }

  _handleEnd() {
    this._ended = true;
    if (this.fileMode) {
      const waitReplay = () => {
        if (this.bytesReplayed >= this.bytesWritten) {
          this._forwardToApp('end');
          this._exitFileMode();
        } else {
          setTimeout(waitReplay, 100).unref();
        }
      };
      waitReplay();
    } else {
      this._forwardToApp('end');
    }
  }

  _forwardToApp(event, ...args) {
    for (const handler of (this.appHandlers[event] || []).slice()) {
      try { handler(...args); } catch (_) {}
    }
  }

  _enterFileMode(state) {
    try {
      const fs = require('fs'), path = require('path'), os = require('os');
      this.tempFile = path.join(os.tmpdir(), `nproxy_stdin_${process.pid}_${Date.now()}.tmp`);
      this.tempFd = fs.openSync(this.tempFile, 'w+'); // rw — _startReplay needs read
      this.fileMode = true;
      this.bytesWritten = 0;
      this.bytesReplayed = 0;
      this._startReplay();
      process.stderr.write(`[nproxy] stdin burst (${state}) → ${this.tempFile}\n`);
    } catch (e) {
      process.stderr.write(`[nproxy] stdin file offload failed: ${e.message}\n`);
      this.fileMode = false;
    }
  }

  _exitFileMode() {
    if (this.replayTimer) { clearTimeout(this.replayTimer); this.replayTimer = null; }
    if (this.tempFd) { try { require('fs').closeSync(this.tempFd); } catch (_) {} this.tempFd = null; }
    if (this.tempFile) { try { require('fs').unlinkSync(this.tempFile); } catch (_) {} this.tempFile = null; }
    this.fileMode = false;
    process.stderr.write('[nproxy] stdin flow recovered\n');
  }

  _startReplay() {
    if (!this.fileMode || !this.tempFd) return;
    const fs = require('fs');
    try {
      const stats = fs.fstatSync(this.tempFd);
      const remaining = stats.size - this.bytesReplayed;
      if (remaining <= 0) {
        if (this._ended) { this._forwardToApp('end'); this._exitFileMode(); }
        return;
      }
      const chunkSize = Math.min(this.replayRate, remaining);
      const buf = Buffer.alloc(chunkSize);
      const bytesRead = fs.readSync(this.tempFd, buf, 0, chunkSize, this.bytesReplayed);
      if (bytesRead > 0) {
        this.bytesReplayed += bytesRead;
        this._forwardToApp('data', buf.slice(0, bytesRead));
        this.replayTimer = setTimeout(() => this._startReplay(), Math.max(1, (chunkSize / this.replayRate) * 1000)).unref();
      } else {
        this.replayTimer = setTimeout(() => this._startReplay(), 10).unref();
      }
    } catch (_) {
      this.replayTimer = setTimeout(() => this._startReplay(), 50).unref();
    }
  }

  stop() {
    if (this.replayTimer) { clearTimeout(this.replayTimer); this.replayTimer = null; }
    if (this.tempFd) { try { require('fs').closeSync(this.tempFd); } catch (_) {} this.tempFd = null; }
    if (this.tempFile) { try { require('fs').unlinkSync(this.tempFile); } catch (_) {} this.tempFile = null; }
    this._unpatchMethods();
  }
}

// Crash dump — written to cwd on abnormal exit (like a core file)
// writerFn: optional stderr writer (exit handler passes origStderrWrite)
// err: optional error object to include message/stack in dump
function writeCrashDump(reason, state, retries, writerFn, err) {
  // Rate limiting to prevent infinite crash dump loops
  const isEmergency = state === 'emergency';
  const rateLimitKey = `${reason}:${(err?.message || String(err || '')).slice(0, 100)}`;
  const now = Date.now();
  const tracker = _crashDumpTracker.get(rateLimitKey) || { count: 0, firstTime: now, lastTime: 0 };
  const limit = isEmergency ? RATE_LIMIT.emergency : RATE_LIMIT.normal;

  if (now - tracker.firstTime > limit.windowMs) {
    tracker.count = 0;
    tracker.firstTime = now;
  }
  if (tracker.count >= limit.maxCount) {
    const w = writerFn || (process.stderr.write ? (msg) => process.stderr.write(msg) : () => {});
    w(`\x1b[33m[nproxy] crash dump rate limited (${rateLimitKey}): ${tracker.count}/${limit.maxCount} in ${limit.windowMs}ms\x1b[0m\n`);
    return;
  }
  tracker.count++;
  tracker.lastTime = now;
  _crashDumpTracker.set(rateLimitKey, tracker);

  try {
    const mu = process.memoryUsage();
    const v8 = require('v8');
    const hs = v8.getHeapStatistics();
    const rss = (mu.rss / 1024 / 1024).toFixed(1);
    const heapUsed = (mu.heapUsed / 1024 / 1024).toFixed(1);
    const heapTotal = (mu.heapTotal / 1024 / 1024).toFixed(1);
    const external = (mu.external / 1024 / 1024).toFixed(1);
    const arrayBuffers = (mu.arrayBuffers / 1024 / 1024).toFixed(1);
    const divergence = (mu.rss / 1024 / 1024 - mu.heapTotal / 1024 / 1024).toFixed(0);
    // stderr output
    const w = writerFn || (process.stderr.write ? (msg) => process.stderr.write(msg) : () => {});
    w(`\x1b[31;1m[nproxy] ${reason} — state: ${state}, retries: ${retries}\x1b[0m\n`);
    w(`\x1b[31m  RSS: ${rss}MB  heap: ${heapUsed}/${heapTotal}MB  external: ${external}MB  arrayBuffers: ${arrayBuffers}MB\x1b[0m\n`);
    w(`\x1b[31m  RSS-heap divergence: ${divergence}MB  heap_limit: ${(hs.heap_size_limit/1024/1024).toFixed(0)}MB\x1b[0m\n`);
    if (mu.rss / 1024 / 1024 > 500 && mu.rss / 1024 / 1024 > mu.heapTotal / 1024 / 1024 * 2) {
      w(`\x1b[33;1m  ⚠ RSS >> heap: possible native memory leak (nheap_limit, node-pty, Buffer)\x1b[0m\n`);
    }
    // JSON dump file
    const dump = {
      timestamp: new Date().toISOString(),
      reason, state, retries,
      memory: {
        rss_mb: +rss, heapUsed_mb: +heapUsed, heapTotal_mb: +heapTotal,
        external_mb: +external, arrayBuffers_mb: +arrayBuffers,
        rss_heap_divergence_mb: +divergence,
      },
      v8: {
        heap_size_limit_mb: +(hs.heap_size_limit / 1024 / 1024).toFixed(0),
        total_heap_size_mb: +(hs.total_heap_size / 1024 / 1024).toFixed(0),
        used_heap_size_mb: +(hs.used_heap_size / 1024 / 1024).toFixed(0),
        total_physical_size_mb: +(hs.total_physical_size / 1024 / 1024).toFixed(0),
        malloced_memory_mb: +(hs.malloced_memory / 1024 / 1024).toFixed(0),
        peak_malloced_memory_mb: +(hs.peak_malloced_memory / 1024 / 1024).toFixed(0),
      },
      process: {
        pid: process.pid, uptime_s: Math.round(process.uptime()),
        node_version: process.version, argv: process.argv.slice(2),
      },
    };
    if (err) {
      dump.error = {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      };
    }
    try {
      const nhl = require('./nheap_limit');
      if (nhl.getStats) dump.nheap_limit = nhl.getStats();
    } catch (_) {}
    const ts = dump.timestamp.replace(/[:.]/g, '-');
    const prefix = isEmergency ? 'nproxy_emergency_' : 'nproxy_crash_';
    _crashDumpCounter++;
    const filename = `${prefix}${ts}-${_crashDumpCounter}.json`;
    require('fs').writeFileSync(filename, JSON.stringify(dump, null, 2));
    w(`\x1b[33m[nproxy] crash dump: ${filename}\x1b[0m\n`);
  } catch (e) {
    try { process.stderr.write(`\x1b[31m[nproxy] crash dump failed: ${e.message}\x1b[0m\n`); } catch (_) {}
  }
}

// Rate limiting state for crash dumps
const _crashDumpTracker = new Map();
let _crashDumpCounter = 0;
const RATE_LIMIT = {
  normal: { windowMs: 3600000, maxCount: 10 },   // 1 hour / 10 dumps
  emergency: { windowMs: 300000, maxCount: 3 },  // 5 min / 3 dumps
};

// CPU Watchdog constants
const CPU_WATCHDOG_INTERVAL_MS = parseInt(process.env.NPROXY_CPU_WATCHDOG_INTERVAL_MS || '10000', 10); // 10秒間隔
const CPU_WARNING_THRESHOLD = parseFloat(process.env.NPROXY_CPU_WARNING_THRESHOLD || '80'); // 80%以上で警告
const CPU_EMERGENCY_THRESHOLD = parseFloat(process.env.NPROXY_CPU_EMERGENCY_THRESHOLD || '95'); // 95%以上で緊急事態
const CPU_WARNING_DURATION_TICKS = 3; // 3回連続警告でpressure状態
const CPU_EMERGENCY_DURATION_TICKS = 6; // 6回連続緊急でemergency状態 (60秒 @ 10秒間隔)

// Clock ticks per second (constant on Linux, cached after first read)
const CLOCK_TICKS = (() => {
  try {
    return Number(require('os').cpus()[0]?.times?.idle !== undefined ? 100 : 100) || 100;
  } catch (e) {
    return 100;
  }
})();

// Previous CPU measurement state for delta-based calculation
const _cpuState = new Map(); // pid -> { time, total }

// Calculate CPU usage percentage for a given PID (delta-based, instantaneous)
// Returns 0-100 based on the difference from the last measurement for this PID
const getProcessCpuUsage = (pid) => {
  try {
    const fs = require('fs');
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ');
    const utime = parseInt(stat[13], 10);
    const stime = parseInt(stat[14], 10);
    const total = utime + stime;
    const now = Date.now();

    const prev = _cpuState.get(pid);
    _cpuState.set(pid, { time: now, total });

    if (!prev) return 0; // first measurement, no delta yet

    const timeDeltaMs = now - prev.time;
    if (timeDeltaMs <= 0) return 0;

    const cpuDelta = total - prev.total;
    return (cpuDelta / CLOCK_TICKS) / (timeDeltaMs / 1000) * 100;
  } catch (err) {
    return 0; // process may have exited
  }
};

// ---- CLI arg parsing ----
function parseArgs(argv) {
  const out = { text: null, textLog: null, pty: false, help: false, app: null, appArgs: [] };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--text' && argv[i + 1]) { out.text = argv[++i]; continue; }
    if (a.startsWith('--text=')) { out.text = a.slice(7); continue; }
    if (a === '--text-log' && argv[i + 1]) { out.textLog = argv[++i]; continue; }
    if (a.startsWith('--text-log=')) { out.textLog = a.slice(11); continue; }
    if (a === '--pty') { out.pty = true; continue; }
    if (a === '--no-pty') { out.pty = false; continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a === '--') { i++; break; }
    out.app = a;
    out.appArgs = argv.slice(i + 1);
    break;
  }
  // After --, set app from remaining args
  if (!out.app && i < argv.length) {
    out.app = argv[i];
    out.appArgs = argv.slice(i + 1);
  }
  return out;
}

// ---- Text processing helpers ----
const TEXT_MODES = ['passthrough', 'strip-ansi', 'transform'];

function createTextProcessor(mode) {
  if (!mode || mode === 'passthrough' || mode === 'off') {
    return (chunk) => chunk;
  }

  // Ink needs: SGR (m), cursor move/position (A B C D G H f), erase (J K),
  // scroll (S T), save/restore (s u), device status (n).
  // Strip everything else: OSC 8 hyperlinks, DCS, DEC private modes, etc.
  //
  // CSI = \x1b[ + optional params + final byte
  // Keep if final byte is one of: A B C D G H J K S T f H m s u
  // Strip if: final byte is anything else, or it has private marker (? > = etc.)
  // Strip: OSC (\x1b]...ST), DCS (\x1bP...ST), SOS/PM/APC (\x1bX\x1b^\x1b_)
  // CSI final bytes 0x40-0x7e (@ through ~), excluding 0x3f (?) which is a private marker
  const keepFinal = new Set(['A','B','C','D','G','H','J','K','S','T','f','H','m','s','u','n','l','h']);
  const ansiRe = /\x1b\[[\x20-\x3f]*[\d;]*[\x40-\x7e]|\x1b[PX^_].*?(?:\x07|\x1b\\)|\x1b].*?(?:\x07|\x1b\\)|\x1b[X^_\\]|[\x80-\x9f]/g;

  function stripAnsi(s) {
    if (typeof s !== 'string') return s;
    return s.replace(ansiRe, (m) => {
      // If it's a CSI sequence (\x1b[...finalbyte) without private markers, check final byte
      if (m[0] === '\x1b' && m[1] === '[' && m.length >= 3) {
        // Check for private markers: characters 0x20-0x2f between '[' and params
        const paramStart = 2;
        let i = paramStart;
        let marker = '';
        while (i < m.length && m.charCodeAt(i) >= 0x20 && m.charCodeAt(i) <= 0x2f) {
          marker += m[i];
          i++;
        }
        // Allow cursor show/hide: \x1b[?25h and \x1b[?25l
        if (marker === '?' && (m.endsWith('h') || m.endsWith('l'))) return m;
        if (i > paramStart) return ''; // has private/prefix marker -> strip
        // Find final byte
        const finalByte = m[m.length - 1];
        if (keepFinal.has(finalByte)) return m; // keep
        return ''; // strip
      }
      // Non-CSI escape -> strip (OSC, DCS, SOS, etc.)
      return '';
    });
  }

  if (mode === 'strip-ansi') {
    return (chunk) => stripAnsi(chunk);
  }
  if (mode === 'transform') {
    return (chunk) => {
      if (typeof chunk !== 'string') return chunk;
      return stripAnsi(chunk).normalize('NFC');
    };
  }
  return (chunk) => chunk;
}

// ---- Input processing helpers ----
function createInputProcessor(mode) {
  // 入力変換は基本的にpassthrough
  // 将来的に入力変換が必要になった場合に備えて用意
  if (!mode || mode === 'passthrough' || mode === 'off') {
    return (chunk) => chunk;
  }
  // 入力に対する変換は現在は未実装
  // 必要に応じて追加
  return (chunk) => chunk;
}

// ---- Memory Monitor ----
class MemoryMonitor {
  constructor(opts = {}) {
    this.attentionMb = opts.attentionMb || DEFAULT_ATTENTION_MB;
    this.pressureMb = opts.pressureMb || DEFAULT_PRESSURE_MB;
    this.criticalMb = opts.criticalMb || DEFAULT_CRITICAL_MB;
    this.emergencyMb = opts.emergencyMb || DEFAULT_EMERGENCY_MB;
    this.tickMs = Math.max(50, parseInt(opts.tickMs, 10) || DEFAULT_TICK_MS); // default 200ms, min 50ms
    // 5-stage guard: monitoring -> attention -> pressure -> critical -> emergency
    this.state = 'monitoring';
    this._timer = null;
    this._onTransition = opts.onTransition || (() => {});
    // If set, monitor child process RSS via /proc/{pid}/status instead of process.memoryUsage()
    this.childPid = opts.childPid || 0;
    this._rssKb = 0;
    this._heapMb = 0;
    // -- surge detection --
    this._prevMb = 0;
    this._surgeThreshold = opts.surgeThresholdMb || 32;
    this._consecutiveSurges = 0;
    // -- V8 heap/external spike tracking (preload mode only) --
    this._prevHeapUsed = 0;
    this._prevExternal = 0;
    // -- spike count: consecutive spike detections before emergency --
    this._spikeCount = 0;
    // -- emergency sustained tick counter (fires exit even if _onTransition is not called) --
    this._emergencyTicks = 0;
    // -- monitor tier: 'rss' | 'split' | 'array' --
    this.monitorTier = opts.monitorTier || DEFAULT_MONITOR;
    // -- guard: installMonitorTier() でプロトタイプ変更済みか --
    this._tierInstalled = false;
    this._arrayProxyInstalled = false;
  }

  get rssMb() { return Math.round(this._rssKb / 1024); }

  start() {
    this._tick();
    return this;
  }

  stop() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    return this;
  }

  // Read VmRSS from /proc/{pid}/status (Linux only)
  _readChildRssKb() {
    try {
      const fs = require('fs');
      const status = fs.readFileSync(`/proc/${this.childPid}/status`, 'utf8');
      const m = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
      return m ? parseInt(m[1], 10) : 0;
    } catch {
      return 0; // process may have exited, file may not exist (non-Linux)
    }
  }

  _tick() {
    let heapMb;
    let usage;
    let heapUsedMb = 0;
    if (this.childPid > 0) {
      this._rssKb = this._readChildRssKb();
      heapMb = Math.round(this._rssKb / 1024);
    } else {
      usage = process.memoryUsage();
      // Use RSS as the pressure metric: it captures V8 heap + external memory
      // (Buffer.alloc, native addons) + the process's actual memory footprint.
      heapMb = Math.round(usage.rss / 1024 / 1024);
      heapUsedMb = Math.round(usage.heapUsed / 1024 / 1024);
    }
    this._heapMb = heapMb;

    // Surge detection: if RSS grew faster than surgeThreshold per tick,
    // transition to pressure (even before reaching pressureMb).
    const delta = this._prevMb > 0 ? heapMb - this._prevMb : 0;
    this._prevMb = heapMb;

    // V8 heap/external spike detection: catch rapid heap growth before RSS catches up
    // String.split, large array ops can spike heapUsed 100MB+ in a single tick
    // Spike count: 1st → warning on stderr, 2nd consecutive → emergency
    let spikeMb = 0;
    if (usage) {
      const heapDelta = usage.heapUsed - (this._prevHeapUsed || usage.heapUsed);
      const extDelta = usage.external - (this._prevExternal || usage.external);
      spikeMb = Math.max(heapDelta, extDelta) / 1024 / 1024;
      this._prevHeapUsed = usage.heapUsed;
      this._prevExternal = usage.external;
    }

    // Use max(RSS, heapUsed) for state determination.
    // In preload mode, V8 heapUsed can spike far above RSS (e.g. String.split).
    // In spawn mode, heapUsedMb is 0, so RSS alone drives the state.
    const effectiveMb = heapUsedMb > heapMb ? heapUsedMb : heapMb;

    // Auto-tier promotion: 'auto' mode monitors state transitions and
    // escalates the monitor tier when sustained pressure is detected.
    // rss → split (attention+): enables SlicedString detach + pre-split GC
    // split → array (critical+): enables full Array proxy for push/unshift/splice
    if (this.monitorTier === 'auto') {
      if (this.state === 'attention' || this.state === 'pressure' ||
          this.state === 'critical' || this.state === 'emergency') {
        if (!this._tierInstalled) {
          // promote rss → split
          this.monitorTier = 'split';
          installMonitorTier(this);
          process.stderr.write(`\x1b[32;2m[nproxy] monitor auto: rss → split (${this.state})\x1b[0m\n`);
        } else if (this.state === 'critical' || this.state === 'emergency') {
          if (!this._arrayProxyInstalled) {
            // promote split → array
            this.monitorTier = 'array';
            installMonitorTier(this);
            process.stderr.write(`\x1b[32;2m[nproxy] monitor auto: split → array (${this.state})\x1b[0m\n`);
          }
        }
      }
    }

    let newState;
    if ((usage && spikeMb > 100) && this._spikeCount >= 1) {
      newState = 'emergency';
      this._spikeCount = 0;
      this._consecutiveSurges = 0;
    } else if (effectiveMb >= this.emergencyMb) {
      newState = 'emergency';
      this._spikeCount = 0;
      this._consecutiveSurges = 0;
    } else if (effectiveMb >= this.criticalMb) {
      newState = 'critical';
      this._spikeCount = 0;
      this._consecutiveSurges = 0;
    } else if (effectiveMb >= this.pressureMb) {
      newState = 'pressure';
      this._spikeCount = 0;
      this._consecutiveSurges = 0;
    } else if (effectiveMb >= this.attentionMb) {
      newState = 'attention';
      this._spikeCount = 0;
      this._consecutiveSurges = 0;
    } else if (delta >= this._surgeThreshold && (this.state === 'monitoring' || this.state === 'attention')) {
      this._consecutiveSurges++;
      newState = 'attention';
    } else if (delta >= this._surgeThreshold / 2 && (this.state === 'monitoring' || this.state === 'attention')) {
      this._consecutiveSurges++;
      newState = this._consecutiveSurges >= 2 ? 'attention' : 'monitoring';
    } else {
      newState = 'monitoring';
      this._consecutiveSurges = 0;
    }

    // Spike tracking: if spike detected but not yet emergency, warn and count
    if ((usage && spikeMb > 100) && newState !== 'emergency') {
      this._spikeCount++;
      if (this._spikeCount === 1) {
        const warnMsg = `\x1b[33m[nproxy] V8 heap spike: ${spikeMb.toFixed(0)}MB/tick — next spike triggers emergency\x1b[0m\n`;
        this._onTransition('spike', spikeMb);
        process.stderr.write(warnMsg);
      }
    } else if (!(usage && spikeMb > 100)) {
      this._spikeCount = 0;
    }

    if (newState !== this.state) {
      // Level 4: state transition detail
      debugLog(4, `state: ${this.state} → ${newState} (RSS: ${heapMb}MB, heapUsed: ${heapUsedMb}MB, effective: ${effectiveMb}MB, delta: ${delta}MB, spike: ${spikeMb.toFixed(0)}MB)`);
      this.state = newState;
      this._onTransition(newState, heapMb);
    }

    // Level 2: memory summary (every tick)
    if (DEBUG_LEVEL >= 2 && usage) {
      const ext = (usage.external / 1024 / 1024).toFixed(0);
      const ab = (usage.arrayBuffers / 1024 / 1024).toFixed(0);
      debugLog(2, `RSS:${heapMb}M heap:${heapUsedMb}/${(usage.heapTotal/1024/1024).toFixed(0)}M ext:${ext}M ab:${ab}M state:${this.state} Δ:${delta}M`);
    }
    // Level 3: RSS-heap divergence warning
    if (DEBUG_LEVEL >= 3 && usage && heapMb > 500 && heapMb > (usage.heapTotal / 1024 / 1024) * 2) {
      debugLog(3, `⚠ RSS>>heap divergence: RSS=${heapMb}M heapTotal=${(usage.heapTotal/1024/1024).toFixed(0)}M (possible native leak)`);
    }
    // Level 5: full dump including nheap_limit status
    if (DEBUG_LEVEL >= 5 && usage) {
      try {
        const nhl = require('./nheap_limit');
        debugLog(5, `nheap_limit: available=${nhl.available}, registered=${typeof nhl.register === 'function'}`);
      } catch (_) {}
    }

    // Emergency sustained check: if state remains emergency across ticks
    // and _onTransition is not called, force exit after threshold
    if (this.state === 'emergency' && newState === 'emergency') {
      this._emergencyTicks++;
      if (this._emergencyTicks > 25) {
        const mu = process.memoryUsage();
        process.stderr.write(`\x1b[31;1m[nproxy] EMERGENCY: sustained for ${this._emergencyTicks} ticks — exiting\x1b[0m\n`);
        process.stderr.write(`\x1b[31m  RSS: ${(mu.rss/1024/1024).toFixed(1)}MB  heap: ${(mu.heapUsed/1024/1024).toFixed(1)}/${(mu.heapTotal/1024/1024).toFixed(1)}MB  ext: ${(mu.external/1024/1024).toFixed(1)}MB  ab: ${(mu.arrayBuffers/1024/1024).toFixed(1)}MB\x1b[0m\n`);
        writeCrashDump('emergency_sustained', this.state, this._emergencyTicks);
        process.exit(1);
      }
    } else {
      this._emergencyTicks = 0;
    }

    this._timer = setTimeout(() => this._tick(), this.tickMs).unref();
  }
}

function installMonitorTier(mon) {
  if (mon._tierInstalled) return;
  const tier = mon.monitorTier;
  const TIER_ORDER = { rss: 0, auto: 0, split: 1, array: 2 };
  const currentLevel = TIER_ORDER[tier] ?? 0;

  // 'auto' delays installation until auto-promotion in _tick() decides the level
  if (tier === 'auto') return;

  if (currentLevel >= 1) {
    // split (same for 'split' and 'auto' after promotion)
    mon._tierInstalled = true;
    // Wrap String.prototype.split: mitigate BEFORE executing, detect AFTER
    const origSplit = String.prototype.split;
    String.prototype.split = function (...args) {
      // --- mitigation before split (does not modify split behavior) ---
      let gcTriggered = false;
      const stats = mon._v8h || (mon._v8h = require('v8').getHeapStatistics);
      const h = stats();
      const ratio = h.used_heap_size / h.heap_size_limit;
      if (ratio > 0.85) {
        if (typeof global.gc === 'function') {
          global.gc();
          gcTriggered = true;
        }
        const warnMsg = `\x1b[33m[nproxy] pre-split heap ${(ratio * 100).toFixed(0)}% — ${gcTriggered ? 'GC done' : 'GC unavailable'}\x1b[0m\n`;
        process.stderr.write(warnMsg);
        // Force state change so chunk size shrinks and backpressure engages
        if (ratio > 0.95 && mon.state !== 'emergency') {
          if (mon.state === 'critical') {
            mon.state = 'emergency';
            mon._onTransition('emergency', process.memoryUsage().rss / 1024 / 1024);
          } else if (mon.state !== 'critical') {
            mon.state = 'critical';
            mon._onTransition('critical', process.memoryUsage().rss / 1024 / 1024);
          }
        }
      }
      // --- original split ---
      const before = process.memoryUsage().heapUsed;
      const result = origSplit.apply(this, args);
      // Detach SlicedString references (V8 issue2869): each split element
      // retains reference to the parent string, preventing GC of the whole.
      // Concatenate with a space then slice it off to force a real copy.
      for (let i = 0; i < result.length; i++) {
        result[i] = (' ' + result[i]).slice(1);
      }
      const delta = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
      if (delta > 50 && mon.state !== 'emergency') {
        // split wrapper detects allocation delta but does NOT touch mon._spikeCount.
        // tick loop handles consecutive spike counting via heapUsed delta between ticks.
        // If tick already recorded a previous spike (mon._spikeCount>=1), escalate immediately.
        const warnMsg = `\x1b[33m[nproxy] split() allocated ${delta.toFixed(0)}MB in this call\x1b[0m\n`;
        process.stderr.write(warnMsg);
        if (mon._spikeCount >= 1) {
          const currentHeap = process.memoryUsage().rss / 1024 / 1024;
          mon.state = 'emergency';
          mon._onTransition('emergency', currentHeap);
          mon._spikeCount = 0;
        }
      }
      return result;
    };
  }

  if (currentLevel >= 2) {
    mon._arrayProxyInstalled = true;
    // Wrap Array.prototype methods to instrument memory-growing operations
    const heapWarnThreshold = 50;
    const methods = ['push', 'splice', 'unshift', 'concat'];
    for (const m of methods) {
      const orig = Array.prototype[m];
      Array.prototype[m] = function proxyArrayOp(...args) {
        const addedCount = m === 'splice'
          ? Math.max(0, args.length - 2)
          : args.length;
        if (addedCount > 50000) {
          const before = process.memoryUsage().heapUsed;
          const result = orig.apply(this, args);
          const delta = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
          if (delta > heapWarnThreshold) {
            process.stderr.write(`\x1b[33m[nproxy] Array.${m} +${addedCount} items = ${delta.toFixed(0)}MB\x1b[0m\n`);
          }
          return result;
        }
        return orig.apply(this, args);
      };
    }
  }
}

// ---- Intercept Mode (node -r nproxy.js) ----
function intercept() {
  // Skip if already running under nproxy (e.g. Node wrapper → spawnSync → Go binary)
  if (process.env.NPROXY_AUTO === '1') return;

  // Set process title for ps/OOM identification
  // Format: "<app> -via nproxy::<state>"
  // In CLI mode (require.main === module), runCLI() already set the correct app name.
  const appName = process.argv[1] ? require('path').basename(process.argv[1]) : 'unknown';
  const nproxyTitleBase = `${appName} -via nproxy`;
  let nproxyTitle = `${nproxyTitleBase}::monitoring`;
  if (require.main !== module) {
    process.title = nproxyTitle;
  }

  // Delayed stderr "active" indicator (safe for TUI apps)
  // Also re-set process.title here because the host app (e.g. openclaude)
  // may overwrite it during its own initialization.
  // In CLI mode (require.main === module), this is skipped to avoid TUI layout corruption.
  const dimGreen = '\x1b[32;2m', reset = '\x1b[0m';
  if (require.main !== module) {
    setTimeout(() => {
      process.title = nproxyTitle;
      const rssMb = (process.memoryUsage().rss / 1024 / 1024).toFixed(0);
      process.stderr.write(`${dimGreen}[nproxy]${reset} active (pid=${process.pid}, rss=${rssMb}MB)\n`);
    }, 5000).unref();
  }

  let textMode = process.env.NPROXY_TEXT || 'passthrough';
  let processText = createTextProcessor(textMode);
  process.env.NPROXY_PRESSURE_MB = process.env.NPROXY_PRESSURE_MB || String(DEFAULT_PRESSURE_MB);
  process.env.NPROXY_CRITICAL_MB = process.env.NPROXY_CRITICAL_MB || String(DEFAULT_CRITICAL_MB);

  // Startup banner: show Nproxy is active with a green badge
  const GREEN = '\x1b[32m';
  const DIM_GREEN = '\x1b[32;2m';
  const YELLOW = '\x1b[33m';
  const BLUE = '\x1b[34m';
  const BOLD = '\x1b[1m';
  const RESET = '\x1b[0m';
  let bannerShown = false;
  const BANNER_ANCHOR = '✦ Any model. Every tool. Zero limits. ✦';
  function injectBanner() {
    if (bannerShown) return '';
    bannerShown = true;
    const pressure = process.env.NPROXY_PRESSURE_MB || String(DEFAULT_PRESSURE_MB);
    const critical = process.env.NPROXY_CRITICAL_MB || String(DEFAULT_CRITICAL_MB);
    const attention = process.env.NPROXY_ATTENTION_MB || String(DEFAULT_ATTENTION_MB);
    const emergency = process.env.NPROXY_EMERGENCY_MB || String(DEFAULT_EMERGENCY_MB);
    const icon = `${BOLD}◈${RESET}${GREEN}`;
    const title = ` nproxy memory guard active`;
    const sub = `attn=${attention}  press=${pressure}  crit=${critical}  emg=${emergency}MB`;
    const boxW = 56;
    const pad1 = boxW - 1 - (icon.replace(/\x1b\[[\d;]*m/g, '') + title).length;
    const pad2 = boxW - 1 - sub.length;
    return `  ${DIM_GREEN}╔${'═'.repeat(boxW)}╗${RESET}\n` +
      `  ${DIM_GREEN}║ ${icon}${title}${' '.repeat(pad1)}${DIM_GREEN}║${RESET}\n` +
      `  ${DIM_GREEN}║ ${sub}${' '.repeat(pad2)}${DIM_GREEN}║${RESET}\n` +
      `  ${DIM_GREEN}╚${'═'.repeat(boxW)}╝${RESET}\n`;
  }
  // Fallback: if banner anchor is never seen, inject after 100ms
  // In CLI mode (require.main === module), banner is handled by runCLI() — skip here.
  let bannerTimer = null;
  if (require.main !== module) {
    bannerTimer = setTimeout(() => {
      const banner = injectBanner();
      if (banner) process.stderr.write(banner);
    }, 100).unref();
  }

  // Chunk size limit per write (0 = no limit)
  let maxChunkBytes = 0;
  const MAX_CHUNK_NORMAL = 262144;  // 256KB — always split
  const MAX_CHUNK_ATTENTION = 262144; // 256KB — start splitting
  const MAX_CHUNK_PRESSURE = 65536; // 64KB
  const MAX_CHUNK_CRITICAL = 4096;  // 4KB

  // Split a buffer/string into maxChunkBytes-sized pieces
  function splitChunk(data) {
    if (!maxChunkBytes || data.length <= maxChunkBytes) return [data];
    const parts = [];
    for (let i = 0; i < data.length; i += maxChunkBytes) {
      parts.push(data.slice(i, i + maxChunkBytes));
    }
    if (parts.length > 1) {
      debugLog(1, `chunk: ${data.length}B → ${parts.length}×${maxChunkBytes}B (state=${monitor.state})`);
    }
    return parts;
  }

  // Wrap stdout.write with asynchronous buffering for non-passthrough modes
  // Passthrough mode: synchronous to preserve Ink frame boundaries
  // Strip-ansi/transform mode: asynchronous buffering with sequence ordering
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout._origWrite = origStdoutWrite;

  // Asynchronous buffer for non-passthrough modes
  const stdoutBuffer = [];
  let stdoutSeq = 0;
  let isWritingStdout = false;

  // Jitter buffer: dynamic flush interval based on memory state
  let jitterBufferMs = 0;  // 0 = immediate flush (no jitter)
  let jitterTimer = null;

  function scheduleStdoutFlush() {
    if (isWritingStdout) return;
    isWritingStdout = true;

    // Jitter buffer: delay flush under memory pressure
    const flushFn = () => {
      while (stdoutBuffer.length > 0) {
        const item = stdoutBuffer.shift();
        origStdoutWrite(item.data, item.encoding, item.callback);
      }
      isWritingStdout = false;
    };

    if (jitterBufferMs > 0) {
      // Delay flush to absorb timing jitter
      jitterTimer = setTimeout(flushFn, jitterBufferMs);
      jitterTimer.unref();
    } else {
      // Immediate flush
      setImmediate(flushFn);
    }
  }

  process.stdout.write = function (chunk, encoding, callback) {
    if (traceEnabled) {
      const s = typeof chunk === 'string' ? chunk : chunk.toString();
      const escaped = s.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
      traceLog(`[nproxy-trace] STDOUT: ${JSON.stringify(escaped)}`);
    }
    if (!bannerShown && typeof chunk === 'string' && chunk.replace(/\x1b\[[\d;]*m/g, '').includes(BANNER_ANCHOR)) {
      clearTimeout(bannerTimer);
      const banner = injectBanner();
      if (banner) {
        const lastNewline = chunk.lastIndexOf('\n');
        if (lastNewline !== -1) {
          chunk = chunk.slice(0, lastNewline + 1) + banner;
        }
      }
    }
    if (typeof chunk === 'string' || chunk instanceof Buffer) {
      if (textMode === 'passthrough') {
        if (bypassCoalesce) {
          // Under memory pressure: write directly, no coalescing, split to maxChunkBytes
          const parts = splitChunk(chunk);
          for (let i = 0; i < parts.length; i++) {
            origStdoutWrite(parts[i], encoding, i === parts.length - 1 ? callback : undefined);
          }
          if (!callback) return true;
          return true;
        }
        // Passthrough: write synchronously to preserve Ink frame boundaries.
        // Ink outputs complete frames in a single write() call — deferring those
        // to setImmediate can interleave frame data and produce artifacts ("s e" chars).
        // Only split if the chunk exceeds maxChunkBytes.
        const s = typeof chunk === 'string' ? chunk : chunk.toString();
        if (maxChunkBytes > 0 && s.length > maxChunkBytes) {
          const parts = splitChunk(s);
          for (let i = 0; i < parts.length; i++) {
            origStdoutWrite(parts[i], encoding, i === parts.length - 1 ? callback : undefined);
          }
        } else {
          origStdoutWrite(chunk, encoding, callback);
        }
        return true;
      }
      // Transform/strip-ansi: asynchronous buffering with sequence ordering
      const processed = processText(chunk);
      stdoutBuffer.push({
        seq: stdoutSeq++,
        data: processed,
        encoding,
        callback,
      });
      scheduleStdoutFlush();
      return true;
    }
    return origStdoutWrite(chunk, encoding, callback);
  };

  // Wrap stderr.write with asynchronous buffering
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr._origWrite = origStderrWrite;

  // Asynchronous buffer for stderr
  const stderrBuffer = [];
  let stderrSeq = 0;
  let isWritingStderr = false;

  function scheduleStderrFlush() {
    if (isWritingStderr) return;
    isWritingStderr = true;
    setImmediate(() => {
      while (stderrBuffer.length > 0) {
        const item = stderrBuffer.shift();
        origStderrWrite(item.data, item.encoding, item.callback);
      }
      isWritingStderr = false;
    });
  }

  process.stderr.write = function (chunk, encoding, callback) {
    if (traceEnabled) {
      const s = typeof chunk === 'string' ? chunk : chunk.toString();
      const escaped = s.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
      traceLog(`[nproxy-trace] STDERR: ${JSON.stringify(escaped)}`);
    }
    if (typeof chunk === 'string' || chunk instanceof Buffer) {
      // Passthrough mode: write directly to preserve frame boundaries
      if (textMode === 'passthrough') {
        return origStderrWrite(chunk, encoding, callback);
      }
      const processed = processText(chunk);
      const parts = splitChunk(processed);
      for (let i = 0; i < parts.length; i++) {
        const cb = i === parts.length - 1 ? callback : undefined;
        stderrBuffer.push({
          seq: stderrSeq++,
          data: parts[i],
          encoding,
          callback: cb,
        });
      }
      scheduleStderrFlush();
      return true;
    }
    return origStderrWrite(chunk, encoding, callback);
  };

  // Memory monitor — on pressure, reduce chunk size to limit V8 Segmenter load
  const memLogSec = parseInt(process.env.NPROXY_MEMLOG || '0', 10);
  let memLogTimer = null;
  const memLogInterval = memLogSec > 0 ? memLogSec * 1000 : 0;

  // Coalescing state — bypass coalescing under pressure for direct write
  let bypassCoalesce = false;

  // Emergency retry counter (closure, safe across multiple emergency transitions)
  let emergencyRetries = 0;

  const monitor = new MemoryMonitor({
    monitorTier: DEFAULT_MONITOR,
    onTransition: (state, heapMb) => {
      // Jitter buffer: adjust based on memory state
      if (state === 'emergency' || state === 'critical') {
        jitterBufferMs = 0;  // Immediate flush (no delay)
      } else if (state === 'pressure') {
        jitterBufferMs = 10;  // 10ms jitter buffer
      } else if (state === 'attention') {
        jitterBufferMs = 5;   // 5ms jitter buffer
      } else {
        jitterBufferMs = 0;  // No jitter
      }

      if (state === 'emergency') {
        // Emergency: force GC (if --expose-gc), stop I/O, last-resort exit
        maxChunkBytes = MAX_CHUNK_CRITICAL;
        bypassCoalesce = true;
        nproxyTitle = `${nproxyTitleBase}::emergency`;
        if (require.main !== module) process.title = nproxyTitle;
        process.stderr.write(`\x1b[31;1m[nproxy] EMERGENCY: ${heapMb}MB — forcing recovery\x1b[0m\n`);
        if (typeof global.gc === 'function') {
          try { global.gc(); } catch (_) {}
          // Re-evaluate after GC
          const postGc = process.memoryUsage().rss / 1024 / 1024;
          if (postGc < heapMb) {
            process.stderr.write(`\x1b[32m[nproxy] GC freed ${(heapMb - postGc).toFixed(0)}MB, back to ${postGc.toFixed(0)}MB\x1b[0m\n`);
          }
        }
        // Emergency retry loop: 25 chances then self-terminate (25×200ms = 5s window)
        // Does NOT kill the child process (principle ②: signals relayed, not generated)
        emergencyRetries++;
        const rssNow = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
        process.stderr.write(`\x1b[31m[nproxy] EMERGENCY retry ${emergencyRetries}/25 — RSS: ${rssNow}MB\x1b[0m\n`);
        if (emergencyRetries > 25) {
          const mu = process.memoryUsage();
          process.stderr.write(`\x1b[31;1m[nproxy] EMERGENCY: no recovery after ${emergencyRetries} retries — exiting\x1b[0m\n`);
          process.stderr.write(`\x1b[31m  RSS: ${(mu.rss/1024/1024).toFixed(1)}MB  heap: ${(mu.heapUsed/1024/1024).toFixed(1)}/${(mu.heapTotal/1024/1024).toFixed(1)}MB  ext: ${(mu.external/1024/1024).toFixed(1)}MB  ab: ${(mu.arrayBuffers/1024/1024).toFixed(1)}MB\x1b[0m\n`);
          if (stdinController && stdinController.tempFile) {
            process.stderr.write(`\x1b[33m[nproxy] stdin offload file: ${stdinController.tempFile} (${stdinController.bytesWritten}B written, ${stdinController.bytesReplayed}B replayed)\x1b[0m\n`);
          }
          writeCrashDump('emergency_no_recovery', state, emergencyRetries);
          process.exit(1);
        }
      } else if (state === 'critical') {
        maxChunkBytes = MAX_CHUNK_CRITICAL;
        bypassCoalesce = true;
        nproxyTitle = `${nproxyTitleBase}::critical`;
        if (require.main !== module) process.title = nproxyTitle;
        process.stderr.write(`${BLUE}${BOLD}[nproxy]${RESET}${BLUE} memory critical: ${heapMb}MB — throttling I/O${RESET}\n`);
      } else if (state === 'pressure') {
        maxChunkBytes = MAX_CHUNK_PRESSURE;
        nproxyTitle = `${nproxyTitleBase}::pressure`;
        if (require.main !== module) process.title = nproxyTitle;
        if (textMode === 'passthrough') {
          textMode = 'strip-ansi';
          processText = createTextProcessor(textMode);
          process.stderr.write(`${YELLOW}[nproxy]${RESET} memory pressure: ${heapMb}MB — throttling I/O\n`);
        } else {
          process.stderr.write(`${YELLOW}[nproxy]${RESET} memory pressure: ${heapMb}MB — throttling I/O\n`);
        }
      } else if (state === 'attention') {
        // Attention: mild throttling, start chunk splitting
        maxChunkBytes = MAX_CHUNK_ATTENTION;
        nproxyTitle = `${nproxyTitleBase}::attention`;
        if (require.main !== module) process.title = nproxyTitle;
        process.stderr.write(`${DIM_GREEN}[nproxy]${RESET} memory attention: ${heapMb}MB — monitoring\n`);
      } else {
        maxChunkBytes = MAX_CHUNK_NORMAL;
        bypassCoalesce = false;
        nproxyTitle = `${nproxyTitleBase}::monitoring`;
        if (require.main !== module) process.title = nproxyTitle;
        if (textMode !== process.env.NPROXY_TEXT && textMode !== 'passthrough') {
          textMode = process.env.NPROXY_TEXT || 'passthrough';
          processText = createTextProcessor(textMode);
          process.stderr.write(`${GREEN}[nproxy]${RESET} memory recovered: ${heapMb}MB — I/O normal\n`);
        }
      }
    },
  });
  monitor.start();
  maxChunkBytes = MAX_CHUNK_NORMAL; // set initial chunk size
  installMonitorTier(monitor);

  // Stdin flow controller (preload mode only - in CLI mode, runCLI handles stdin relay)
  let stdinController = null;
  if (require.main !== module && process.stdin && process.stdin.readable) {
    stdinController = new StdinFlowController(monitor);
    stdinController.start();
    process.stderr.write(`${DIM_GREEN}[nproxy]${RESET} stdin flow control active\n`);
  }

  // NearHeapLimitCallback (optional C++ addon — fires BEFORE V8 OOM)
  // Re-entrant: if already in emergency, GC and check recovery before exiting
  let _nheapRetries = 0;
  try {
    const nheap = require('./nheap_limit');
    if (nheap.available) {
      nheap.register(() => {
        if (monitor.state !== 'emergency') {
          monitor.state = 'emergency';
          monitor._onTransition('emergency', process.memoryUsage().rss / 1024 / 1024);
        } else {
          // Already in emergency — GC and check recovery
          if (typeof global.gc === 'function') {
            try { global.gc(); } catch (_) {}
          }
          const postGc = process.memoryUsage().rss / 1024 / 1024;
          if (postGc < monitor.emergencyMb) {
            monitor.state = 'monitoring';
            monitor._emergencyTicks = 0;
            _nheapRetries = 0;
            process.stderr.write(`\x1b[32m[nproxy] nheap_limit: recovered to ${postGc.toFixed(0)}MB\x1b[0m\n`);
          } else {
            _nheapRetries++;
            process.stderr.write(`\x1b[31m[nproxy] nheap_limit: still emergency ${postGc.toFixed(0)}MB (${_nheapRetries}/25)\x1b[0m\n`);
            if (_nheapRetries > 25) {
              const mu = process.memoryUsage();
              process.stderr.write(`\x1b[31;1m[nproxy] nheap_limit: no recovery after ${_nheapRetries} retries — exiting\x1b[0m\n`);
              process.stderr.write(`\x1b[31m  RSS: ${(mu.rss/1024/1024).toFixed(1)}MB  heap: ${(mu.heapUsed/1024/1024).toFixed(1)}/${(mu.heapTotal/1024/1024).toFixed(1)}MB  ext: ${(mu.external/1024/1024).toFixed(1)}MB  ab: ${(mu.arrayBuffers/1024/1024).toFixed(1)}MB\x1b[0m\n`);
              if (stdinController && stdinController.tempFile) {
                process.stderr.write(`\x1b[33m[nproxy] stdin offload file: ${stdinController.tempFile} (${stdinController.bytesWritten}B written)\x1b[0m\n`);
              }
              writeCrashDump('nheap_limit_no_recovery', 'emergency', _nheapRetries);
              process.exit(1);
            }
          }
        }
      });
    }
  } catch (_) { /* addon not built — tick-only monitoring */ }

  // SIGINT pre-cleanup: free memory before host app's SIGINT handler runs
  // This prevents OOM during cleanup (especially spinner teardown)
  let _sigintCleanupDone = false;
  function _sigintPreCleanup() {
    if (_sigintCleanupDone) return; // 2nd+ pass-through
    _sigintCleanupDone = true;

    // Release memory headroom for host app's cleanup
    if (typeof global.gc === 'function') global.gc();
    stderrBuffer.splice(0, stderrBuffer.length);

    // Remove self, then re-fire so host app's handler runs
    process.removeListener('SIGINT', _sigintPreCleanup);
    process.kill(process.pid, 'SIGINT');
  }
  process.on('SIGINT', _sigintPreCleanup);

  // Warn if --expose-gc is not set (emergency GC in nheap_limit will be no-op)
  if (typeof global.gc !== 'function' && process.env.NPROXY_VERBOSE) {
    process.stderr.write(`${YELLOW}[nproxy]${RESET} --expose-gc not set. Emergency GC will be no-op. Add --expose-gc to node flags.\n`);
  }

  // Periodic memory log (NPROXY_MEMLOG=60 for every 60s)
  if (memLogInterval > 0) {
    function logMem() {
      const m = process.memoryUsage();
      const heapMb = (m.heapUsed / 1024 / 1024).toFixed(1);
      const rssMb = (m.rss / 1024 / 1024).toFixed(1);
      const extMb = (m.external / 1024 / 1024).toFixed(1);
      const stateColor = monitor.state === 'critical' ? BLUE : monitor.state === 'pressure' ? YELLOW : GREEN;
      process.stderr.write(`${stateColor}[nproxy]${RESET} mem RSS=${rssMb}MB heap=${heapMb}MB ext=${extMb}MB state=${stateColor}${monitor.state}${RESET}\n`);
      memLogTimer = setTimeout(logMem, memLogInterval).unref();
    }
    logMem();
  }

  // Crash diagnostics: log uncaught exceptions and unhandled rejections with timestamps
  if (!process.env._NPROXY_HOOKED) {
    process.env._NPROXY_HOOKED = '1';

    const logCrash = (type, err) => {
      const timestamp = new Date().toISOString();
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : '';
      const mem = process.memoryUsage();
      const v8 = require('v8');
      const heapStats = v8.getHeapStatistics();

      const report = [
        `\n\x1b[31;1m[nproxy] ${timestamp} ${type}: ${msg}\x1b[0m`,
        `  RSS: ${(mem.rss / 1024 / 1024).toFixed(1)}MB`,
        `  Heap: ${(mem.heapUsed / 1024 / 1024).toFixed(1)} / ${(mem.heapTotal / 1024 / 1024).toFixed(1)}MB (limit: ${(heapStats.heap_size_limit / 1024 / 1024).toFixed(1)}MB)`,
        `  External: ${(mem.external / 1024 / 1024).toFixed(1)}MB`,
        stack ? `  Stack:\n${stack}` : ''
      ].filter(Boolean).join('\n');

      // Use origStderrWrite directly — ensure crash report is visible even on exit
      try { origStderrWrite(report + '\n'); } catch (_) {}
    };

    process.on('uncaughtException', (err) => {
      logCrash('uncaughtException', err);
      try { writeCrashDump('uncaughtException', monitor ? monitor.state : 'unknown', 0, null, err); } catch (_) {}
      process.exit(1);
    });
    process.on('unhandledRejection', (reason) => {
      logCrash('unhandledRejection', reason);
      try { writeCrashDump('unhandledRejection', monitor ? monitor.state : 'unknown', 0, null, reason); } catch (_) {}
      process.exit(1);
    });
    process.on('exit', (code) => {
      // Cleanup stdin flow controller
      if (stdinController) {
        try { stdinController.stop(); } catch (_) {}
      }
      // Flush stderr buffer synchronously — setImmediate won't fire in exit handler
      try {
        while (stderrBuffer.length > 0) {
          const item = stderrBuffer.shift();
          origStderrWrite(item.data, item.encoding);
        }
      } catch (_) {}
      try {
        const mu = process.memoryUsage();
        const rss = (mu.rss / 1024 / 1024).toFixed(1);
        const heapUsed = (mu.heapUsed / 1024 / 1024).toFixed(1);
        const heapTotal = (mu.heapTotal / 1024 / 1024).toFixed(1);
        const external = (mu.external / 1024 / 1024).toFixed(1);
        const arrayBuffers = (mu.arrayBuffers / 1024 / 1024).toFixed(1);
        const state = monitor ? monitor.state : 'unknown';
        const divergence = (mu.rss / 1024 / 1024 - mu.heapTotal / 1024 / 1024).toFixed(0);
        origStderrWrite(`\x1b[31m[nproxy] process exit with code ${code}\x1b[0m\n`);
        origStderrWrite(`\x1b[31m  state: ${state}  retries: ${emergencyRetries}\x1b[0m\n`);
        origStderrWrite(`\x1b[31m  RSS: ${rss}MB  heap: ${heapUsed}/${heapTotal}MB  external: ${external}MB  arrayBuffers: ${arrayBuffers}MB\x1b[0m\n`);
        origStderrWrite(`\x1b[31m  RSS-heap divergence: ${divergence}MB\x1b[0m\n`);
        if (mu.rss / 1024 / 1024 > 500 && mu.rss / 1024 / 1024 > mu.heapTotal / 1024 / 1024 * 2) {
          origStderrWrite(`\x1b[33;1m  ⚠ RSS >> heap: possible native memory leak (nheap_limit, node-pty, Buffer)\x1b[0m\n`);
        }
      } catch (_) { /* stream may be closed */ }
      // Report stdin offload file if active
      if (stdinController && stdinController.tempFile) {
        try {
          origStderrWrite(`\x1b[33m[nproxy] stdin offload file: ${stdinController.tempFile} (${stdinController.bytesWritten}B written, ${stdinController.bytesReplayed}B replayed)\x1b[0m\n`);
        } catch (_) {}
      }
      // Dump file for abnormal exits (skip signal-based exits like Ctrl+C/SIGINT=130)
      // Also skip if child process caused the abnormal exit (child already wrote its own dump)
      if (code !== 0 && code !== 130 && !_childExitedAbnormally) {
        try { writeCrashDump(`exit_${code}`, monitor ? monitor.state : 'unknown', emergencyRetries, origStderrWrite); } catch (_) {}
      }
    });
    process.on('SIGPIPE', () => {
      try { origStderrWrite(`\x1b[33m[nproxy] SIGPIPE received — pipe closed\x1b[0m\n`); } catch (_) {}
    });
    process.on('SIGHUP', () => {
      try { origStderrWrite(`\x1b[33m[nproxy] SIGHUP received — terminal disconnected\x1b[0m\n`); } catch (_) {}
    });
    process.on('beforeExit', (code) => {
      // Cleanup stdin flow controller
      if (stdinController) {
        try { stdinController.stop(); } catch (_) {}
      }
      // Flush stderr buffer synchronously before event loop drains
      try {
        while (stderrBuffer.length > 0) {
          const item = stderrBuffer.shift();
          origStderrWrite(item.data, item.encoding);
        }
      } catch (_) {}
      try { origStderrWrite(`\x1b[33m[nproxy] beforeExit(${code}) — event loop drained\x1b[0m\n`); } catch (_) {}
    });

    // Check heap limit and warn on first attention tick; don't guess a timer delay
    const heapLimitMb = require('v8').getHeapStatistics().heap_size_limit / 1024 / 1024;
    if (heapLimitMb < 2048) {
      const warnLowHeap = () => {
        process.stderr.write(`\x1b[33m[nproxy] Warning: V8 heap limit is low (${heapLimitMb.toFixed(0)}MB). Consider --max-old-space-size=4096\x1b[0m\n`);
      };
      // Emit at the next available tick (immediate, not 5s later)
      setImmediate(warnLowHeap);
    }
  }
}

// ---- CLI Mode (spawn child) ----
function runCLI() {
  _childExitedAbnormally = false;
  const cli = parseArgs(process.argv.slice(2));
  if (cli.help || !cli.app) {
    const myself = process.argv[1];
    process.stderr.write(`nproxy — Runtime I/O Proxy

Usage:
  # Preload mode (intercept current process):
  NPROXY_TEXT=passthrough node -r ${myself} app.js

  # CLI mode (spawn child):
  node ${myself} [--text=mode] -- command [args...]

Modes:
  passthrough     pass through unmodified (default)
  strip-ansi      remove ANSI escape sequences
  transform       strip ANSI + normalize unicode

Preload mode env vars:
  NPROXY_TEXT     text processing mode (default: passthrough)
  NPROXY_DEBUG    debug verbosity level (1-5)
                  1: chunk split, 2: memory summary, 3: divergence warn,
                  4: state transitions, 5: full dump + nheap_limit stats
`);
    process.exit(1);
  }

  const { spawn } = require('child_process');
  const textMode = cli.text || process.env.NPROXY_TEXT || 'passthrough';
  const processText = createTextProcessor(textMode);
  const processInput = createInputProcessor(textMode);

  const usePty = cli.pty || process.env.NPROXY_PTY === '1';

  // Set process title to show the proxied app name (overrides intercept() fallback)
  const proxyAppName = cli.app ? require('path').basename(cli.app) : 'unknown';
  process.title = `${proxyAppName} -via nproxy::monitoring`;

  // Banner injection (shared by stderr startup + stdout anchor modes)
  let cliBannerShown = false;
  function injectCliBanner() {
    if (cliBannerShown) return '';
    cliBannerShown = true;
    const press = process.env.NPROXY_PRESSURE_MB || String(DEFAULT_PRESSURE_MB);
    const crit = process.env.NPROXY_CRITICAL_MB || String(DEFAULT_CRITICAL_MB);
    const attn = process.env.NPROXY_ATTENTION_MB || String(DEFAULT_ATTENTION_MB);
    const emg = process.env.NPROXY_EMERGENCY_MB || String(DEFAULT_EMERGENCY_MB);
    const dimGreen = '\x1b[32;2m', reset = '\x1b[0m', bold = '\x1b[1m', green = '\x1b[32m';
    const icon = `${bold}◈${reset}${green}`;
    const title = ` nproxy memory guard active`;
    const sub = `attn=${attn}  press=${press}  crit=${crit}  emg=${emg}MB`;
    const boxW = 56;
    const pad1 = boxW - 1 - '◈ nproxy memory guard active'.length;
    const pad2 = boxW - 1 - sub.length;
    return `  ${dimGreen}╔${'═'.repeat(boxW)}╗${reset}\n` +
      `  ${dimGreen}║ ${icon}${title}${' '.repeat(pad1)}${dimGreen}║${reset}\n` +
      `  ${dimGreen}║ ${sub}${' '.repeat(pad2)}${dimGreen}║${reset}\n` +
      `  ${dimGreen}╚${'═'.repeat(boxW)}╝${reset}\n`;
  }

  // Show banner on stderr at startup
  const banner = injectCliBanner();
  if (banner) process.stderr.write(banner);

  /** Configurable anchor string for stdout injection */
  const bannerAnchor = process.env.NPROXY_BANNER_ANCHOR || '';

  let child;
  if (usePty) {
    // ---- PTY mode: use node-pty for TTY emulation ----
    // NOTE: --pty requires the "node-pty" package (native addon, requires build tools).
    // Install: npm install -g node-pty
    // Windows: prefer WSL2 or use the Rust binary (Nproxy.rs) instead.
    let pty;
    try { pty = require('node-pty'); } catch (e) {
      process.stderr.write('[nproxy] --pty mode requires node-pty.\n');
      process.stderr.write('[nproxy] Install: npm install -g node-pty\n');
      process.stderr.write('[nproxy] Windows: use WSL2 or the Rust binary (Nproxy.rs) instead.\n');
      process.exit(1);
    }
    const env = { ...process.env, TERM: process.env.TERM || 'xterm-256color' };
    child = pty.spawn(cli.app, cli.appArgs, {
      name: env.TERM,
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
      cwd: process.cwd(),
      env,
    });
    // PTY output: write directly to original stdout, bypass nproxy's write hook
    // to avoid double-processing (processText + write hook)
    const origStdout = process.stdout._origWrite || process.stdout.write;
    child.onData((data) => {
      origStdout.call(process.stdout, data);
    });
    child.onExit(({ exitCode, signal }) => {
      // Cleanup terminal state set by child process (mouse tracking, alternate screen)
      try {
        origStdout.call(process.stdout, '\x1b[?1000l');  // X10 mouse
        origStdout.call(process.stdout, '\x1b[?1002l');  // button events
        origStdout.call(process.stdout, '\x1b[?1003l');  // all motion
        origStdout.call(process.stdout, '\x1b[?1006l');  // SGR mouse mode
        origStdout.call(process.stdout, '\x1b[?1049l');  // alternate screen
      } catch (_) {}
      if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false);
      if (signal) {
        // Exit with signal code directly — avoid re-signaling which can hang
        const sigNum = signal === 'SIGKILL' ? 9 : signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 1;
        process.exit(128 + sigNum);
      }
      else process.exit(exitCode);
    });
    // PTY stdin: enable raw mode for interactive key input (arrows, tabs, ctrl+keys)
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    // PTY stdin relay: forward parent stdin -> child
    process.stdin.on('data', (data) => { child.write(data); });
    // PTY resize
    process.on('SIGWINCH', () => {
      if (process.stdout.columns && process.stdout.rows) {
        child.resize(process.stdout.columns, process.stdout.rows);
      }
    });
    // PTY crash guard: ensure terminal state is restored on unexpected exit
    process.on('exit', () => {
      try {
        const out = process.stdout._origWrite || process.stdout.write;
        out.call(process.stdout, '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1049l');
        if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false);
      } catch (_) {}
    });
  } else {
    // ---- Pipe mode: child_process.spawn ----
    // Spawn via node -r nproxy.js for scripts that contain "node" in their
    // shebang (e.g. /usr/bin/openclaude) as well as .js/.mjs/.cjs files.
    // This ensures preload intercept works for any Node-based executable.
    // Non-Node binaries (ELF, Windows PE) are spawned directly.
    const isScript = /\.(js|mjs|cjs)$/i.test(cli.app) || (() => {
      let fd;
      try {
        const fs = require('fs');
        const buf = Buffer.alloc(128);
        fd = fs.openSync(cli.app, 'r');
        fs.readSync(fd, buf, 0, 128, 0);
        return buf.includes('node');
      } catch { return false; }
      finally { if (fd !== undefined) { const fs = require('fs'); fs.closeSync(fd); } }
    })();
    if (isScript) {
      child = spawn(process.execPath, ['-r', __filename, cli.app, ...cli.appArgs], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NPROXY_AUTO: '1', NPROXY_TEXT: textMode },
      });
    } else {
      child = spawn(cli.app, cli.appArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
    }

    // Adjust OOM score for child process (Linux only)
    if (process.platform === 'linux' && child.pid) {
      const fs = require('fs');
      const oomScoreAdj = parseInt(process.env.NPROXY_OOM_SCORE_ADJ || '-500', 10);
      let oomScoreSet = false;
      try {
        // Set OOM score adjustment to -500 (less likely to be killed)
        // Range: -1000 (never kill) to 1000 (always kill)
        fs.writeFileSync(`/proc/${child.pid}/oom_score_adj`, String(oomScoreAdj));
        process.stderr.write(`[nproxy] child OOM score adjusted to ${oomScoreAdj}\n`);
        oomScoreSet = true;
      } catch (e) {
        process.stderr.write(`[nproxy] warning: could not adjust OOM score: ${e.message}\n`);
      }

      // cgroup v2 fallback: set memory.high if oom_score_adj failed
      if (!oomScoreSet && fs.existsSync('/sys/fs/cgroup/cgroup.controllers')) {
        try {
          const cgroupPath = fs.readFileSync(`/proc/${child.pid}/cgroup`, 'utf8')
            .split('\n')
            .find(l => l.startsWith('0::'))
            ?.slice(3)?.trim();
          if (cgroupPath) {
            const memHighPath = `/sys/fs/cgroup/${cgroupPath}/memory.high`;
            if (fs.existsSync(memHighPath)) {
              // Set memory.high to current RSS + 256MB headroom
              const currentHigh = fs.readFileSync(memHighPath, 'utf8').trim();
              if (currentHigh === 'max' || currentHigh === '') {
                // Only set if not already constrained
                const rssBytes = (DEFAULT_EMERGENCY_MB + 256) * 1024 * 1024;
                fs.writeFileSync(memHighPath, String(rssBytes));
                process.stderr.write(`[nproxy] cgroup v2 memory.high set to ${Math.round(rssBytes / 1024 / 1024)}MB\n`);
              }
            }
          }
        } catch (e) {
          process.stderr.write(`[nproxy] warning: cgroup v2 fallback failed: ${e.message}\n`);
        }
      }
    }

    // Stdin relay: forward parent stdin -> child stdin
    // This ensures nproxy intercepts all IO (not just stdout/stderr)
    // Enable raw mode for interactive input (character-by-character, not line-buffered)
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.on('data', (chunk) => {
      const processed = processInput(chunk);
      if (processed.length > 0) {
        child.stdin.write(processed);
      }
    });
    process.stdin.on('end', () => {
      child.stdin.end();
    });

    // Stdout relay with select-style readable monitoring
    // Memory monitor state: monitoring | attention | pressure | critical | emergency
    let childMonState = 'monitoring';

    // Select-style readable monitoring for stdout
    child.stdout.on('readable', () => {
      let chunk;
      while ((chunk = child.stdout.read()) !== null) {
        let processed = processText(chunk);
        if (processed.length === 0) continue;
        // Banner injection: if anchor is set and not yet shown, search for it in the output
        if (bannerAnchor && !cliBannerShown && typeof processed === 'string') {
          const clean = processed.replace(/\x1b\[[\d;]*m/g, '');
          if (clean.includes(bannerAnchor)) {
            const banner = injectCliBanner();
            if (banner) {
              const lastNewline = processed.lastIndexOf('\n');
              if (lastNewline !== -1) {
                processed = processed.slice(0, lastNewline + 1) + banner;
              }
            }
          }
        }
        // Under memory pressure: apply backpressure
        if (childMonState === 'emergency' || childMonState === 'critical') {
          const ok = process.stdout.write(processed);
          if (!ok) {
            // Wait for drain before continuing
            process.stdout.once('drain', () => {
              // Resume reading after drain
            });
            break;
          }
          continue;
        }
        if (childMonState === 'pressure') {
          const ok = process.stdout.write(processed);
          if (!ok) {
            process.stdout.once('drain', () => {});
            break;
          }
          continue;
        }
        const ok = process.stdout.write(processed);
        if (!ok) {
          // Backpressure: stop reading until drain
          process.stdout.once('drain', () => {
            // Resume reading after drain
            child.stdout.read(0);  // Trigger readable event
          });
          break;
        }
      }
    });

    // Select-style readable monitoring for stderr
    child.stderr.on('readable', () => {
      let chunk;
      while ((chunk = child.stderr.read()) !== null) {
        const processed = processText(chunk);
        if (processed.length === 0) continue;
        if (childMonState === 'emergency' || childMonState === 'critical') {
          const ok = process.stderr.write(processed);
          if (!ok) {
            process.stderr.once('drain', () => {});
            break;
          }
          continue;
        }
        if (childMonState === 'pressure') {
          const ok = process.stderr.write(processed);
          if (!ok) {
            process.stderr.once('drain', () => {});
            break;
          }
          continue;
        }
        const ok = process.stderr.write(processed);
        if (!ok) {
          process.stderr.once('drain', () => {
            child.stderr.read(0);
          });
          break;
        }
      }
    });

    // Memory monitor: track child RSS via /proc/{pid}/status
    let childMonStatePrev = null;
    const childMon = new MemoryMonitor({
      childPid: child.pid,
      attentionMb: DEFAULT_ATTENTION_MB,
      pressureMb: DEFAULT_PRESSURE_MB,
      criticalMb: DEFAULT_CRITICAL_MB,
      emergencyMb: DEFAULT_EMERGENCY_MB,
      onTransition: (state, heapMb) => {
        childMonState = state;
        // emergency状態から復帰する際のstdin処理
        if (childMonStatePrev === 'emergency' && 
            ['monitoring', 'attention', 'pressure'].includes(state) && 
            child.stdin) {
          if (child.stdin.isPaused) {
            child.stdin.resume();
            process.stderr.write('[nproxy] stdin resumed after emergency state\n');
          }
        }
        childMonStatePrev = state;
        if (process.env.NPROXY_MEMLOG) {
          process.stderr.write(`[nproxy] childRSS=${childMon.rssMb}MB heap=${heapMb}MB state=${state}\n`);
        }
      },
    });
    childMon.start();

    // CPU watchdog: monitor CPU usage using /proc/[pid]/stat (independent of event loop)
    let childCpuWarningTicks = 0;
    let childCpuEmergencyTicks = 0;
    let cpuWatchdogTimer = setInterval(() => {
      try {
        // Check child process CPU usage
        const childCpuUsage = getProcessCpuUsage(child.pid);
        
        // Update warning/error tick counters
        if (childCpuUsage >= CPU_EMERGENCY_THRESHOLD) {
          childCpuEmergencyTicks++;
          childCpuWarningTicks = 0; // Reset warning counter when in emergency
          
          // Emergency state: 6 consecutive ticks (60 seconds) at 95%+ CPU
          if (childCpuEmergencyTicks >= CPU_EMERGENCY_DURATION_TICKS) {
            process.stderr.write(`[nproxy] CPU EMERGENCY: child process ${child.pid} at ${childCpuUsage.toFixed(1)}% for ${childCpuEmergencyTicks * (CPU_WATCHDOG_INTERVAL_MS / 1000)}s — initiating shutdown\n`);
            
            // Send SIGTERM to child process, then exit immediately.
            // Child process is orphaned on exit; OS will handle cleanup.
            // We do not wait (setTimeout) because the event loop may be blocked.
            try {
              process.kill(child.pid, 'SIGTERM');
              process.stderr.write(`[nproxy] sent SIGTERM to child process ${child.pid}\n`);
            } catch (err) {
              process.stderr.write(`[nproxy] warning: failed to send SIGTERM to child ${child.pid}: ${err.message}\n`);
            }
            process.exit(1);
          }
        } else if (childCpuUsage >= CPU_WARNING_THRESHOLD) {
          childCpuWarningTicks++;
          childCpuEmergencyTicks = 0; // Reset emergency counter when in warning range
          
          // Warning state: 3 consecutive ticks (30 seconds) at 80%+ CPU
          if (childCpuWarningTicks >= CPU_WARNING_DURATION_TICKS) {
            process.stderr.write(`[nproxy] CPU WARNING: child process ${child.pid} at ${childCpuUsage.toFixed(1)}% for ${childCpuWarningTicks * (CPU_WATCHDOG_INTERVAL_MS / 1000)}s\n`);
          }
        } else {
          // Reset counters when CPU usage is normal
          childCpuWarningTicks = 0;
          childCpuEmergencyTicks = 0;
        }
      } catch (err) {
        // Ignore errors (process may have exited)
        childCpuWarningTicks = 0;
        childCpuEmergencyTicks = 0;
      }
    }, CPU_WATCHDOG_INTERVAL_MS);
    cpuWatchdogTimer.unref(); // Allow process to exit even if timer is active

    // Signal relay (pipe mode) — guard for Windows where some signals are undefined
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGUSR1', 'SIGUSR2', 'SIGWINCH'];
    for (const sig of signals) {
      try { process.on(sig, () => { child.kill(sig); }); } catch (e) {
        // skip signals not available on this platform (e.g. SIGWINCH on Windows)
      }
    }

    child.on('exit', (code, sig) => {
      if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false);
      const exitInfo = sig ? `signal ${sig}` : `code ${code}`;
      if (code !== 0 || sig) {
        _childExitedAbnormally = true;
        process.stderr.write(`\x1b[31;1m[nproxy] child process ${child.pid} exited abnormally: ${exitInfo}\x1b[0m\n`);
        process.stderr.write(`\x1b[33m[nproxy] check child crash dump: nproxy_crash_*.json / nproxy_emergency_*.json in ${process.cwd()}\x1b[0m\n`);
      }
      if (sig) process.kill(process.pid, sig);
      else process.exit(code);
    });
  } // end pipe mode

  // Show child process info on stderr after spawn
  if (child && child.pid) {
    const appName = cli.app ? require('path').basename(cli.app) : 'unknown';
    process.stderr.write(`  \x1b[32;2m[nproxy]\x1b[0m child pid=${child.pid} app=${appName}\n`);
  }
} // end runCLI

// ---- Entry ----
if (require.main === module) {
  runCLI();
}
// When loaded via -r (preload), auto-intercept.
// NPROXY_AUTO=1 is set by CLI mode spawn to prevent recursive intercept.
intercept();

module.exports = {
  intercept, MemoryMonitor, createTextProcessor, installMonitorTier,
  // Exported for unit testing
  parseArgs,
  createInputProcessor,
  writeCrashDump,
  getProcessCpuUsage,
  _crashDumpTracker,
  RATE_LIMIT,
  splitChunk: (data, maxBytes) => {
    if (!maxBytes || data.length <= maxBytes) return [data];
    const parts = [];
    for (let i = 0; i < data.length; i += maxBytes) {
      parts.push(data.slice(i, i + maxBytes));
    }
    return parts;
  },
};
