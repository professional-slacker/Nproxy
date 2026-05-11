/*
 * libv8mon.so — LD_PRELOAD hook for V8 memory pressure detection
 *
 * Intercepts mmap/munmap/mprotect to track V8's total mapped heap.
 * Exposes a shared counter that nproxy.js reads via a small native addon.
 *
 * Build:
 *   gcc -shared -fPIC -o libv8mon.so v8mon.c -ldl
 *
 * Usage:
 *   LD_PRELOAD=./libv8mon.so node -r nproxy.js openclaude
 */

#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

/* ---- shared counter (readable from nproxy via /proc/self/maps or shm) ---- */
/* We use a global symbol so a small Node addon can dlsym() it */
_Atomic int64_t v8mon_total_mapped = 0;
_Atomic int64_t v8mon_peak_mapped = 0;

/* threshold in bytes — when total_mapped exceeds this, warn */
static int64_t threshold = 0;

/* original functions */
static void *(*real_mmap)(void *addr, size_t length, int prot, int flags, int fd, off_t offset) = NULL;
static int (*real_munmap)(void *addr, size_t length) = NULL;
static int (*real_mprotect)(void *addr, size_t len, int prot) = NULL;

/* env: V8MON_THRESHOLD_MB — warn when mapped exceeds this (default 768 MB) */
static int64_t get_threshold_mb(void) {
    const char *s = getenv("V8MON_THRESHOLD_MB");
    return s ? (int64_t)atol(s) : 768;
}

static __attribute__((constructor)) void v8mon_init(void) {
    real_mmap = (void *(*)(void *, size_t, int, int, int, off_t))dlsym(RTLD_NEXT, "mmap");
    real_munmap = (int (*)(void *, size_t))dlsym(RTLD_NEXT, "munmap");
    real_mprotect = (int (*)(void *, size_t, int))dlsym(RTLD_NEXT, "mprotect");
    threshold = get_threshold_mb() * 1024LL * 1024LL;

    const char *log = getenv("V8MON_LOG");
    if (log && log[0] == '1') {
        fprintf(stderr, "[v8mon] initialized, threshold=%lld MB\n",
                (long long)(threshold / 1024 / 1024));
    }
}

/* ---- mmap hook ---- */
void *mmap(void *addr, size_t length, int prot, int flags, int fd, off_t offset) {
    if (!real_mmap) {
        /* fallback if dlsym failed (shouldn't happen) */
        return (void *)-1;
    }
    void *result = real_mmap(addr, length, prot, flags, fd, offset);
    if (result != MAP_FAILED && (flags & MAP_ANONYMOUS) && (prot & PROT_WRITE)) {
        /* Only count writable anonymous maps — these are V8 heap regions */
        int64_t prev = atomic_fetch_add(&v8mon_total_mapped, (int64_t)length);
        int64_t total = prev + (int64_t)length;
        if (total > atomic_load(&v8mon_peak_mapped)) {
            atomic_store(&v8mon_peak_mapped, total);
        }
        if (total > threshold) {
            fprintf(stderr,
                    "\x1b[33m[v8mon] mmap pressure: total=%lld MB (threshold=%lld MB)\x1b[0m\n",
                    (long long)(total / 1024 / 1024),
                    (long long)(threshold / 1024 / 1024));
        }
        const char *log = getenv("V8MON_LOG");
        if (log && log[0] == '1') {
            fprintf(stderr, "[v8mon] mmap +%zu = %lld MB\n",
                    length, (long long)(total / 1024 / 1024));
        }
    }
    return result;
}

/* ---- munmap hook ---- */
int munmap(void *addr, size_t length) {
    if (!real_munmap) return -1;
    int result = real_munmap(addr, length);
    if (result == 0) {
        atomic_fetch_sub(&v8mon_total_mapped, (int64_t)length);
    }
    return result;
}

/* ---- mprotect hook (optional, may be noisy) ---- */
int mprotect(void *addr, size_t len, int prot) {
    if (!real_mprotect) return -1;
    return real_mprotect(addr, len, prot);
}
