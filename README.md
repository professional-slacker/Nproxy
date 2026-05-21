# nproxy — Runtime I/O Proxy

> **nproxy is a runtime I/O proxy.**
> **Control codes pass through transparently; signals are relayed.**
> **Protocol and semantics live outside nproxy.**

```
node -r ./node/nproxy.js app.js          # Node preload mode
nproxy command [args...]                 # Rust CLI mode
```

---

## Quick Start

```bash
# 1. Hook into an existing Node.js app (NODE_OPTIONS — recommended)
#    nproxy shares the app's process, monitoring memory in real-time.
NODE_OPTIONS="--expose-gc -r $HOME/workfolder/Nproxy/node/nproxy.js" \
  NPROXY_TEXT=passthrough my-app.js

# 2. Hook with node -r (also works for CJS apps)
NPROXY_TEXT=passthrough node -r ./node/nproxy.js my-app.js

# 3. Launch any CLI tool through nproxy (spawn mode)
#    nproxy runs the tool as a child process and relays I/O.
./nproxy-run.sh my-agent

# 4. Aliases for daily use (add to ~/.bash_aliases)
alias npro='NODE_OPTIONS="--expose-gc -r $HOME/workfolder/Nproxy/node/nproxy.js" NPROXY_TEXT=passthrough'
alias myagent='npro my-app'

# Then simply:
myagent
```

**Preload mode vs spawn mode:**

| Mode | What it does | Use when |
|------|---|---|
| `NODE_OPTIONS="-r nproxy.js" app` | nproxy runs **inside** the app process (recommended for ESM apps) | You want to wrap an existing Node.js CLI or TUI app |
| `node -r ./nproxy.js app` | nproxy runs **inside** the app process (CJS only) | Simple CJS apps |
| `./nproxy-run.sh app` | nproxy runs the app as a **child process** | You want to launch any command (Node, Go, Python, etc.) through nproxy |

> **Note:** For ESM main scripts (e.g., apps with `"type": "module"`), use `NODE_OPTIONS` instead of `node -r`.
> Node.js may skip CJS preload with `node -r` when the main script is ESM.

**Windows support:**

| Environment | Status |
|---|---|
| WSL2 | ✅ Works out of the box — full Linux compatibility |
| Windows native (Node.js) | ⚠️ Spawn mode possible; preload mode limited (no `/dev/tty`) |
| Windows native (Rust) | 🔄 Planned (Phase 9)

For the preload mode, the `-r` flag tells Node to load nproxy **before** your app starts,
so nproxy can hook into `process.stdout.write` and set up memory monitoring from the beginning.

> **Alias tip:** Use `$HOME` instead of `~` in alias definitions — `~` may not expand
> inside single quotes. Example: `alias npro='NPROXY_TEXT=passthrough node -r $HOME/workfolder/Nproxy/node/nproxy.js'`

---

## Absolute Requirements (Must)

These 3 principles define nproxy regardless of language or implementation.
**If any of these fail, the implementation is broken.** Code review checklist.

### ① No Chunk Retention

Chunks (Buffer/bytes) must not be held in memory except during passthrough.
Only metadata (size, timestamp, kind) may be observed.

| Violation Consequence |
|---|
| OOM (immediate or gradual) |

- Rust: `tokio::io::copy` / `copy_buf` — delegate to OS buffer
- Node: `pipe()` only. Never buffer in `data` event handlers
- Go: `io.Copy` / `io.CopyBuffer` — zero allocation

### ② Delegate to OS-level Backpressure

Don't buffer internally. Rely on OS poll: "don't read → kernel pipe buffer fills → upstream blocks".

| Violation Consequence |
|---|
| Flowing-mode fixed breaks the mechanism → OOM or stall |

- **Stop reading = block child's write** is the only correct backpressure
- `Poll::Pending` (Rust) / `ReadStop` (Node libuv) / simply not reading (Go)
- OS buffers. nproxy doesn't buffer.

