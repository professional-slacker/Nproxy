const { describe, it } = require('node:test');
const assert = require('node:assert');
process.env.NPROXY_AUTO = '1'; // Prevent intercept() on require
const { createTextProcessor } = require('../nproxy.js');

describe('createTextProcessor', () => {
  describe('passthrough mode', () => {
    it('returns chunk unchanged for string', () => {
      const fn = createTextProcessor('passthrough');
      assert.strictEqual(fn('hello'), 'hello');
    });

    it('returns chunk unchanged for Buffer', () => {
      const fn = createTextProcessor('passthrough');
      const buf = Buffer.from('hello');
      assert.strictEqual(fn(buf), buf);
    });

    it('handles ANSI sequences without modification', () => {
      const fn = createTextProcessor('passthrough');
      const input = '\x1b[31mred\x1b[0m';
      const result = fn(input);
      assert.ok(result.includes('\x1b[31m'));
      assert.ok(result.includes('\x1b[0m'));
    });

    it('handles binary data without modification', () => {
      const fn = createTextProcessor('passthrough');
      const buf = Buffer.alloc(256);
      for (let i = 0; i < 256; i++) buf[i] = i;
      const result = fn(buf);
      assert.deepStrictEqual(result, buf);
    });
  });

  describe('strip-ansi mode', () => {
  it('keeps SGR color sequences (principle 1: control codes pass through)', () => {
    const fn = createTextProcessor('strip-ansi');
    const result = fn('\x1b[31mred\x1b[0m');
    assert.strictEqual(result, '\x1b[31mred\x1b[0m');
  });

  it('keeps bold sequence', () => {
    const fn = createTextProcessor('strip-ansi');
    const result = fn('\x1b[1mbold\x1b[0m');
    assert.strictEqual(result, '\x1b[1mbold\x1b[0m');
  });

    it('keeps cursor movement sequences (A B C D)', () => {
      const fn = createTextProcessor('strip-ansi');
      const result = fn('\x1b[A\x1b[B\x1b[C\x1b[D');
      assert.ok(result.includes('\x1b[A'));
      assert.ok(result.includes('\x1b[B'));
      assert.ok(result.includes('\x1b[C'));
      assert.ok(result.includes('\x1b[D'));
    });

    it('keeps cursor position sequences (G H f)', () => {
      const fn = createTextProcessor('strip-ansi');
      const result = fn('\x1b[10G\x1b[5;10H\x1b[3;15f');
      assert.ok(result.includes('\x1b[10G'), 'G should be kept');
      assert.ok(result.includes('\x1b[5;10H'), 'H should be kept');
      assert.ok(result.includes('\x1b[3;15f'), 'f should be kept');
    });

    it('keeps erase sequences (J K)', () => {
      const fn = createTextProcessor('strip-ansi');
      const result = fn('\x1b[2J\x1b[K');
      assert.ok(result.includes('\x1b[2J'));
      assert.ok(result.includes('\x1b[K'));
    });

    it('keeps scroll sequences (S T)', () => {
      const fn = createTextProcessor('strip-ansi');
      const result = fn('\x1b[S\x1b[T');
      assert.ok(result.includes('\x1b[S'));
      assert.ok(result.includes('\x1b[T'));
    });

    it('keeps cursor show/hide (\\x1b[?25h and \\x1b[?25l)', () => {
      const fn = createTextProcessor('strip-ansi');
      const result = fn('\x1b[?25hshow\x1b[?25lhide');
      assert.ok(result.includes('\x1b[?25h'));
      assert.ok(result.includes('\x1b[?25l'));
    });

    it('keeps save/restore cursor (s u)', () => {
      const fn = createTextProcessor('strip-ansi');
      const result = fn('\x1b[s\x1b[u');
      assert.ok(result.includes('\x1b[s'));
      assert.ok(result.includes('\x1b[u'));
    });

    it('keeps device status (n)', () => {
      const fn = createTextProcessor('strip-ansi');
      const result = fn('\x1b[6n');
      assert.ok(result.includes('\x1b[6n'));
    });

    it('keeps DECSET/DECRST for l and h', () => {
      const fn = createTextProcessor('strip-ansi');
      const result = fn('\x1b[?1049h\x1b[?1049l');
      assert.ok(result.includes('\x1b[?1049h'));
      assert.ok(result.includes('\x1b[?1049l'));
    });

    it('removes OSC 8 hyperlink sequences', () => {
      const fn = createTextProcessor('strip-ansi');
      const input = '\x1b]8;link\x07text\x1b]8;;\x07';
      const result = fn(input);
      assert.strictEqual(result, 'text');
    });

    it('removes DCS sequences', () => {
      const fn = createTextProcessor('strip-ansi');
      const input = '\x1bP0q"1;2;3\x1b\\text';
      const result = fn(input);
      assert.strictEqual(result, 'text');
    });

  it('removes private mode sequences with private markers not in keepFinal', () => {
    const fn = createTextProcessor('strip-ansi');
    // Use a private sequence whose final byte is NOT in keepFinal
    // Strip Enquiry Response Sequence (DECRPTR): \x1b[?0c (not in keepFinal)
    const input = '\x1b[?0ctext';
    const result = fn(input);
    assert.strictEqual(result, 'text');
  });

    it('returns Buffer as-is (non-string)', () => {
      const fn = createTextProcessor('strip-ansi');
      const buf = Buffer.from('hello');
      assert.strictEqual(fn(buf), buf);
    });

    it('handles empty string', () => {
      const fn = createTextProcessor('strip-ansi');
      assert.strictEqual(fn(''), '');
    });

    it('handles string with no ANSI sequences', () => {
      const fn = createTextProcessor('strip-ansi');
      assert.strictEqual(fn('plain text'), 'plain text');
    });
  });

  describe('transform mode', () => {
  it('keeps SGR sequences (principle 1)', () => {
    const fn = createTextProcessor('transform');
    const result = fn('\x1b[31mred\x1b[0m');
    assert.strictEqual(result, '\x1b[31mred\x1b[0m');
  });

    it('normalizes Unicode to NFC', () => {
      const fn = createTextProcessor('transform');
      // 'é' as NFD: e + combining acute accent
      const nfd = 'e\u0301';
      const result = fn(nfd);
      assert.strictEqual(result, '\u00e9'); // NFC form
    });

    it('keeps plain text unchanged', () => {
      const fn = createTextProcessor('transform');
      assert.strictEqual(fn('hello world'), 'hello world');
    });

    it('handles empty string', () => {
      const fn = createTextProcessor('transform');
      assert.strictEqual(fn(''), '');
    });

    it('handlers CJK text without corruption', () => {
      const fn = createTextProcessor('transform');
      const input = '日本語テスト';
      assert.strictEqual(fn(input), input);
    });

    it('returns Buffer as-is (non-string)', () => {
      const fn = createTextProcessor('transform');
      const buf = Buffer.from('hello');
      assert.strictEqual(fn(buf), buf);
    });
  });

  describe('off mode', () => {
    it('returns chunk unchanged', () => {
      const fn = createTextProcessor('off');
      assert.strictEqual(fn('hello'), 'hello');
    });
  });

  describe('invalid mode', () => {
    it('falls back to passthrough', () => {
      const fn = createTextProcessor('invalid_mode');
      assert.strictEqual(fn('hello'), 'hello');
    });

    it('handles undefined', () => {
      const fn = createTextProcessor(undefined);
      assert.strictEqual(fn('hello'), 'hello');
    });

    it('handles null', () => {
      const fn = createTextProcessor(null);
      assert.strictEqual(fn('hello'), 'hello');
    });
  });
});
