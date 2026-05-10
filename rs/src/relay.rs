use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::watch;
use tracing::debug;

use crate::memory::MemState;
use crate::observer::{IoKind, Observer};
use crate::text::TextPipeline;

/// A guard that gates `poll_read` based on memory state.
///
/// When the gate is closed (Pressure or Critical), `poll_read` returns
/// `Poll::Pending` and wakes the waker once the gate opens again (Normal).
/// This stops OS-level reads entirely, allowing the child's pipe buffer to
/// fill and naturally blocking the child's `write()` — true backpressure.
struct ReadGate<R> {
    inner: R,
    mem_rx: watch::Receiver<MemState>,
}

impl<R: AsyncRead + Unpin> AsyncRead for ReadGate<R> {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let state = *self.mem_rx.borrow();
        match state {
            MemState::Normal => {
                let inner = std::pin::Pin::new(&mut self.get_mut().inner);
                inner.poll_read(cx, buf)
            }
            MemState::Pressure | MemState::Critical => {
                // Spawn a helper that re-wakes us when state drops back to Normal
                let mut mem_rx = self.mem_rx.clone();
                let waker = cx.waker().clone();
                tokio::spawn(async move {
                    loop {
                        if *mem_rx.borrow() == MemState::Normal {
                            waker.wake();
                            return;
                        }
                        let _ = mem_rx.changed().await;
                    }
                });
                std::task::Poll::Pending
            }
        }
    }
}

impl<R: Unpin> Unpin for ReadGate<R> {}

/// Maximum bytes to write to a pipe in a single syscall.
/// Mirrors Linux default pipe capacity; keeps backpressure working
/// so downstream processes (cat, grep, etc.) don't accumulate buffers.
const PIPE_WRITE_BATCH: usize = 65536;

const BUF_SIZE: usize = 65536;

/// Relay data from `reader` to `writer`, recording each chunk via `observer`.
pub async fn relay<R, W>(
    mut reader: R,
    mut writer: W,
    observer: Arc<RwLock<Observer>>,
    kind: IoKind,
) -> std::io::Result<u64>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; BUF_SIZE];
    let mut total = 0u64;

    loop {
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n]).await?;
        observer.write().await.record(n, kind, Some(&buf[..n]));
        total += n as u64;
    }

    debug!("relay {}: total={} bytes", kind.label(), total);
    Ok(total)
}

/// Spawn a task that reads from stdin and writes to child_stdin.
/// When stdin reaches EOF, child_stdin is dropped, signalling EOF to the child.
pub fn spawn_stdin_relay(
    stdin: tokio::io::Stdin,
    child_stdin: tokio::process::ChildStdin,
    observer: Arc<RwLock<Observer>>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut buf = vec![0u8; BUF_SIZE];
        let (mut reader, mut writer) = (stdin, child_stdin);
        loop {
            let n = match reader.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) => {
                    debug!("stdin relay error: {}", e);
                    break;
                }
            };
            if let Err(e) = writer.write_all(&buf[..n]).await {
                debug!("stdin relay write error: {}", e);
                break;
            }
            observer.write().await.record(n, IoKind::Stdin, Some(&buf[..n]));
        }
    })
}

/// Spawn a task that relays data from `reader` to `writer`.
/// Applies backpressure by gating OS reads when child memory is high.
pub fn spawn_relay<R, W>(
    reader: R,
    writer: W,
    observer: Arc<RwLock<Observer>>,
    kind: IoKind,
    mem_rx: watch::Receiver<MemState>,
) -> tokio::task::JoinHandle<std::io::Result<u64>>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut buf = vec![0u8; BUF_SIZE];
        let mut reader = ReadGate { inner: reader, mem_rx };
        let mut writer = writer;
        let mut total = 0u64;

        loop {
            let n = match reader.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) => {
                    debug!("relay read error ({}): {}", kind.label(), e);
                    break;
                }
            };
            writer.write_all(&buf[..n]).await?;
            observer.write().await.record(n, kind, Some(&buf[..n]));
            total += n as u64;
        }

        debug!("relay {}: total={} bytes", kind.label(), total);
        Ok(total)
    })
}

