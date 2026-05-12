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

// ---- Default thresholds (env only, never hardcode magic numbers) ----
const DFS_ATTENTION_MB = 256;
const DFS_PRESSURE_MB = 512;
const DFS_CRITICAL_MB = 1024;
const DFS_EMERGENCY_MB = 1280;
const DEFAULT_ATTENTION_MB = parseInt(process.env.NPROXY_ATTENTION_MB || String(DFS_ATTENTION_MB), 10);
const DEFAULT_PRESSURE_MB = parseInt(process.env.NPROXY_PRESSURE_MB || String(DFS_PRESSURE_MB), 10);
const DEFAULT_CRITICAL_MB = parseInt(process.env.NPROXY_CRITICAL_MB || String(DFS_CRITICAL_MB), 10);
const DEFAULT_EMERGENCY_MB = parseInt(process.env.NPROXY_EMERGENCY_MB || String(DFS_EMERGENCY_MB), 10);
const DEFAULT_TICK_MS = parseInt(process.env.NPROXY_TICK_MS || '200', 10);
const DEFAULT_MONITOR = process.env.NPROXY_MONITOR || 'rss'; // rss | split | array

// ---- CLI arg parsing ----
function parseArgs(argv) {
  const out = { text: null, textLog: null, pty: false, app: null, appArgs: [] };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--text' && argv[i + 1]) { out.text = argv[++i]; continue; }
    if (a.startsWith('--text=')) { out.text = a.slice(7); continue; }
    if (a === '--text-log' && argv[i + 1]) { out.textLog = argv[++i]; continue; }
    if (a.startsWith('--text-log=')) { out.textLog = a.slice(11); continue; }
    if (a === '--pty') { out.pty = true; continue; }
    if (a === '--no-pty') { out.pty = false; continue; }
    out.app = a;
    out.appArgs = argv.slice(i + 1);
    break;
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
      this.state = newState;
      this._onTransition(newState, heapMb);
    }

    this._timer = setTimeout(() => this._tick(), this.tickMs).unref();
  }
}

