use std::os::fd::{AsRawFd, FromRawFd};
use std::process::ExitCode;
use std::sync::Arc;
use clap::Parser;
use tokio::signal::unix::{signal, SignalKind};
use tracing::{debug, info, warn};
use tracing_subscriber::EnvFilter;

/// Send a signal to a child process by PID. Used in signal relay.
fn kill_child(pid: u32, sig: i32) {
    if pid == 0 {
        return;
    }
    // SAFETY: pid is a valid child PID from Child::id(), sig is a standard POSIX signal.
    let rc = unsafe { libc::kill(pid as i32, sig) };
    if rc != 0 {
        let err = std::io::Error::last_os_error();
        debug!("kill(pid={}, sig={}) failed: {}", pid, sig, err);
    }
}

pub mod child;
pub mod memory;
pub mod observer;
pub mod relay;
pub mod text;

#[derive(Parser, Debug)]
#[command(name = "nproxy", version, disable_help_flag = true)]
struct Cli {
    #[arg(long = "text", default_value = "off")]
    text: String,

    #[arg(long = "text-log")]
    text_log: Option<String>,

    #[arg(long = "memory-pressure", default_value = "512")]
    memory_pressure: u64,

    #[arg(long = "memory-critical", default_value = "1024")]
    memory_critical: u64,

    #[arg(long = "pty")]
    pty: bool,

    #[arg(required = true)]
    cmd: String,

    #[arg(allow_hyphen_values = true, trailing_var_arg = true)]
    args: Vec<String>,
}

fn init_tracing() {
    if std::env::var("NPROXY_DEBUG").is_err() {
        return;
    }
    let _ = tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::new("nproxy=debug"))
        .with_writer(std::io::stderr)
        .try_init();
}

