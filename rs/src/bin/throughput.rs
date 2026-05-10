/// nproxy throughput benchmark.
///
/// Usage:
///   cargo bench
///
/// Or run specific benchmark:
///   cargo bench -- "1gb passthrough"
///
/// These benchmarks measure the effective throughput of nproxy's relay
/// by piping data through the binary as a subprocess with `cat` as child.

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const NPROXY_BIN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/target/release/nproxy");

struct BenchResults {
    label: &'static str,
    size_bytes: u64,
    elapsed: Duration,
}

impl BenchResults {
    fn throughput_mbps(&self) -> f64 {
        let secs = self.elapsed.as_secs_f64();
        if secs > 0.0 {
            (self.size_bytes as f64 / secs) / (1024.0 * 1024.0)
        } else {
            0.0
        }
    }

    fn print(&self) {
        let mbps = self.throughput_mbps();
        let size_mb = self.size_bytes as f64 / (1024.0 * 1024.0);
        println!(
            "  {:<40} {:>8.2} MB in {:>6.2}s = {:>8.2} MB/s",
            self.label, size_mb, self.elapsed.as_secs_f64(), mbps
        );
    }
}

fn bench_nproxy(args: &[&str], child_cmd: &str, child_args: &[&str], data: &[u8]) -> BenchResults {
    let label = args.first().copied().unwrap_or("off");
    let label = format!("{label} ({})", child_cmd);

    let start = Instant::now();

    let mut cmd = Command::new(NPROXY_BIN);
    cmd.args(args);
    cmd.arg(child_cmd);
    cmd.args(child_args);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::null());

    let mut child = cmd.spawn().expect("failed to spawn nproxy");
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();

    // Write data in a thread
    let data = data.to_vec();
    let data_len = data.len();
    let data_for_write = data.clone();
    let write_handle = std::thread::spawn(move || {
        stdin.write_all(&data_for_write).ok();
    });

    // Read all stdout
    let read_handle = std::thread::spawn(move || {
        let mut out = Vec::with_capacity(data_len);
        let mut reader = stdout;
        reader.read_to_end(&mut out).ok();
        out
    });

    write_handle.join().unwrap();
    let out = read_handle.join().unwrap();
    let _status = child.wait().expect("failed to wait");

    let elapsed = start.elapsed();

    BenchResults {
        label: Box::leak(label.into_boxed_str()),
        size_bytes: data_len as u64,
        elapsed,
    }
}

fn main() {
    // Build release binary first
    let status = Command::new("cargo")
        .args(["build", "--release", "-q"])
        .status()
        .expect("failed to build release binary");
    assert!(status.success(), "release build failed");

    println!("\nnproxy throughput benchmarks (release build)\n");
    println!("  Target: {} MB/s (Node.js baseline)\n", 837);

    // --- 1GB passthrough (--text=off) ---
    println!("--- 1GB benchmarks ---");
    let one_gb: Vec<u8> = vec![b'X'; 1024 * 1024 * 1024];

    let r = bench_nproxy(&["--text=off"], "cat", &[], &one_gb);
    r.print();

    let r = bench_nproxy(&["--text=passthrough"], "cat", &[], &one_gb);
    r.print();

    // --- 5GB passthrough ---
    println!("\n--- 5GB benchmarks ---");

    // For 5GB, use dd as child to generate data (no large Vec needed)
    let start = Instant::now();
    let mut cmd = Command::new(NPROXY_BIN);
    cmd.args(["--text=off"]);
    cmd.arg("dd");
    cmd.args(["if=/dev/zero", "bs=1M", "count=5120", "status=none"]);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::null());

    let mut child = cmd.spawn().expect("5GB off spawn failed");
    let stdout = child.stdout.take().unwrap();
    let read_handle = std::thread::spawn(move || {
        let mut out: Vec<u8> = Vec::new();
        let mut reader = stdout;
        reader.read_to_end(&mut out).ok();
        out.len()
    });
    let bytes_read = read_handle.join().unwrap();
    let elapsed = start.elapsed();
    let status = child.wait().expect("5GB off wait failed");

    let secs = elapsed.as_secs_f64();
    let mbps = (bytes_read as f64 / secs) / (1024.0 * 1024.0);
    println!(
        "  {:<40} {:>8} MB in {:>6.2}s = {:>8.2} MB/s",
        format!("off (dd 5GB)"),
        bytes_read / (1024 * 1024),
        secs,
        mbps
    );
    assert!(status.success());

    // --- Text transform 1GB (via nproxy relay) ---
    println!("\n--- Text transform benchmarks ---");
    text_transform_passthrough_1gb();
}

fn text_transform_passthrough_1gb() {
    let data: Vec<u8> = b"Hello, world! This is a line of text for nproxy transform benchmark. Line 00000\n"
        .iter()
        .copied()
        .cycle()
        .take(1024 * 1024 * 1024) // 1GB
        .collect();

    let start = Instant::now();
    let mut cmd = Command::new(NPROXY_BIN);
    cmd.args(["--text=passthrough"]);
    cmd.arg("cat");
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::null());

    let mut child = cmd.spawn().expect("passthrough 1GB spawn failed");
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();

    let data_len = data.len();
    let write_handle = std::thread::spawn(move || {
        stdin.write_all(&data).ok();
    });
    let read_handle = std::thread::spawn(move || {
        let mut out = Vec::with_capacity(data_len);
        let mut reader = stdout;
        reader.read_to_end(&mut out).ok();
        out.len()
    });

    write_handle.join().unwrap();
    let bytes_read = read_handle.join().unwrap();
    let elapsed = start.elapsed();
    let _status = child.wait().expect("wait failed");

    let secs = elapsed.as_secs_f64();
    let mbps = (bytes_read as f64 / secs) / (1024.0 * 1024.0);
    println!(
        "  {:<40} {:>8} MB in {:>6.2}s = {:>8.2} MB/s",
        "passthrough (cat 1GB)", bytes_read / (1024 * 1024), secs, mbps
    );

    println!("\n--- Done ---");
}
