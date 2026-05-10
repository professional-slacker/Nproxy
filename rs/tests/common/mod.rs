use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::Duration;

/// Path to the nproxy binary under test.
fn nproxy_bin() -> std::path::PathBuf {
    let mut p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("target");
    p.push("debug");
    p.push("nproxy");
    p
}

/// Run nproxy wrapping a child command, write to stdin, collect stdout.
pub fn run_nproxy(
    args: &[&str],
    child_cmd: &str,
    child_args: &[&str],
    stdin_data: Vec<u8>,
) -> std::io::Result<(Vec<u8>, Vec<u8>, std::process::ExitStatus)> {
    let mut cmd = Command::new(nproxy_bin());
    cmd.args(args);
    cmd.arg(child_cmd);
    cmd.args(child_args);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn()?;
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    // Write stdin data in a separate thread to avoid deadlock
    let stdin_handle = std::thread::spawn(move || {
        stdin.write_all(&stdin_data).ok();
    });

    // Read stdout and stderr concurrently
    let stdout_handle = std::thread::spawn(move || {
        let mut out = Vec::new();
        let mut reader = stdout;
        reader.read_to_end(&mut out).ok();
        out
    });

    let stderr_handle = std::thread::spawn(move || {
        let mut err = Vec::new();
        let mut reader = stderr;
        reader.read_to_end(&mut err).ok();
        err
    });

    stdin_handle.join().unwrap();
    let out = stdout_handle.join().unwrap();
    let err = stderr_handle.join().unwrap();
    let status = child.wait()?;

    Ok((out, err, status))
}

/// Run nproxy with timeout. Panics if timeout exceeded.
pub fn run_nproxy_with_timeout(
    args: &[&str],
    child_cmd: &str,
    child_args: &[&str],
    stdin_data: Vec<u8>,
    timeout: Duration,
) -> (Vec<u8>, Vec<u8>, std::process::ExitStatus) {
    let mut cmd = Command::new(nproxy_bin());
    cmd.args(args);
    cmd.arg(child_cmd);
    cmd.args(child_args);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().expect("failed to spawn nproxy");
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    let stdin_handle = std::thread::spawn(move || {
        stdin.write_all(&stdin_data).ok();
    });

    let stdout_handle = std::thread::spawn(move || {
        let mut out = Vec::new();
        let mut reader = stdout;
        reader.read_to_end(&mut out).ok();
        out
    });

    let stderr_handle = std::thread::spawn(move || {
        let mut err = Vec::new();
        let mut reader = stderr;
        reader.read_to_end(&mut err).ok();
        err
    });

    stdin_handle.join().unwrap();

    // Wait with timeout
    let start = std::time::Instant::now();
    let mut out: Vec<u8> = Vec::new();
    let mut err: Vec<u8> = Vec::new();
    loop {
        if start.elapsed() > timeout {
            let _ = child.kill();
            panic!("nproxy timed out after {:?}", timeout);
        }
        if stdout_handle.is_finished() && stderr_handle.is_finished() {
            out = stdout_handle.join().unwrap();
            err = stderr_handle.join().unwrap();
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }

    let status = child.wait().expect("failed to wait for child");
    (out, err, status)
}
