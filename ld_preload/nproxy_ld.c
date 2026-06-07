#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <dlfcn.h>
#include <errno.h>
#include <libgen.h>

/*
 * nproxy_ld.so — LD_PRELOAD execve hook for transparent nproxy injection.
 *
 * When LD_PRELOAD is set, this library intercepts execve() calls and injects
 * nproxy (via NODE_OPTIONS for Node targets or nproxy-run.sh --pty wrapper
 * for non-Node binaries) into child processes.
 *
 * Hook strategy (two layers for maximum reach):
 *   1. execve/execvp/execvpe hooks — intercept libc exec calls (bash, Node.js,
 *      traditional ELF). Catches fork()+execvp() paths.
 *   2. fork() hook — swaps environ in child (pid==0) to inject NODE_OPTIONS.
 *      Catches fork→vfork→inline_execve paths (Bun, Deno, Go).
 *      Safe because fork() uses COW — child's environ swap does not affect parent.
 *
 * Environment variables:
 *   NPROXY_LD_TARGETS  — comma-separated binary names to wrap (default: all)
 *   NPROXY_LD_VERBOSE  — set to "1" for debug output to stderr
 *   NPROXY_LD_NPROXY   — path to nproxy-run.sh (default: auto-detect)
 */

static int verbose = 0;
static int initialized = 0;

/* Real execve family functions */
static int (*real_execve)(const char *pathname, char *const argv[], char *const envp[]) = NULL;
static int (*real_execvp)(const char *file, char *const argv[]) = NULL;
static int (*real_execvpe)(const char *file, char *const argv[], char *const envp[]) = NULL;
static int (*real_execveat)(int dirfd, const char *pathname, char *const argv[], char *const envp[], int flags) = NULL;
static int (*real_fexecve)(int fd, char *const argv[], char *const envp[]) = NULL;
static pid_t (*real_fork)(void) = NULL;

/* Target process names */
static char **targets = NULL;
static int ntargets = 0;

/* nproxy-run.sh path */
static char *nproxy_runner = NULL;

/* Node.js binary path */
static char *node_bin = NULL;

/* nproxy.js path */
static char *nproxy_js = NULL;

/* Pre-allocated environ for fork() child — avoids malloc in vfork/COW child */
static char *fork_new_environ[512];
static char fork_node_opts[4096];
static int fork_env_prepared = 0;

/* environ for execvp */
extern char **environ;

static void init(void) {
    if (initialized) return;
    initialized = 1;

    const char *val;

    val = getenv("NPROXY_LD_VERBOSE");
    verbose = (val && val[0] == '1');

    val = getenv("NPROXY_LD_TARGETS");
    if (val && val[0]) {
        char *copy = strdup(val);
        char *save;
        char *tok = strtok_r(copy, ",", &save);
        while (tok) {
            ntargets++;
            targets = realloc(targets, ntargets * sizeof(char*));
            targets[ntargets - 1] = strdup(tok);
            tok = strtok_r(NULL, ",", &save);
        }
        free(copy);
    }

    val = getenv("NPROXY_LD_NPROXY");
    if (val && val[0]) {
        nproxy_runner = strdup(val);
    } else {
        /* Auto-detect: look alongside this shared library or in default locations */
        Dl_info info;
        char *libdir = NULL;
        if (dladdr((void*)init, &info) && info.dli_fname) {
            char *libpath = strdup(info.dli_fname);
            libdir = dirname(libpath);
            /* nproxy-run.sh */
            char *rp = malloc(strlen(libdir) + 32);
            sprintf(rp, "%s/../nproxy-run.sh", libdir);
            if (access(rp, X_OK) == 0) {
                nproxy_runner = rp;
            } else {
                free(rp);
                nproxy_runner = strdup("nproxy-run.sh");
            }
            /* nproxy.js (always try to resolve even if runner exists) */
            char *jp = malloc(strlen(libdir) + 32);
            sprintf(jp, "%s/../node/nproxy.js", libdir);
            if (access(jp, R_OK) == 0) {
                nproxy_js = jp;
            } else {
                free(jp);
            }
            free(libpath);
        } else {
            nproxy_runner = strdup("nproxy-run.sh");
        }
    }

    /* Find Node.js */
    node_bin = getenv("NPROXY_LD_NODE");
    if (!node_bin || !node_bin[0]) {
        node_bin = getenv("NODE");
    }
    if (!node_bin || !node_bin[0]) {
        /* Search PATH for node */
        const char *path = getenv("PATH");
        if (path) {
            char *path_copy = strdup(path);
            char *save;
            char *dir = strtok_r(path_copy, ":", &save);
            while (dir) {
                char *tmp = malloc(strlen(dir) + 16);
                sprintf(tmp, "%s/node", dir);
                if (access(tmp, X_OK) == 0) {
                    node_bin = tmp;
                    break;
                }
                free(tmp);
                dir = strtok_r(NULL, ":", &save);
            }
            free(path_copy);
        }
        if (!node_bin || !node_bin[0]) {
            node_bin = strdup("/usr/bin/node");
        }
    }

    if (verbose) {
        fprintf(stderr, "[nproxy_ld] init: targets=%s runner=%s node=%s\n",
            getenv("NPROXY_LD_TARGETS") ?: "(all)",
            nproxy_runner ?: "(none)",
            node_bin ?: "(none)");
    }
}

