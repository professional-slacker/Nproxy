'use strict';

/**
 * NearHeapLimitCallback native addon bridge.
 *
 * Provides register(callback) / unregister() for V8's near-heap-limit
 * callback — fires when V8 detects it's about to reach the heap limit.
 *
 * Optional dependency: if the .node binary isn't built, require() fails
 * and callers should handle gracefully.
 */

let mod = null;

// Bun (JavaScriptCore) doesn't support V8 native addons (AddNearHeapLimitCallback).
// Attempting to dlopen nheap_limit.node on Bun crashes the process at the linker level
// — even try-catch cannot recover. Guard against it explicitly.
if (process.versions && process.versions.bun) {
  // V8-only addon; Bun falls back to tick-only monitoring
} else {
  try {
    mod = require(require('path').join(__dirname, 'build', 'Release', 'nheap_limit.node'));
  } catch (e) {
    // not built — nproxy falls back to tick-only monitoring
  }
}

/**
 * Register a JS callback invoked (non-blocking, async) when V8's
 * near-heap-limit fires.
 *
 * The callback receives no arguments — the addon has already forced
 * GC and MemoryPressureNotification before calling back into JS.
 *
 * @param {Function} cb
 * @returns {boolean} true if registered, false if addon unavailable
 */
function register(cb) {
  if (!mod) return false;
  if (typeof cb !== 'function') throw new TypeError('callback must be a function');
  mod.register(cb);
  return true;
}

/**
 * Unregister the near-heap-limit callback.
 * @returns {boolean} true if unregistered, false if addon unavailable
 */
function unregister() {
  if (!mod) return false;
  mod.unregister();
  return true;
}

module.exports = { register, unregister, available: !!mod };
