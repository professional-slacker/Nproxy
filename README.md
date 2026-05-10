# nproxy — Runtime I/O Proxy

> **nproxy is a runtime I/O proxy.**
> **Control codes pass through transparently; signals are relayed.**
> **Protocol and semantics live outside nproxy.**

```
node -r ./node/nproxy.js app.js          # Node preload mode
cargo run -- command [args...]            # Rust CLI mode
```

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
NPROXY_AUTO=1 node -r ./node/nproxy.js /usr/bin/openclaude

# Environment variables
NPROXY_TEXT=passthrough|transform|strip-ansi   # text processing mode (default: passthrough)
NPROXY_AUTO=1                                  # auto-call intercept()
NPROXY_PRESSURE_MB=512                         # memory throttle threshold (default: 512)
NPROXY_CRITICAL_MB=1024                        # critical throttle threshold (default: 1024)
NPROXY_MEMLOG=60                               # periodic memory log in seconds (0=OFF)
```

- `process.stdout.write` hook + memory monitoring with auto mode degradation
- Coalescing to prevent Ink frame rate loss
- Color-coded stderr feedback: pressure (yellow) / critical (blue) / normal (green)
- Startup banner `◈ nproxy memory guard active` injected below OpenClaude header
- Cursor show/hide (`?25h`/`?25l`) preserved in transform/strip-ansi mode
- Windows: undefined signals guarded with try/catch
- **Alias note**: use `$HOME` instead of `~` in alias definitions (`~` may not expand inside single quotes)

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
├── rs/             Rust CLI relay implementation
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

## Support

nproxy is free software under the GPL 3.0.  
If this project saves you time or hassle, donations in crypto are welcome:

```
Bitcoin:  bc1q...
Ethereum: 0x...
Monero:   4...
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
