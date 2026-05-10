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
    this.pressureMb = opts.pressureMb || parseInt(process.env.NPROXY_PRESSURE_MB || '512', 10);
    this.criticalMb = opts.criticalMb || parseInt(process.env.NPROXY_CRITICAL_MB || '1024', 10);
    this.tickMs = opts.tickMs || 500;
    this.state = 'normal'; // 'normal' | 'pressure' | 'critical'
    this._timer = null;
    this._onTransition = opts.onTransition || (() => {});
  }

  start() {
    this._tick();
    return this;
  }

  stop() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    return this;
  }

  _tick() {
    const usage = process.memoryUsage();
    const heapMb = Math.round(usage.heapUsed / 1024 / 1024);

    let newState;
    if (heapMb >= this.criticalMb) newState = 'critical';
    else if (heapMb >= this.pressureMb) newState = 'pressure';
    else newState = 'normal';

    if (newState !== this.state) {
      this.state = newState;
      this._onTransition(newState, heapMb);
    }

    this._timer = setTimeout(() => this._tick(), this.tickMs).unref();
  }
}

// ---- Intercept Mode (node -r nproxy.js) ----
function intercept() {
  let textMode = process.env.NPROXY_TEXT || 'passthrough';
  let processText = createTextProcessor(textMode);
  process.env.NPROXY_PRESSURE_MB = process.env.NPROXY_PRESSURE_MB || '512';
  process.env.NPROXY_CRITICAL_MB = process.env.NPROXY_CRITICAL_MB || '1024';

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
    const pressure = process.env.NPROXY_PRESSURE_MB;
    const critical = process.env.NPROXY_CRITICAL_MB;
    const icon = `${BOLD}◈${RESET}${GREEN}`;
    const title = ` nproxy memory guard active`;
    const sub = `pressure=${pressure}MB  critical=${critical}MB`;
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
  const MAX_CHUNK_NORMAL = 0;       // no limit
  const MAX_CHUNK_PRESSURE = 65536; // 64KB
  const MAX_CHUNK_CRITICAL = 4096;  // 4KB

  // Frame coalescing: buffer writes within same tick into maxChunkBytes chunks
  let coalesceTimer = null;
  let coalesceBuf = '';
  const COALESCE_MAX = 65536; // flush when buffer exceeds this

  function flushCoalesce() {
    if (coalesceBuf.length === 0) return;
    const buf = coalesceBuf;
    coalesceBuf = '';
    if (!maxChunkBytes || buf.length <= maxChunkBytes) {
      process.stdout._origWrite(buf);
    } else {
      for (let i = 0; i < buf.length; i += maxChunkBytes) {
        process.stdout._origWrite(buf.slice(i, i + maxChunkBytes));
      }
    }
  }

  function scheduleFlush() {
    if (coalesceTimer) return;
    coalesceTimer = setImmediate(() => {
      coalesceTimer = null;
      flushCoalesce();
    });
  }

  // Split a buffer/string into maxChunkBytes-sized pieces
  function splitChunk(data) {
    if (!maxChunkBytes || data.length <= maxChunkBytes) return [data];
    const parts = [];
    for (let i = 0; i < data.length; i += maxChunkBytes) {
      parts.push(data.slice(i, i + maxChunkBytes));
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
        // Passthrough: coalesce to reduce Ink frame rate
        coalesceBuf += (typeof chunk === 'string' ? chunk : chunk.toString());
        if (coalesceBuf.length >= COALESCE_MAX) {
          flushCoalesce();
        } else {
          scheduleFlush();
        }
        if (callback) setImmediate(callback);
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

  // Coalescing state — flushed on pressure/critical
  let bypassCoalesce = false;

  const monitor = new MemoryMonitor({
    onTransition: (state, heapMb) => {
      if (state === 'pressure') {
        maxChunkBytes = MAX_CHUNK_PRESSURE;
        if (textMode === 'passthrough') {
          textMode = 'strip-ansi';
          processText = createTextProcessor(textMode);
          flushCoalesce();
          process.stderr.write(`${YELLOW}[nproxy]${RESET} memory pressure: ${heapMb}MB — throttling I/O\n`);
        } else {
          flushCoalesce();
          process.stderr.write(`${YELLOW}[nproxy]${RESET} memory pressure: ${heapMb}MB — throttling I/O\n`);
        }
      } else if (state === 'critical') {
        maxChunkBytes = MAX_CHUNK_CRITICAL;
        flushCoalesce();
        process.stderr.write(`${BLUE}${BOLD}[nproxy]${RESET}${BLUE} memory saving: ${heapMb}MB — throttling I/O${RESET}\n`);
      } else {
        maxChunkBytes = MAX_CHUNK_NORMAL;
        if (textMode !== process.env.NPROXY_TEXT && textMode !== 'passthrough') {
          textMode = process.env.NPROXY_TEXT || 'passthrough';
          processText = createTextProcessor(textMode);
          process.stderr.write(`${GREEN}[nproxy]${RESET} memory recovered: ${heapMb}MB — I/O normal\n`);
        }
      }
    },
  });
  monitor.start();

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
    let pty;
    try { pty = require('node-pty'); } catch (e) {
      process.stderr.write('[nproxy] node-pty not available. Install: npm install -g node-pty\n');
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
      if (signal) process.kill(process.pid, signal);
      else process.exit(exitCode);
    });
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
      try {
        const fs = require('fs');
        const buf = Buffer.alloc(128);
        const fd = fs.openSync(cli.app, 'r');
        fs.readSync(fd, buf, 0, 128, 0);
        fs.closeSync(fd);
        return buf.includes('node');
      } catch { return false; }
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
    child.stdout.pause();
    child.stdout.on('data', (chunk) => {
      const processed = processText(chunk);
      if (processed.length === 0) return;
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
      const ok = process.stderr.write(processed);
      if (!ok) {
        child.stderr.pause();
        process.stderr.once('drain', () => { child.stderr.resume(); });
      }
    });
    child.stderr.resume();

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
// When loaded via -r (preload), intercept() is not auto-called.
// User must call require('nproxy').intercept() or set NPROXY_AUTO=1
if (process.env.NPROXY_AUTO === '1') {
  intercept();
}

module.exports = { intercept, MemoryMonitor, createTextProcessor };
