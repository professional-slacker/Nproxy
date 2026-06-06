# nheap_limit — V8 NearHeapLimitCallback native addon

## Pre-built binary compatibility

The pre-built `build/Release/nheap_limit.node` is compiled on Node.js v22.x (ABI 127).
It uses N-API for module registration but calls V8's `AddNearHeapLimitCallback` directly.

| Node.js | Compatibility |
|---------|--------------|
| 22.x    | ✅ Pre-built binary works |
| 21.x    | ⚠️ May require rebuild |
| 20.x    | ⚠️ May require rebuild |
| < 20.x  | ❌ `AddNearHeapLimitCallback` not available |

## Rebuild for a different Node.js version

```sh
cd node/nheap_limit
npx node-gyp rebuild
```

## Graceful fallback

If the `.node` binary fails to load, nproxy.js falls back to tick-based
memory monitoring (no native NearHeapLimitCallback). All functionality
remains available.
