const { describe, it } = require('node:test');
const assert = require('node:assert');
process.env.NPROXY_AUTO = '1'; // Prevent intercept() on require
const { createInputProcessor } = require('../nproxy.js');

describe('createInputProcessor', () => {
  it('returns passthrough for default (no mode)', () => {
    const fn = createInputProcessor();
    assert.strictEqual(fn('hello'), 'hello');
  });

  it('returns passthrough for passthrough mode', () => {
    const fn = createInputProcessor('passthrough');
    assert.strictEqual(fn('hello'), 'hello');
  });

  it('returns passthrough for off mode', () => {
    const fn = createInputProcessor('off');
    assert.strictEqual(fn('hello'), 'hello');
  });

  it('returns passthrough for undefined', () => {
    const fn = createInputProcessor(undefined);
    assert.strictEqual(fn('hello'), 'hello');
  });

  it('returns passthrough for null', () => {
    const fn = createInputProcessor(null);
    assert.strictEqual(fn('hello'), 'hello');
  });

  it('returns passthrough for unknown mode', () => {
    const fn = createInputProcessor('transform');
    assert.strictEqual(fn('hello'), 'hello');
  });

  it('preserves Buffer passthrough', () => {
    const fn = createInputProcessor('passthrough');
    const buf = Buffer.from('hello');
    assert.strictEqual(fn(buf), buf);
  });
});