### ③ Policy Reduces Side-effects Only

The main path (passthrough) must never be stopped or rejected.
Only side-effects (observation resolution, ring buffer, text mode) can be degraded.

| Violation Consequence |
|---|
| Violates "never reject / never stop". The proxy loses its reason to exist. |

| state | byte layer | text layer |
|---|---|---|
| NORMAL | full observation + ring 1024 | text-on-by-config |
| PRESSURE | summary + ring 128 + text-AUTO-OFF | heavy transforms stop |
| CRITICAL | observation off + ring 0 + text-OFF + **ReadGate closed** | backpressure suppresses child |

**In every state, the passthrough main path continues.**
Even in CRITICAL, ReadGate stopping reads is backpressure — not blocking.
If the child blocks on write, nproxy is simply "waiting for reads to resume."

---

## Implementations

### Node — preload mode (`-r`)

```bash
node -r ./node/nproxy.js my-app.js

# Environment variables
NPROXY_TEXT=passthrough|transform|strip-ansi   # text processing mode (default: passthrough)
  #   passthrough  — pass through unmodified. Recommended for interactive CLIs (Ink, React).
  #   transform    — prepend timestamp to each line. For batch logging / file output only.
  #                  NOT recommended for interactive CLIs — timestamps break layout rendering.
  #   strip-ansi   — strip escape sequences. For log storage, grep-friendly output.
NPROXY_MONITOR=auto|rss|split|array         # memory monitoring tier (default: auto)
  #   auto    — starts at rss, auto-upgrades to split (attention+) then array (critical+)
  #   rss     — lightweight: process.memoryUsage().rss only
  #   split   — rss + heapUsed dual monitoring + SlicedString detach (V8 issue2869)
  #   array   — rss + split features + Array proxy for push/unshift/splice
NPROXY_DEBUG=1                                 # enable chunk split / debug logs (default: off)
NPROXY_MEMLOG=60                               # periodic memory log in seconds (0=OFF)
```

- `process.stdout.write` hook + memory monitoring with auto mode degradation
- **256KB chunk splitting** — any write exceeding 256KB is split into `MAX_CHUNK_NORMAL` pieces
- **5-stage memory guard**: monitoring → attention(256MB) → pressure(512MB) → critical(1024MB) → emergency(1280MB)
  - pressure: auto-switch to strip-ansi, reduces chunk size to 64KB
  - critical: chunk size reduced to 4KB, near-emergency
  - emergency: bypass coalescing, write immediately
- **V8 NearHeapLimitCallback C++ addon** (`node/nheap_limit/`) — fires before V8 OOM, forces emergency state
- Coalescing to prevent frame rate loss in interactive CLI frameworks (Ink, React, etc.)
- Color-coded stderr feedback: attention (yellow) / pressure (red) / critical (blue) / emergency (magenta)
- Startup banner `◈ nproxy memory guard active` injected on first output
- **Process title** — `ps` and OOM messages show the app name and memory state:
  ```
  my-app [nproxy::monitoring]            # normal
  my-app [nproxy::attention:300MB]       # attention
  my-app [nproxy::pressure:500MB]        # pressure
  my-app [nproxy::critical:1024MB]       # critical
  my-app [nproxy::emergency]             # emergency
  ```
- Cursor show/hide (`?25h`/`?25l`) preserved in transform/strip-ansi mode
- Windows: undefined signals guarded with try/catch

### Rust — CLI relay

```bash
cargo run --release -- command [args...]
cargo run --release -- --text=strip-ansi -- command [args...]
```

- `tokio::process::Command` + `AsyncRead`/`AsyncWrite` relay
- `ReadGate` poll-stop backpressure
- `/proc/<child_pid>/status` RSS monitoring → watch channel → relay notification
- TextPipeline: passthrough / strip-ansi / transform + auto degradation

---

## Cross-language Design Principles