static int should_wrap(const char *pathname) {
    if (!pathname) return 0;
    if (getenv("NPROXY_LD_ACTIVE")) return 0;

    if (ntargets == 0) return 1; /* no targets = wrap all */

    char *base = strdup(pathname);
    char *bname = basename(base);
    for (int i = 0; i < ntargets; i++) {
        if (strcmp(bname, targets[i]) == 0) {
            free(base);
            return 1;
        }
    }
    free(base);
    return 0;
}

static int count_env(char *const envp[]) {
    int n = 0;
    if (envp) while (envp[n]) n++;
    return n;
}

static int is_node_target(const char *pathname) {
    if (!pathname) return 0;
    const char *ext = strrchr(pathname, '.');
    if (ext && (strcmp(ext, ".js") == 0 || strcmp(ext, ".mjs") == 0 || strcmp(ext, ".cjs") == 0))
        return 1;
    /* Check basename for "node" */
    char *base = strdup(pathname);
    char *bname = basename(base);
    if (strcmp(bname, "node") == 0 || strcmp(bname, "nodejs") == 0) {
        free(base);
        return 1;
    }
    free(base);
    /* Check shebang for node */
    FILE *f = fopen(pathname, "r");
    if (f) {
        char buf[128];
        if (fgets(buf, sizeof(buf), f) && strstr(buf, "node")) {
            fclose(f);
            return 1;
        }
        fclose(f);
    }
    return 0;
}

static int get_heap_mb(void) {
    const char *val = getenv("NPROXY_HEAP_MB");
    if (val && val[0]) {
        int n = atoi(val);
        if (n > 0) return n;
    }
    return 8192;
}

/*
 * Build the pre-allocated environ used by the fork() hook.
 * Called from fork() in the PARENT context (safe to allocate).
 */
static void prepare_fork_env(void) {
    if (fork_env_prepared) return;
    fork_env_prepared = 1;

    int heap_mb = get_heap_mb();
    if (nproxy_js) {
        snprintf(fork_node_opts, sizeof(fork_node_opts),
            "NODE_OPTIONS=--expose-gc --max-old-space-size=%d -r %s",
            heap_mb, nproxy_js);
    } else {
        snprintf(fork_node_opts, sizeof(fork_node_opts),
            "NODE_OPTIONS=--expose-gc --max-old-space-size=%d",
            heap_mb);
    }

    int j = 0;
    for (int i = 0; environ[i] && i < 500; i++) {
        /* Only filter LD_PRELOAD to prevent infinite recursion.
           Preserve NPROXY_LD_ACTIVE so the guard in should_wrap() works. */
        if (strncmp(environ[i], "LD_PRELOAD=", 11) == 0)
            continue;
        fork_new_environ[j++] = environ[i];
    }
    fork_new_environ[j++] = fork_node_opts;
    fork_new_environ[j] = NULL;
}

