use std::process::ExitStatus;
use tokio::process::{Child, Command};
use tracing::debug;

/// Spawn the child command with piped stdio.
pub fn spawn(cmd: &str, args: &[String]) -> std::io::Result<Child> {
    debug!("spawning child: {} {:?}", cmd, args);

    let child = Command::new(cmd)
        .args(args)
        .stdin(std::process::Stdio::inherit())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()?;

    Ok(child)
}

/// Open a new PTY pair. Returns (master_fd, slave_path). Unix only.
#[cfg(unix)]
pub fn open_pty() -> std::io::Result<(std::fs::File, String)> {
    use std::os::fd::FromRawFd;

    // SAFETY: posix_openpt, grantpt, unlockpt are safe with valid flags.
    let master_fd = unsafe { libc::posix_openpt(libc::O_RDWR | libc::O_CLOEXEC) };
    if master_fd < 0 {
        return Err(std::io::Error::last_os_error());
    }

    unsafe {
        if libc::grantpt(master_fd) < 0 {
            return Err(std::io::Error::last_os_error());
        }
        if libc::unlockpt(master_fd) < 0 {
            return Err(std::io::Error::last_os_error());
        }
    }

    let slave_name = unsafe {
        let ptr = libc::ptsname(master_fd);
        if ptr.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        std::ffi::CStr::from_ptr(ptr).to_string_lossy().into_owned()
    };

    let master_file = unsafe { std::fs::File::from_raw_fd(master_fd) };
    Ok((master_file, slave_name))
}

/// Spawn the child command with a PTY instead of pipes. Unix only.
#[cfg(unix)]
pub fn spawn_pty(cmd: &str, args: &[String]) -> std::io::Result<(Child, std::fs::File)> {
    use std::os::fd::FromRawFd;

    debug!("spawning child with pty: {} {:?}", cmd, args);

    let (master_file, slave_name) = open_pty()?;

    // Open slave fd for child's stdio
    let slave_fd = unsafe {
        let fd = libc::open(
            slave_name.as_ptr() as *const std::os::raw::c_char,
            libc::O_RDWR | libc::O_CLOEXEC,
        );
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        fd
    };

    // SAFETY: we just opened slave_fd, it's valid.
    let slave = unsafe { std::fs::File::from_raw_fd(slave_fd) };
    let slave_stdin = slave.try_clone()?;
    let slave_stderr = slave.try_clone()?;

    let child = Command::new(cmd)
        .args(args)
        .stdin(slave_stdin)
        .stdout(slave.try_clone()?)
        .stderr(slave_stderr)
        .spawn()?;

    Ok((child, master_file))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_spawn_nonexistent_command() {
        let result = spawn("/nonexistent/bin/foo", &[]);
        assert!(result.is_err(), "expected Err for nonexistent command");
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn test_spawn_echo_and_exit_code() {
        let mut child = spawn("/bin/echo", &["hello".to_string()]).expect("spawn echo");
        let status = child.wait().await.expect("wait echo");
        assert!(status.success(), "echo should exit 0");
    }

    #[tokio::test]
    #[cfg(windows)]
    async fn test_spawn_echo_and_exit_code() {
        let mut child = spawn("cmd", &["/c".to_string(), "echo".to_string(), "hello".to_string()])
            .expect("spawn echo");
        let status = child.wait().await.expect("wait echo");
        assert!(status.success(), "echo should exit 0");
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn test_spawn_false_exits_nonzero() {
        let mut child = spawn("/usr/bin/false", &[]).unwrap_or_else(|_| {
            spawn("false", &[]).expect("spawn false")
        });
        let status = child.wait().await.expect("wait false");
        assert!(!status.success(), "false should exit non-zero");
    }

    #[tokio::test]
    #[cfg(windows)]
    async fn test_spawn_false_exits_nonzero() {
        // On Windows, use cmd /c exit 1 to simulate a non-zero exit
        let mut child = spawn("cmd", &["/c".to_string(), "exit".to_string(), "1".to_string()])
            .expect("spawn false");
        let status = child.wait().await.expect("wait false");
        assert!(!status.success(), "exit 1 should exit non-zero");
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn test_open_pty_works() {
        let (master, slave_path) = open_pty().expect("open_pty");
        assert!(!slave_path.is_empty(), "slave path should not be empty");
        assert!(slave_path.starts_with("/dev/pts/"), "slave path should be /dev/pts/N, got {}", slave_path);
        let _ = master; // master fd is closed on drop
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn test_spawn_pty_echo() {
        let (mut child, master_fd) = spawn_pty("/bin/echo", &["hello".to_string()])
            .expect("spawn_pty echo");
        // Read from master in background to unblock pty, then wait for child
        let _read_task = tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut master = tokio::fs::File::from_std(master_fd);
            let mut buf = vec![0u8; 4096];
            let _ = master.read(&mut buf).await;
        });
        let status = child.wait().await.expect("wait echo");
        assert!(status.success(), "pty echo should exit 0");
    }
}

/// Wait for the child to exit and return the exit status.
pub async fn wait_for_exit(mut child: Child) -> std::io::Result<ExitStatus> {
    child.wait().await
}