function installMonitorTier(mon) {
  if (mon._tierInstalled) return;
  const tier = mon.monitorTier;
  if (tier === 'rss') {
    mon._tierInstalled = true;
    return;
  }

  if (tier === 'split' || tier === 'array') {
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
      // --- original split (unchanged) ---
      const before = process.memoryUsage().heapUsed;
      const result = origSplit.apply(this, args);
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

  if (tier === 'array') {
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
    const pressure = process.env.NPROXY_PRESSURE_MB || '512';
    const critical = process.env.NPROXY_CRITICAL_MB || '1024';
    const attention = process.env.NPROXY_ATTENTION_MB || '256';
    const emergency = process.env.NPROXY_EMERGENCY_MB || '1280';
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
  // Fallback: if banner anchor is never seen, inject after 3s
  const bannerTimer = setTimeout(() => {
    const banner = injectBanner();
    if (banner) process.stderr.write(banner);
  }, 3000);

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
    if (parts.length > 1 && process.env.NPROXY_DEBUG) {
      process.stderr.write(`[nproxy] chunk: ${data.length}B → ${parts.length}×${maxChunkBytes}B (state=${monitor.state})\n`);
    }
    return parts;
  }

  // Wrap stdout.write: for passthrough mode, pass through directly to preserve Ink frame boundaries.
  // For strip-ansi/transform, apply text processing inline and write immediately in the same tick.
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout._origWrite = origStdoutWrite;
  process.stdout.write = function (chunk, encoding, callback) {
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
      // Transform/strip-ansi: apply text processing, write immediately (same tick) to
      // preserve Ink frame boundaries. No coalescing.
      const processed = processText(chunk);
      const wrote = origStdoutWrite(processed, encoding, callback);
      return wrote;
    }
    return origStdoutWrite(chunk, encoding, callback);
  };

  // Wrap stderr.write with chunk splitting
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr._origWrite = origStderrWrite;
  process.stderr.write = function (chunk, encoding, callback) {
    if (typeof chunk === 'string' || chunk instanceof Buffer) {
      const processed = processText(chunk);
      const parts = splitChunk(processed);
      for (let i = 0; i < parts.length; i++) {
        const cb = i === parts.length - 1 ? callback : undefined;
        origStderrWrite(parts[i], encoding, cb);
      }
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
      if (state === 'emergency') {
        // Emergency: force GC (if --expose-gc), stop I/O, last-resort exit
        maxChunkBytes = MAX_CHUNK_CRITICAL;
        bypassCoalesce = true;
        process.stderr.write(`\x1b[31;1m[nproxy] EMERGENCY: ${heapMb}MB — forcing recovery\x1b[0m\n`);
        if (typeof global.gc === 'function') {
          try { global.gc(); } catch (_) {}
          // Re-evaluate after GC
          const postGc = process.memoryUsage().rss / 1024 / 1024;
          if (postGc < heapMb) {
            process.stderr.write(`\x1b[32m[nproxy] GC freed ${(heapMb - postGc).toFixed(0)}MB, back to ${postGc.toFixed(0)}MB\x1b[0m\n`);
          }
        }
        // Emergency retry loop: 3 chances then self-terminate
        // Does NOT kill the child process (principle ②: signals relayed, not generated)
        emergencyRetries++;
        if (emergencyRetries > 3) {
          process.stderr.write(`\x1b[31;1m[nproxy] EMERGENCY: no recovery after 3 retries — exiting\x1b[0m\n`);
          process.exit(1);
        }
      } else if (state === 'critical') {
        maxChunkBytes = MAX_CHUNK_CRITICAL;
        bypassCoalesce = true;
        process.stderr.write(`${BLUE}${BOLD}[nproxy]${RESET}${BLUE} memory critical: ${heapMb}MB — throttling I/O${RESET}\n`);
      } else if (state === 'pressure') {
        maxChunkBytes = MAX_CHUNK_PRESSURE;
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
        process.stderr.write(`${DIM_GREEN}[nproxy]${RESET} memory attention: ${heapMb}MB — monitoring\n`);
      } else {
        maxChunkBytes = MAX_CHUNK_NORMAL;
        bypassCoalesce = false;
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

  // NearHeapLimitCallback (optional C++ addon — fires BEFORE V8 OOM)
  try {
    const nheap = require('./nheap_limit');
    if (nheap.available) {
      nheap.register(() => {
        if (monitor.state !== 'emergency') {
          monitor.state = 'emergency';
          monitor._onTransition('emergency', process.memoryUsage().rss / 1024 / 1024);
        }
      });
    }
  } catch (_) { /* addon not built — tick-only monitoring */ }

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
}

// ---- CLI Mode (spawn child) ----
function runCLI() {
  const cli = parseArgs(process.argv.slice(2));
  if (!cli.app) {
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
`);
    process.exit(1);
  }

  const { spawn } = require('child_process');
  const textMode = cli.text || process.env.NPROXY_TEXT || 'passthrough';
  const processText = createTextProcessor(textMode);

  const usePty = cli.pty || process.env.NPROXY_PTY === '1';

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
    child.onData((data) => {
      const processed = processText(data);
      if (processed.length > 0) process.stdout.write(processed);
    });
    child.onExit(({ exitCode, signal }) => {
      if (signal) {
        if (signal === 'SIGKILL') process.exit(128 + 9);
        else process.kill(process.pid, signal);
      }
      else process.exit(exitCode);
    });
    // PTY stdin relay: forward parent stdin -> child
    if (!process.stdin.isTTY) {
      // Pipe mode: relay raw bytes
      process.stdin.on('data', (data) => { child.write(data); });
    } else {
      // TTY mode: relay raw bytes (node-pty handles encoding)
      process.stdin.on('data', (data) => { child.write(data); });
    }
    // PTY resize
    process.on('SIGWINCH', () => {
      if (process.stdout.columns && process.stdout.rows) {
        child.resize(process.stdout.columns, process.stdout.rows);
      }
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
      finally { if (fd !== undefined) fs.closeSync(fd); }
    })();
    if (isScript) {
      child = spawn(process.execPath, ['-r', __filename, cli.app, ...cli.appArgs], {
        stdio: ['inherit', 'pipe', 'pipe'],
        env: { ...process.env, NPROXY_AUTO: '1', NPROXY_TEXT: textMode },
      });
    } else {
      child = spawn(cli.app, cli.appArgs, {
        stdio: ['inherit', 'pipe', 'pipe'],
        env: process.env,
      });
    }

    // Stdout relay with backpressure handling
    // Memory monitor state: monitoring | attention | pressure | critical | emergency
    let childMonState = 'monitoring';

    child.stdout.pause();
    child.stdout.on('data', (chunk) => {
      const processed = processText(chunk);
      if (processed.length === 0) return;
      // Under memory pressure: pause child stdout to apply backpressure
      if (childMonState === 'emergency' || childMonState === 'critical') {
        child.stdout.pause();
        const doResume = () => { child.stdout.resume(); };
        const ok = process.stdout.write(processed, doResume);
        if (ok) setImmediate(doResume);
        return;
      }
      if (childMonState === 'pressure') {
        child.stdout.pause();
        const ok = process.stdout.write(processed, () => { child.stdout.resume(); });
        if (ok) setImmediate(() => { child.stdout.resume(); });
        return;
      }
      const ok = process.stdout.write(processed);
      if (!ok) {
        child.stdout.pause();
        process.stdout.once('drain', () => { child.stdout.resume(); });
      }
    });
    child.stdout.resume();

    // Stderr relay with backpressure handling
    child.stderr.pause();
    child.stderr.on('data', (chunk) => {
      const processed = processText(chunk);
      if (processed.length === 0) return;
      if (childMonState === 'emergency' || childMonState === 'critical') {
        child.stderr.pause();
        const doResume = () => { child.stderr.resume(); };
        const ok = process.stderr.write(processed, doResume);
        if (ok) setImmediate(doResume);
        return;
      }
      if (childMonState === 'pressure') {
        child.stderr.pause();
        const ok = process.stderr.write(processed, () => { child.stderr.resume(); });
        if (ok) setImmediate(() => { child.stderr.resume(); });
        return;
      }
      const ok = process.stderr.write(processed);
      if (!ok) {
        child.stderr.pause();
        process.stderr.once('drain', () => { child.stderr.resume(); });
      }
    });
    child.stderr.resume();

    // Memory monitor: track child RSS via /proc/{pid}/status
    const childMon = new MemoryMonitor({
      childPid: child.pid,
      attentionMb: DEFAULT_ATTENTION_MB,
      pressureMb: DEFAULT_PRESSURE_MB,
      criticalMb: DEFAULT_CRITICAL_MB,
      emergencyMb: DEFAULT_EMERGENCY_MB,
      onTransition: (state, heapMb) => {
        childMonState = state;
        if (process.env.NPROXY_MEMLOG) {
          process.stderr.write(`[nproxy] childRSS=${childMon.rssMb}MB heap=${heapMb}MB state=${state}\n`);
        }
      },
    });
    childMon.start();

    // Signal relay (pipe mode) — guard for Windows where some signals are undefined
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGUSR1', 'SIGUSR2', 'SIGWINCH'];
    for (const sig of signals) {
      try { process.on(sig, () => { child.kill(sig); }); } catch (e) {
        // skip signals not available on this platform (e.g. SIGWINCH on Windows)
      }
    }

    child.on('exit', (code, sig) => {
      if (sig) process.kill(process.pid, sig);
      else process.exit(code);
    });
  } // end pipe mode
} // end runCLI

// ---- Entry ----
if (require.main === module) {
  runCLI();
}
// When loaded via -r (preload), auto-intercept.
// NPROXY_AUTO=1 is set by CLI mode spawn.
intercept();

module.exports = { intercept, MemoryMonitor, createTextProcessor, installMonitorTier };