/// Spawn a task that relays stdout through the text pipeline.
///
/// The text pipeline is accessed via `Arc<RwLock<TextPipeline>>`.
/// Each chunk is locked, processed, then the lock is released before writing.
/// Applies backpressure by gating OS reads when child memory is high.
pub fn spawn_text_relay<R, W>(
    reader: R,
    writer: W,
    observer: Arc<RwLock<Observer>>,
    text_pipeline: Option<Arc<RwLock<TextPipeline>>>,
    mem_rx: watch::Receiver<MemState>,
) -> tokio::task::JoinHandle<std::io::Result<u64>>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut buf = vec![0u8; BUF_SIZE];
        let mut total = 0u64;
        let mut reader = ReadGate { inner: reader, mem_rx };
        let mut writer = writer;

        loop {
            let n = match reader.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) => {
                    debug!("text relay read error: {}", e);
                    break;
                }
            };

            if let Some(ref pipe) = text_pipeline {
                // Quick snapshot: is the pipeline active?
                let effective = pipe.read().await.effective_mode();
                if effective == crate::text::TextMode::Off {
                    writer.write_all(&buf[..n]).await?;
                } else {
                    // Lock, process into a local buffer, then drop lock before write
                    let mut out_buf = Vec::new();
                    {
                        let mut p = pipe.write().await;
                        p.process_chunk(&buf[..n], &mut out_buf)?;
                    }
                    // Write in batches, draining each batch so the backing
                    // buffer shrinks incrementally.  Using drain(..) rather
                    // than chunks() ensures memory is released as we go,
                    // preventing RSS buildup when downstream is slow.
                    while !out_buf.is_empty() {
                        let n_write = out_buf.len().min(PIPE_WRITE_BATCH);
                        let batch: Vec<u8> = out_buf.drain(..n_write).collect();
                        writer.write_all(&batch).await?;
                    }
                }
            } else {
                writer.write_all(&buf[..n]).await?;
            }

            observer.write().await.record(n, IoKind::Stdout, Some(&buf[..n]));
            total += n as u64;
        }

        // Flush residual
        if let Some(ref pipe) = text_pipeline {
            let mut out_buf = Vec::new();
            {
                let mut p = pipe.write().await;
                p.flush(&mut out_buf)?;
            }
            if !out_buf.is_empty() {
                for batch in out_buf.chunks(PIPE_WRITE_BATCH) {
                    writer.write_all(batch).await?;
                }
            }
        }

        debug!("text_relay stdout: total={} bytes", total);
        Ok(total)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::MemState;
    use crate::text::TextMode;

    /// Basic relay: pipe data from one end to the other.
    #[tokio::test]
    async fn test_relay_basic() {
        let (mut tx, rx) = tokio::io::duplex(1024);
        let (mut wx, wy) = tokio::io::duplex(1024);
        let obs = Arc::new(RwLock::new(Observer::new()));

        let handle = tokio::spawn(async move {
            relay(rx, wy, obs.clone(), IoKind::Stdout).await
        });

        tx.write_all(b"hello world").await.unwrap();
        drop(tx); // drop writer so relay sees EOF

        let result = handle.await.unwrap().unwrap();
        assert_eq!(result, 11);

        let mut output = Vec::new();
        wx.read_to_end(&mut output).await.unwrap();
        assert_eq!(output, b"hello world");
    }

    /// Relay of an empty stream.
    #[tokio::test]
    async fn test_relay_empty() {
        let (tx, rx) = tokio::io::duplex(1024);
        let wy = tokio::io::sink(); // /dev/null writer
        let obs = Arc::new(RwLock::new(Observer::new()));

        let handle = tokio::spawn(async move {
            relay(rx, wy, obs.clone(), IoKind::Stdout).await
        });

        drop(tx); // close writer immediately

        let n = handle.await.unwrap().unwrap();
        assert_eq!(n, 0);
    }

    /// Spawned relay reads and writes.
    #[tokio::test]
    async fn test_spawn_relay() {
        let (mut tx, rx) = tokio::io::duplex(1024);
        let (mut wx, wy) = tokio::io::duplex(1024);
        let obs = Arc::new(RwLock::new(Observer::new()));
        let (_, mem_rx) = tokio::sync::watch::channel(MemState::Normal);

        let handle = spawn_relay(rx, wy, obs.clone(), IoKind::Stdout, mem_rx);

        tx.write_all(b"data").await.unwrap();
        drop(tx);

        handle.await.unwrap().unwrap();
        let mut output = Vec::new();
        wx.read_to_end(&mut output).await.unwrap();
        assert_eq!(output, b"data");
    }

    /// Spawned text relay without a text pipeline (passthrough).
    #[tokio::test]
    async fn test_text_relay_passthrough() {
        let (mut tx, rx) = tokio::io::duplex(1024);
        let (mut wx, wy) = tokio::io::duplex(1024);
        let obs = Arc::new(RwLock::new(Observer::new()));
        let (_, mem_rx) = tokio::sync::watch::channel(MemState::Normal);

        let handle = spawn_text_relay(rx, wy, obs.clone(), None, mem_rx);

        tx.write_all(b"hello text relay").await.unwrap();
        drop(tx);

        handle.await.unwrap().unwrap();
        let mut output = Vec::new();
        wx.read_to_end(&mut output).await.unwrap();
        assert_eq!(output, b"hello text relay");
    }

    /// Spawned text relay with a pipeline in Transform mode.
    #[tokio::test]
    async fn test_text_relay_with_pipeline() {
        use tokio::sync::watch;

        let (mut tx, rx) = tokio::io::duplex(65536);
        let (mut wx, wy) = tokio::io::duplex(65536);
        let obs = Arc::new(RwLock::new(Observer::new()));
        let (mem_tx, mem_rx) = watch::channel(MemState::Normal);
        let _ = mem_tx; // keep alive for the test scope
        let pipe = Arc::new(RwLock::new(TextPipeline::new(
            TextMode::Transform,
            None,
            mem_rx,
        )));

        let (_, mem_rx2) = tokio::sync::watch::channel(MemState::Normal);
        let handle = spawn_text_relay(rx, wy, obs.clone(), Some(pipe), mem_rx2);

        tx.write_all(b"hello world\nline two\n").await.unwrap();
        drop(tx);

        handle.await.unwrap().unwrap();
        let mut output = Vec::new();
        wx.read_to_end(&mut output).await.unwrap();
        // Transform mode processes newlines: output >= input (because of prefix)
        assert!(output.len() >= b"hello world\nline two\n".len());
        // Should see the prefix in output
        assert!(String::from_utf8_lossy(&output).contains("hello world"));
    }

}