__attribute__((constructor))
static void early_init(void) {
    real_fork = dlsym(RTLD_NEXT, "fork");
}

/*
 * Intercept fork() to inject NODE_OPTIONS via environ in the child.
 *
 * This catches runtimes (Bun, Deno, Go) that use fork→vfork→inline_execve
 * where execve/execvp hooks cannot reach (no libc execve call).
 *
 * Guard: when NPROXY_LD_ACTIVE is already set in environ, skip environ
 * swap entirely — the parent already has proper injection from a previous
 * level. This prevents double injection when NPROXY_LD_ACTIVE propagates.
 *
 * Safe because fork() uses COW — child's environ pointer swap does not
 * affect the parent's address space (unlike vfork where memory is shared).
 */
pid_t fork(void) {
    if (!real_fork) real_fork = dlsym(RTLD_NEXT, "fork");
    init();
    pid_t pid = real_fork();
    if (pid == 0 && !getenv("NPROXY_LD_ACTIVE")) {
        prepare_fork_env();
        environ = fork_new_environ;
    }
    return pid;
}

static char *resolve_path(const char *file) {
    if (!file) return NULL;
    if (file[0] == '/') return strdup(file);
    const char *path_env = getenv("PATH");
    if (!path_env) return NULL;
    char *path_copy = strdup(path_env);
    char *save;
    char *dir = strtok_r(path_copy, ":", &save);
    while (dir) {
        char *full = malloc(strlen(dir) + strlen(file) + 2);
        sprintf(full, "%s/%s", dir, file);
        if (access(full, X_OK) == 0) {
            free(path_copy);
            return full;
        }
        free(full);
        dir = strtok_r(NULL, ":", &save);
    }
    free(path_copy);
    return NULL;
}

/*
 * Inject NODE_OPTIONS for Node.js targets.
 * For non-Node targets, redirect to nproxy-run.sh --pty.
 */
static int handle_execve(const char *pathname, char *const argv[], char *const envp[]) {
    if (!should_wrap(pathname)) return 0;

    if (verbose) {
        fprintf(stderr, "[nproxy_ld] intercepting execve(%s)\n", pathname ? pathname : "?");
    }

    if (is_node_target(pathname)) {
        /* For Node targets: inject NODE_OPTIONS */
        int n = count_env(envp);
        char **new_envp = malloc((n + 5) * sizeof(char*));
        int j = 0;

        /* Copy original env, filtering out variables we'll replace */
        for (int i = 0; i < n; i++) {
            if (strncmp(envp[i], "LD_PRELOAD=", 11) == 0 ||
                strncmp(envp[i], "NPROXY_LD_", 10) == 0 ||
                strncmp(envp[i], "NODE_OPTIONS=", 13) == 0)
                continue;
            new_envp[j++] = envp[i];
        }

        /* Build NODE_OPTIONS with nproxy.js */
        int heap_mb = get_heap_mb();
        char node_opts[4096];
        if (nproxy_js) {
            snprintf(node_opts, sizeof(node_opts),
                "NODE_OPTIONS=--expose-gc --max-old-space-size=%d -r %s",
                heap_mb, nproxy_js);
        } else {
            snprintf(node_opts, sizeof(node_opts),
                "NODE_OPTIONS=--expose-gc --max-old-space-size=%d",
                heap_mb);
        }
        new_envp[j++] = strdup(node_opts);
        new_envp[j++] = "NPROXY_LD_ACTIVE=1";
        new_envp[j] = NULL;

        if (verbose) fprintf(stderr, "[nproxy_ld] injected NODE_OPTIONS for %s\n", pathname);
        return real_execve(pathname, argv, new_envp);
    }

    /* Non-Node targets: wrap via nproxy-run.sh --pty */
    int orig_len = 0;
    if (argv) while (argv[orig_len]) orig_len++;

    int new_argc = 3 + orig_len + 1; /* nproxy-run.sh --pty real_binary [args] NULL */
    char **new_argv = malloc((new_argc + 1) * sizeof(char*));
    int pos = 0;

    new_argv[pos++] = nproxy_runner;
    new_argv[pos++] = "--pty";
    new_argv[pos++] = (char*)pathname;
    for (int i = 1; i < orig_len; i++)
        new_argv[pos++] = argv[i];
    new_argv[pos] = NULL;

    int n = count_env(envp);
    char **new_envp = malloc((n + 3) * sizeof(char*));
    int j = 0;
    for (int i = 0; i < n; i++) {
        if (strncmp(envp[i], "LD_PRELOAD=", 11) == 0 ||
            strncmp(envp[i], "NPROXY_LD_", 10) == 0)
            continue;
        new_envp[j++] = envp[i];
    }
    new_envp[j++] = "NPROXY_LD_ACTIVE=1";
    new_envp[j] = NULL;

    if (verbose) {
        fprintf(stderr, "[nproxy_ld] wrapping non-Node binary:");
        for (int i = 0; new_argv[i]; i++)
            fprintf(stderr, " %s", new_argv[i]);
        fprintf(stderr, "\n");
    }

    return real_execve(nproxy_runner, new_argv, new_envp);
}

