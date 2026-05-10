use std::process::ExitStatus;
use tokio::process::{Child, Command};
use tracing::debug;

/// Spawn the child command with piped stdio.
pub fn spawn(cmd: &str, args: &[String]) -> std::io::Result<Child> {
    debug!("spawning child: {} {:?}", cmd, args);

    let child = Command::new(cmd)
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()?;

    Ok(child)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_spawn_nonexistent_command() {
        // Should fail gracefully for a command that doesn't exist
        let result = spawn("/nonexistent/bin/foo", &[]);
        assert!(result.is_err(), "expected Err for nonexistent command");
    }

    #[tokio::test]
    async fn test_spawn_echo_and_exit_code() {
        // /bin/echo exits 0
        let mut child = spawn("/bin/echo", &["hello".to_string()]).expect("spawn echo");
        let status = child.wait().await.expect("wait echo");
        assert!(status.success(), "echo should exit 0");
    }

    #[tokio::test]
    async fn test_spawn_false_exits_nonzero() {
        let mut child = spawn("/usr/bin/false", &[]).unwrap_or_else(|_| {
            spawn("false", &[]).expect("spawn false")
        });
        let status = child.wait().await.expect("wait false");
        assert!(!status.success(), "false should exit non-zero");
    }
}

/// Wait for the child to exit and return the exit status.
pub async fn wait_for_exit(mut child: Child) -> std::io::Result<ExitStatus> {
    child.wait().await
}
