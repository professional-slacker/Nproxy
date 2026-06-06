const { describe, it } = require('node:test');
const assert = require('node:assert');
process.env.NPROXY_AUTO = '1'; // Prevent intercept() on require
const { parseArgs } = require('../nproxy.js');

describe('parseArgs', () => {
  it('parses app and args', () => {
    const r = parseArgs(['myapp', 'arg1', 'arg2']);
    assert.strictEqual(r.app, 'myapp');
    assert.deepStrictEqual(r.appArgs, ['arg1', 'arg2']);
    assert.strictEqual(r.help, false);
  });

  it('parses --text flag', () => {
    const r = parseArgs(['--text', 'transform', 'myapp']);
    assert.strictEqual(r.text, 'transform');
    assert.strictEqual(r.app, 'myapp');
  });

  it('parses --text=value format', () => {
    const r = parseArgs(['--text=strip-ansi', 'myapp']);
    assert.strictEqual(r.text, 'strip-ansi');
    assert.strictEqual(r.app, 'myapp');
  });

  it('parses --pty flag', () => {
    const r = parseArgs(['--pty', 'myapp']);
    assert.strictEqual(r.pty, true);
    assert.strictEqual(r.app, 'myapp');
  });

  it('parses --no-pty flag', () => {
    const r = parseArgs(['--no-pty', 'myapp']);
    assert.strictEqual(r.pty, false);
  });

  it('parses --text-log flag', () => {
    const r = parseArgs(['--text-log', '/tmp/log.txt', 'myapp']);
    assert.strictEqual(r.textLog, '/tmp/log.txt');
  });

  it('parses --text-log=value format', () => {
    const r = parseArgs(['--text-log=/tmp/log.txt', 'myapp']);
    assert.strictEqual(r.textLog, '/tmp/log.txt');
  });

  it('parses --help flag', () => {
    const r = parseArgs(['--help']);
    assert.strictEqual(r.help, true);
  });

  it('parses -h flag', () => {
    const r = parseArgs(['-h']);
    assert.strictEqual(r.help, true);
  });

  it('parses -- separator', () => {
    const r = parseArgs(['--text=passthrough', '--', 'myapp', '--flag']);
    assert.strictEqual(r.app, 'myapp');
    assert.deepStrictEqual(r.appArgs, ['--flag']);
  });

  it('handles no arguments', () => {
    const r = parseArgs([]);
    assert.strictEqual(r.app, null);
    assert.strictEqual(r.help, false);
  });

  it('handles only -- separator without app', () => {
    const r = parseArgs(['--']);
    assert.strictEqual(r.app, null); // app stays null default
  });

  it('handles multiple flags before app', () => {
    const r = parseArgs(['--text=transform', '--pty', '--text-log=/tmp/log', 'myapp', 'arg1']);
    assert.strictEqual(r.text, 'transform');
    assert.strictEqual(r.pty, true);
    assert.strictEqual(r.textLog, '/tmp/log');
    assert.strictEqual(r.app, 'myapp');
    assert.deepStrictEqual(r.appArgs, ['arg1']);
  });

  it('sets default values', () => {
    const r = parseArgs(['myapp']);
    assert.strictEqual(r.text, null);
    assert.strictEqual(r.textLog, null);
    assert.strictEqual(r.pty, false);
    assert.strictEqual(r.help, false);
    assert.strictEqual(r.app, 'myapp');
    assert.deepStrictEqual(r.appArgs, []);
  });

  it('handles --text= without value after equals', () => {
    const r = parseArgs(['--text=', 'myapp']);
    assert.strictEqual(r.text, '');
    assert.strictEqual(r.app, 'myapp');
  });
});
