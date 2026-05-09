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
  const out = { text: null, textLog: null, app: null, appArgs: [] };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--text' && argv[i + 1]) { out.text = argv[++i]; continue; }
    if (a.startsWith('--text=')) { out.text = a.slice(7); continue; }
    if (a === '--text-log' && argv[i + 1]) { out.textLog = argv[++i]; continue; }
    if (a.startsWith('--text-log=')) { out.textLog = a.slice(11); continue; }
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
  if (mode === 'strip-ansi') {
    // Strip ANSI escape sequences (including OSC 8 hyperlinks)
    const ansiRe = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
    const oscRe = /\x1b\]8;.*?(?:\x07|\x1b\\)/g;
    return (chunk) => {
      if (typeof chunk === 'string') {
        return chunk.replace(oscRe, '').replace(ansiRe, '');
      }
      return chunk;
    };
  }
  if (mode === 'transform') {
    // Full transform mode: strip ANSI + normalize unicode (NFC)
    const ansiRe = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
    const oscRe = /\x1b\]8;.*?(?:\x07|\x1b\\)/g;
    return (chunk) => {
      if (typeof chunk === 'string') {
        return chunk.replace(oscRe, '').replace(ansiRe, '').normalize('NFC');
      }
      return chunk;
    };
  }
  return (chunk) => chunk;
}

// ---- Memory Monitor ----
class MemoryMonitor {
  constructor(opts = {}) {
    this.pressureMb = opts.pressureMb || 512;
    this.criticalMb = opts.criticalMb || 1024;
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
  const textMode = process.env.NPROXY_TEXT || 'passthrough';
  const processText = createTextProcessor(textMode);

  // Chunk size limit per write (0 = no limit)
  let maxChunkBytes = 0;
  const MAX_CHUNK_NORMAL = 0;       // no limit
  const MAX_CHUNK_PRESSURE = 65536; // 64KB
  const MAX_CHUNK_CRITICAL = 4096;  // 4KB

  // Split a buffer/string into maxChunkBytes-sized pieces
  function splitChunk(data) {
    if (!maxChunkBytes || data.length <= maxChunkBytes) return [data];
    const parts = [];
    for (let i = 0; i < data.length; i += maxChunkBytes) {
      parts.push(data.slice(i, i + maxChunkBytes));
    }
    return parts;
  }

  // Wrap stdout.write with chunk splitting
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = function (chunk, encoding, callback) {
    if (typeof chunk === 'string' || chunk instanceof Buffer) {
      const processed = processText(chunk);
      const parts = splitChunk(processed);
      for (let i = 0; i < parts.length; i++) {
        const cb = i === parts.length - 1 ? callback : undefined;
        origStdoutWrite(parts[i], encoding, cb);
      }
      return true;
    }
    return origStdoutWrite(chunk, encoding, callback);
  };

  // Wrap stderr.write with chunk splitting
  const origStderrWrite = process.stderr.write.bind(process.stderr);
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
  const monitor = new MemoryMonitor({
    onTransition: (state, heapMb) => {
      if (state === 'pressure') {
        maxChunkBytes = MAX_CHUNK_PRESSURE;
        process.stderr.write(`[nproxy] memory pressure: ${heapMb}MB — limiting chunk to 64KB\n`);
      } else if (state === 'critical') {
        maxChunkBytes = MAX_CHUNK_CRITICAL;
        process.stderr.write(`[nproxy] critical memory: ${heapMb}MB — limiting chunk to 4KB\n`);
      } else {
        maxChunkBytes = MAX_CHUNK_NORMAL;
      }
    },
  });
  monitor.start();
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

  const child = spawn(cli.app, cli.appArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });

  // Stdin relay: parent stdin → child stdin (unmodified)
  if (process.stdin.isTTY) {
    process.stdin.setRawMode && process.stdin.setRawMode(true);
  }
  process.stdin.on('data', (chunk) => {
    child.stdin.write(chunk);
  });
  process.stdin.on('end', () => child.stdin.end());

  // Stdout relay: child stdout → parent stdout (with optional text processing)
  child.stdout.on('data', (chunk) => {
    const processed = processText(chunk);
    if (processed.length > 0) process.stdout.write(processed);
  });

  // Stderr relay: child stderr → parent stderr
  child.stderr.on('data', (chunk) => {
    const processed = processText(chunk);
    if (processed.length > 0) process.stderr.write(processed);
  });

  // Signal relay
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGUSR1', 'SIGUSR2', 'SIGWINCH'];
  for (const sig of signals) {
    process.on(sig, () => { child.kill(sig); });
  }

  child.on('exit', (code, sig) => {
    process.stdin.removeAllListeners();
    if (sig) process.kill(process.pid, sig);
    else process.exit(code);
  });
}

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
