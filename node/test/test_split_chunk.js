const { describe, it } = require('node:test');
const assert = require('node:assert');
process.env.NPROXY_AUTO = '1'; // Prevent intercept() on require
const { splitChunk } = require('../nproxy.js');

describe('splitChunk', () => {
  it('returns single piece when data <= limit', () => {
    const result = splitChunk('hello', 1024);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0], 'hello');
  });

  it('returns single piece when limit is 0', () => {
    const result = splitChunk('hello', 0);
    assert.strictEqual(result.length, 1);
  });

  it('returns single piece when limit is null', () => {
    const result = splitChunk('hello', null);
    assert.strictEqual(result.length, 1);
  });

  it('returns single piece when limit is undefined', () => {
    const result = splitChunk('hello', undefined);
    assert.strictEqual(result.length, 1);
  });

  it('splits data larger than limit into multiple pieces', () => {
    const result = splitChunk('abcdefghij', 5);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0], 'abcde');
    assert.strictEqual(result[1], 'fghij');
  });

  it('splits when data equals exact multiple of limit', () => {
    const result = splitChunk('abcdefghij', 5);
    assert.strictEqual(result.length, 2);
  });

  it('handles last piece smaller than limit', () => {
    const result = splitChunk('abcdefghijk', 5);
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0], 'abcde');
    assert.strictEqual(result[1], 'fghij');
    assert.strictEqual(result[2], 'k');
  });

  it('splits Buffer correctly', () => {
    const buf = Buffer.from('abcdefghij');
    const result = splitChunk(buf, 4);
    assert.strictEqual(result.length, 3);
    assert.ok(Buffer.isBuffer(result[0]));
    assert.strictEqual(result[0].length, 4);
    assert.strictEqual(result[1].length, 4);
    assert.strictEqual(result[2].length, 2);
  });

  it('preserves content after split (string)', () => {
    const result = splitChunk('abcdefghijklmnopqrstuvwxyz', 10);
    const joined = result.join('');
    assert.strictEqual(joined, 'abcdefghijklmnopqrstuvwxyz');
  });

  it('preserves content after split (Buffer)', () => {
    const original = Buffer.from('hello world!');
    const result = splitChunk(original, 4);
    const joined = Buffer.concat(result.map(b => Buffer.isBuffer(b) ? b : Buffer.from(b)));
    assert.ok(joined.equals(original));
  });

  it('handles one-byte limit', () => {
    const result = splitChunk('abc', 1);
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0], 'a');
    assert.strictEqual(result[1], 'b');
    assert.strictEqual(result[2], 'c');
  });

  it('handles limit larger than data', () => {
    const result = splitChunk('abc', 1000);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0], 'abc');
  });

  it('handles empty string', () => {
    const result = splitChunk('', 1024);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0], '');
  });

  it('handles empty Buffer', () => {
    const result = splitChunk(Buffer.alloc(0), 1024);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].length, 0);
  });
});
