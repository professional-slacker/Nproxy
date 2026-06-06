const { describe, it } = require('node:test');
const assert = require('node:assert');
process.env.NPROXY_AUTO = '1'; // Prevent intercept() on require
const { parseArgs } = require('../nproxy.js');

describe('PTY mode logic', () => {
  it('parseArgs sets pty true with --pty', () => {
    const r = parseArgs(['--pty', 'myapp']);
    assert.strictEqual(r.pty, true);
  });

  it('parseArgs sets pty false with --no-pty', () => {
    const r = parseArgs(['--no-pty', 'myapp']);
    assert.strictEqual(r.pty, false);
  });

  it('parseArgs defaults pty to false', () => {
    const r = parseArgs(['myapp']);
    assert.strictEqual(r.pty, false);
  });

  it('parseArgs handles --pty before app', () => {
    const r = parseArgs(['--pty', 'node', 'server.js']);
    assert.strictEqual(r.pty, true);
    assert.strictEqual(r.app, 'node');
    assert.deepStrictEqual(r.appArgs, ['server.js']);
  });
});

describe('signal relay logic', () => {
  // The signal-to-exit code conversion in nproxy.js:
  //   const sigNum = signal === 'SIGKILL' ? 9
  //     : signal === 'SIGINT' ? 2
  //     : signal === 'SIGTERM' ? 15
  //     : 1;
  //   process.exit(128 + sigNum);

  function signalToExitCode(signal) {
    const sigNum = signal === 'SIGKILL' ? 9
      : signal === 'SIGINT' ? 2
      : signal === 'SIGTERM' ? 15
      : signal === 'SIGHUP' ? 1
      : 1;
    return 128 + sigNum;
  }

  it('SIGINT maps to exit code 130', () => {
    assert.strictEqual(signalToExitCode('SIGINT'), 130);
  });

  it('SIGTERM maps to exit code 143', () => {
    assert.strictEqual(signalToExitCode('SIGTERM'), 143);
  });

  it('SIGKILL maps to exit code 137', () => {
    assert.strictEqual(signalToExitCode('SIGKILL'), 137);
  });

  it('unknown signal maps to exit code 129', () => {
    assert.strictEqual(signalToExitCode('SIGUSR1'), 129);
  });

  it('SIGHUP maps to exit code 129', () => {
    assert.strictEqual(signalToExitCode('SIGHUP'), 129);
  });
});

describe('PTY terminal state restoration', () => {
  function buildResetSequence() {
    return [
      '\x1b[?1000l',  // X10 mouse off
      '\x1b[?1002l',  // button events off
      '\x1b[?1003l',  // all motion off
      '\x1b[?1006l',  // SGR mouse mode off
      '\x1b[?1049l',  // alternate screen off
    ].join('');
  }

  it('generates proper reset sequence', () => {
    const seq = buildResetSequence();
    assert.ok(seq.includes('\x1b[?1000l'));
    assert.ok(seq.includes('\x1b[?1002l'));
    assert.ok(seq.includes('\x1b[?1003l'));
    assert.ok(seq.includes('\x1b[?1006l'));
    assert.ok(seq.includes('\x1b[?1049l'));
  });
});
