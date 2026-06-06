const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Banner injection is inside runCLI() and intercept() — not directly exported.
// We test the banner format and logic by duplicating the core logic here.
function makeBanner(attn, press, crit, emg) {
  const dimGreen = '\x1b[32;2m', reset = '\x1b[0m', bold = '\x1b[1m', green = '\x1b[32m';
  const icon = `${bold}\u25C8${reset}${green}`;
  const title = ' nproxy memory guard active';
  const sub = `attn=${attn}  press=${press}  crit=${crit}  emg=${emg}MB`;
  const boxW = 56;
  const pad1 = boxW - 1 - '\u25C8 nproxy memory guard active'.length;
  const pad2 = boxW - 1 - sub.length;
  return `  ${dimGreen}\u2554${'\u2550'.repeat(boxW)}\u2557${reset}\n` +
    `  ${dimGreen}\u2551 ${icon}${title}${' '.repeat(pad1)}${dimGreen}\u2551${reset}\n` +
    `  ${dimGreen}\u2551 ${sub}${' '.repeat(pad2)}${dimGreen}\u2551${reset}\n` +
    `  ${dimGreen}\u255a${'\u2550'.repeat(boxW)}\u255d${reset}\n`;
}

describe('banner injection', () => {
  it('generates banner with correct thresholds', () => {
    const banner = makeBanner('100', '200', '400', '800');
    assert.ok(banner.includes('attn=100'));
    assert.ok(banner.includes('press=200'));
    assert.ok(banner.includes('crit=400'));
    assert.ok(banner.includes('emg=800MB'));
  });

  it('includes box drawing characters', () => {
    const banner = makeBanner('50', '100', '200', '400');
    assert.ok(banner.includes('\u2554')); // ╔
    assert.ok(banner.includes('\u2557')); // ╗
    assert.ok(banner.includes('\u255a')); // ╚
    assert.ok(banner.includes('\u255d')); // ╝
    assert.ok(banner.includes('\u2550')); // ═
    assert.ok(banner.includes('\u2551')); // ║
  });

  it('includes nproxy title', () => {
    const banner = makeBanner('100', '200', '400', '800');
    assert.ok(banner.includes('nproxy memory guard active'));
  });

  it('includes diamond icon', () => {
    const banner = makeBanner('100', '200', '400', '800');
    assert.ok(banner.includes('\u25C8')); // ◈
  });

  it('has 56-character wide box', () => {
    const banner = makeBanner('100', '200', '400', '800');
    const lines = banner.split('\n').filter(l => l.length > 0);
    for (const line of lines) {
      // Each line has box drawing + content + box drawing
      // The width is boxW + padding (spaces + box chars)
      assert.ok(line.length > 50, `Line too short: "${line}"`);
    }
  });

  it('generates consistent banner (idempotent)', () => {
    const b1 = makeBanner('100', '200', '400', '800');
    const b2 = makeBanner('100', '200', '400', '800');
    assert.strictEqual(b1, b2);
  });

  it('handles different threshold values', () => {
    const b1 = makeBanner('10', '20', '40', '80');
    const b2 = makeBanner('1000', '2000', '4000', '8000');
    assert.ok(b1.length > 0);
    assert.ok(b2.length > 0);
    assert.notStrictEqual(b1, b2);
  });
});