| Design | Node | Rust | Common Root |
|---|---|---|---|
| No Chunk Retention | `pipe()` only | `tokio::io::copy` / `copy_buf` | Delegate to OS buffer |
| Backpressure | libuv ReadStop/ReadStart | Tokio AsyncRead poll → `Poll::Pending` | OS poll stop/resume |
| Policy Degradation | JS state + setInterval | `MemoryPolicy` + watch channel | State affects side-effects only |
| Chunk = Minimal Unit | Buffer (V8 ArrayBuffer) | `Bytes`/`BytesMut` | OS page size |
| Runtime I/O | libuv | epoll / kqueue / IOCP | Per-OS poll API |

---

## Rust-specific Capabilities

| Feature | OS API | Description |
|---|---|---|
| zero-copy pipe→pipe | `splice(2)` (Linux) | Copy-free relay when observation is off |
| zero-copy file→socket | `sendfile(2)` | Large transfer at <1% CPU |
| pipe forking | `tee(2)` | Ideal for logging |
| batch I/O | `io_uring` (Linux 5.1+) | High throughput, low latency |
| pty full control | `posix_openpt` etc | TTY raw mode / SIGWINCH relay |
| cgroup / rlimit | cgroup v2 | Child memory limit without kill |
| signal ordering | `signalfd` / kqueue | Resolve SIGCHLD vs SIGTERM races |

---

## Project Structure

```
.
├── node/           Node.js preload mode implementation
│   └── nproxy.js
├── rs/             Rust CLI relay implementation (PRE-ALPHA — not usable yet)
│   ├── src/
│   │   ├── main.rs
│   │   ├── relay.rs       ← ReadGate + spawn_relay/spawn_text_relay
│   │   ├── memory.rs      ← /proc/<pid>/status RSS monitoring
│   │   ├── text.rs        ← TextPipeline + state degradation
│   │   ├── observer.rs    ← meta observation (ring buffer / size / ts)
│   │   └── child.rs       ← child process spawn + signal relay
│   ├── tests/
│   └── Cargo.toml
├── result/         Legacy Node prototypes
├── doc/            Design documentation
└── README.md
```

---

## Known Issues

### Interactive CLI layout artifacts (Node passthrough mode)

When used with Ink/React-based interactive CLIs, rare rendering artifacts
(stray single characters like "s", "e", "g") may appear during rapid frame
updates (e.g. toggling panels). The artifacts are visual only — no data is
lost or corrupted.

**Workaround:** Restart the session. Artifacts do not accumulate over time.
**Status:** Under investigation — appears to be an Ink write pattern race
that nproxy's synchronous write pass-through cannot fully eliminate.

---

## Licensing & Support

nproxy is free software under the GPL 3.0.  
If this project saves you time or hassle, donations in crypto are welcome:

```
Bitcoin:  bc1q096t3sc9mndnu94guxcwjqpg7c5qcdv3gf0e0g
ETH:      0x1b9b7911585189c526d7740ce6c5e1c94c78aa84
USDT:     0x1b9b7911585189c526d7740ce6c5e1c94c78aa84
**Minimum $20+ due to wallet fees.**
```

For commercial licensing inquiries (proprietary use, OEM integration, custom development):
→ **nproxyinfo@proton.me** or [open a GitHub Issue](https://github.com/professional-slacker/nproxy/issues/new?template=commercial_license.md)

---

> Internal design documents under `doc/` are written in Japanese — they are development notes, not part of the public interface.
**Minimum $20+ due to wallet fees.**
```

**nproxy は GPL 3.0 のフリーソフトウェアです。  
役に立ったと思ったら、任意の暗号通貨支援をお願いします 🙏**

---

## Code Review Checklist

See [`REVIEW_CHECKLIST.md`](./REVIEW_CHECKLIST.md).

Review must verify:

- [ ] No Chunk Retention — no chunk held in fields/closures
- [ ] Backpressure delegation — `Poll::Pending` / `ReadStop` / not-reading
- [ ] Policy reduces side-effects only — main path never stopped/rejected