#[tokio::main]
async fn main() -> ExitCode {
    init_tracing();

    let cli = Cli::parse();
    let app = cli.cmd;
    let app_args = cli.args;

    let text_mode: text::TextMode = match cli.text.parse() {
        Ok(m) => m,
        Err(()) => {
            eprintln!(
                "nproxy: invalid --text mode '{}' (expected: off | passthrough | transform | tee)",
                cli.text
            );
            return ExitCode::from(1);
        }
    };

    let is_debug = std::env::var("NPROXY_DEBUG").is_ok();
    info!("nproxy: cmd={} args={:?} text={} debug={}", app, app_args, text_mode, is_debug);

    if !is_debug {
        eprintln!("nproxy: cmd={} args={:?} text={}", app, app_args, text_mode);
    }

    // --- Spawn child ---
    let use_pty = cli.pty;
    let mut child: tokio::process::Child;
    let mut pty_master: Option<std::fs::File> = None;

    if use_pty {
        let (c, master_fd) = match child::spawn_pty(&app, &app_args) {
            Ok((c, fd)) => (c, fd),
            Err(e) => {
                eprintln!("nproxy: failed to spawn child with pty '{}': {}", app, e);
                return ExitCode::from(1);
            }
        };
        child = c;
        pty_master = Some(master_fd);
    } else {
        child = match child::spawn(&app, &app_args) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("nproxy: failed to spawn child '{}': {}", app, e);
                return ExitCode::from(1);
            }
        };
    }

    // --- Shared observer ---
    let observer = Arc::new(tokio::sync::RwLock::new(observer::Observer::new()));

    // --- Memory policy ---
    let child_pid = child.id().unwrap_or(0);
    let mut mem_policy = memory::MemoryPolicy::new(
        child_pid,
        cli.memory_pressure,
        cli.memory_critical,
    );

    // --- Text pipeline (create BEFORE relays so we can clone mem_rx for backpressure) ---
    let (mem_tx, mem_rx_text) = tokio::sync::watch::channel(memory::MemState::Normal);
    let (_, mem_rx_throttle) = tokio::sync::watch::channel(memory::MemState::Normal);
    let text_pipeline: Option<Arc<tokio::sync::RwLock<text::TextPipeline>>> = if text_mode == text::TextMode::Off {
        None
    } else {
        Some(Arc::new(tokio::sync::RwLock::new(text::TextPipeline::new(
            text_mode,
            cli.text_log.clone(),
            mem_rx_text,
        ))))
    };

    // --- Signal relay: forward SIGINT/SIGTERM/SIGHUP to child ---
    let mut sigint = match signal(SignalKind::interrupt()) {
        Ok(s) => s,
        Err(e) => {
            warn!("failed to set up SIGINT handler: {}", e);
            return ExitCode::from(1);
        }
    };
    let mut sigterm = match signal(SignalKind::terminate()) {
        Ok(s) => s,
        Err(e) => {
            warn!("failed to set up SIGTERM handler: {}", e);
            return ExitCode::from(1);
        }
    };
    let mut sighup = match signal(SignalKind::hangup()) {
        Ok(s) => s,
        Err(e) => {
            warn!("failed to set up SIGHUP handler: {}", e);
            return ExitCode::from(1);
        }
    };
    let _signal_join = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = sigint.recv() => {
                    debug!("received SIGINT, forwarding to child pid={}", child_pid);
                    kill_child(child_pid, libc::SIGINT);
                }
                _ = sigterm.recv() => {
                    debug!("received SIGTERM, forwarding to child pid={}", child_pid);
                    kill_child(child_pid, libc::SIGTERM);
                }
                _ = sighup.recv() => {
                    debug!("received SIGHUP, forwarding to child pid={}", child_pid);
                    kill_child(child_pid, libc::SIGHUP);
                }
            }
        }
    });

    if use_pty {
        // --- PTY mode: bidirectional relay via master fd ---
        // Convert std::fs::File to tokio::fs::File for async I/O.
        // Dup the fd so we have separate read/write handles.
        let master_file = pty_master.take().expect("pty_master should be Some");
        let raw_fd = master_file.as_raw_fd();
        let read_fd = unsafe { libc::dup(raw_fd) };
        if read_fd < 0 {
            eprintln!("nproxy: FATAL - failed to dup pty master fd");
            return ExitCode::from(1);
        }
        // SAFETY: read_fd and raw_fd are both valid independent fds.
        let master_read = tokio::fs::File::from_std(unsafe { std::fs::File::from_raw_fd(read_fd) });
        let master_write = tokio::fs::File::from_std(master_file);

        // Reader: child stdout -> our stdout (with optional text transform)
        let obs_reader = observer.clone();
        let pipe_text = text_pipeline.clone();
        let rx_throttle = mem_rx_throttle.clone();
        let pty_read_join = tokio::spawn(async move {
            if let Some(ref pipe) = pipe_text {
                relay::spawn_text_relay(
                    master_read,
                    tokio::io::stdout(),
                    obs_reader,
                    Some(pipe.clone()),
                    rx_throttle,
                )
                .await
                .ok();
            } else {
                relay::spawn_relay(
                    master_read,
                    tokio::io::stdout(),
                    obs_reader,
                    observer::IoKind::Stdout,
                    rx_throttle,
                )
                .await
                .ok();
            }
        });

        // Writer: our stdin -> child stdin
        let pty_write_join = tokio::spawn(async move {
            let mut stdin = tokio::io::stdin();
            let mut child_stdin = master_write;
            match tokio::io::copy(&mut stdin, &mut child_stdin).await {
                Ok(n) => debug!("pty stdin relay finished: {} bytes", n),
                Err(e) => warn!("pty stdin relay error: {}", e),
            }
            drop(child_stdin);
        });

        // --- Memory policy ticker ---
        let _mem_join = tokio::spawn(async move {
            loop {
                tokio::time::sleep(mem_policy.interval()).await;
                if mem_policy.tick() {
                    debug!("memory state changed: {:?}", mem_policy.state);
                    let _ = mem_tx.send(mem_policy.state);
                }
            }
        });

        // Wait for either side to finish (child will close pty on exit)
        let _ = tokio::join!(pty_read_join, pty_write_join);

        // Wait for child to exit
        let exit_status = child::wait_for_exit(child).await;
        match exit_status {
            Ok(status) => {
                let code = status.code().unwrap_or(1);
                return ExitCode::from(code as u8);
            }
            Err(e) => {
                eprintln!("nproxy: error waiting for child: {}", e);
                return ExitCode::from(1);
            }
        }
    }

    // --- Pipe mode (stdout/stderr relay) ---
    let child_stdout = match child.stdout.take() {
        Some(pipe) => pipe,
        None => {
            eprintln!("nproxy: FATAL - could not take child stdout pipe");
            return ExitCode::from(1);
        }
    };
    let child_stderr = match child.stderr.take() {
        Some(pipe) => pipe,
        None => {
            eprintln!("nproxy: FATAL - could not take child stderr pipe");
            return ExitCode::from(1);
        }
    };

    // --- Pipe mode: stdout relay (text-aware) ---
    let obs = observer.clone();
    let stdout_join = if let Some(ref pipe) = text_pipeline {
        relay::spawn_text_relay(
            child_stdout,
            tokio::io::stdout(),
            obs,
            Some(pipe.clone()),
            mem_rx_throttle.clone(),
        )
    } else {
        relay::spawn_relay(
            child_stdout,
            tokio::io::stdout(),
            obs,
            observer::IoKind::Stdout,
            mem_rx_throttle.clone(),
        )
    };

    // --- Pipe mode: stderr relay ---
    let obs = observer.clone();
    let stderr_join = relay::spawn_relay(
        child_stderr,
        tokio::io::stderr(),
        obs,
        observer::IoKind::Stderr,
        mem_rx_throttle.clone(),
    );

    // --- Memory policy ticker ---
    let _mem_join = tokio::spawn(async move {
        loop {
            tokio::time::sleep(mem_policy.interval()).await;
            if mem_policy.tick() {
                debug!("memory state changed: {:?}", mem_policy.state);
                let _ = mem_tx.send(mem_policy.state);
            }
        }
    });

    // --- Wait for stdout/stderr relays to finish ---
    if let Err(e) = stdout_join.await {
        warn!("stdout relay task failed: {}", e);
    }
    if let Err(e) = stderr_join.await {
        warn!("stderr relay task failed: {}", e);
    }

    // --- Wait for child to exit ---
    let exit_status = child::wait_for_exit(child).await;
    match exit_status {
        Ok(status) => {
            let code = status.code().unwrap_or(1);
            let obs = observer.read().await;
            info!(
                "nproxy completed: child exited code={} | relayed {}B stdin, {}B stdout, {}B stderr",
                code, obs.stdin_bytes, obs.stdout_bytes, obs.stderr_bytes
            );
            return ExitCode::from(code as u8);
        }
        Err(e) => {
            eprintln!("nproxy: error waiting for child: {}", e);
            return ExitCode::from(1);
        }
    }
}