/* ---- execve family interceptors ---- */

int execve(const char *pathname, char *const argv[], char *const envp[]) {
    if (!real_execve) real_execve = dlsym(RTLD_NEXT, "execve");
    init();

    if (!getenv("NPROXY_LD_ACTIVE") && should_wrap(pathname)) {
        int ret = handle_execve(pathname, argv, envp);
        if (ret != 0) return ret; /* if handle_execve succeeded, we won't reach here */
    }
    return real_execve(pathname, argv, envp);
}

int execvp(const char *file, char *const argv[]) {
    if (!real_execvp) real_execvp = dlsym(RTLD_NEXT, "execvp");
    init();
    if (!getenv("NPROXY_LD_ACTIVE") && should_wrap(file)) {
        char *resolved = resolve_path(file);
        if (resolved) {
            int ret = handle_execve(resolved, argv, environ);
            free(resolved);
            if (ret != 0) return ret;
        }
    }
    return real_execvp(file, argv);
}

int execvpe(const char *file, char *const argv[], char *const envp[]) {
    if (!real_execvpe) real_execvpe = dlsym(RTLD_NEXT, "execvpe");
    init();
    if (!getenv("NPROXY_LD_ACTIVE") && should_wrap(file)) {
        char *resolved = resolve_path(file);
        if (resolved) {
            int ret = handle_execve(resolved, argv, envp);
            free(resolved);
            if (ret != 0) return ret;
        }
    }
    return real_execvpe(file, argv, envp);
}

int execveat(int dirfd, const char *pathname, char *const argv[], char *const envp[], int flags) {
    if (!real_execveat) real_execveat = dlsym(RTLD_NEXT, "execveat");
    init();
    if (!getenv("NPROXY_LD_ACTIVE") && should_wrap(pathname)) {
        if (verbose) fprintf(stderr, "[nproxy_ld] execveat(%s) — pass through\n", pathname ?: "?");
    }
    return real_execveat(dirfd, pathname, argv, envp, flags);
}

int fexecve(int fd, char *const argv[], char *const envp[]) {
    if (!real_fexecve) real_fexecve = dlsym(RTLD_NEXT, "fexecve");
    init();
    if (verbose) fprintf(stderr, "[nproxy_ld] fexecve(%d) — pass through\n", fd);
    return real_fexecve(fd, argv, envp);
}
