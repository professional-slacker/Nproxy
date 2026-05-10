use std::time::Duration;

mod common;

/// Test 1: stdin echo small — 28B text relayed to `cat` with default (--text=off).
#[test]
fn test_stdin_echo_small() {
    let input = b"hello world, nproxy here!\n".to_vec();
    let (out, _err, status) = common::run_nproxy(
        &[], // no text mode
        "cat",
        &[],
        input.clone(),
    )
    .expect("nproxy failed");
    assert!(status.success());
    assert_eq!(out, input);
}

/// Test 2: stdin echo 50KB binary passthrough (moderate size for unit test).
#[test]
fn test_stdin_echo_50kb() {
    let input: Vec<u8> = (0..u8::MAX).cycle().take(50 * 1024).collect();
    let (out, _err, status) = common::run_nproxy_with_timeout(
        &[],
        "cat",
        &[],
        input.clone(),
        Duration::from_secs(30),
    );
    assert!(status.success());
    assert_eq!(out.len(), input.len());
    assert_eq!(out, input);
}

/// Test 3: big stdout — child generates 200KB output (moderate for unit test).
#[test]
fn test_big_stdout() {
    let child_args = vec!["if=/dev/zero", "bs=1024", "count=200", "status=none"];
    let (out, _err, status) = common::run_nproxy_with_timeout(
        &[],
        "dd",
        &child_args,
        b"dummy\n".to_vec(),
        Duration::from_secs(30),
    );
    assert!(status.success());
    assert_eq!(out.len(), 200 * 1024);
}

/// Test 4: ANSI passthrough — control codes survive intact.
#[test]
fn test_ansi_passthrough() {
    // ANSI escape: red text, green text, reset
    let input = b"\x1b[31mRED\x1b[32mGREEN\x1b[0m\n".to_vec();
    let (out, _err, status) = common::run_nproxy(&[], "cat", &[], input.clone()).expect("nproxy failed");
    assert!(status.success());
    assert_eq!(out, input);
}

/// Test 5: stderr mix — child writes to both stdout and stderr.
#[test]
fn test_stderr_mix() {
    // Use a shell one-liner that writes to both stdout and stderr
    let child_cmd = "sh";
    let child_args = ["-c", "echo out1; echo err1 >&2; echo out2; echo err2 >&2"];
    let (out, err, status) = common::run_nproxy(&[], child_cmd, &child_args, vec![])
        .expect("nproxy failed");
    assert!(status.success());
    assert_eq!(String::from_utf8_lossy(&out), "out1\nout2\n");
    // stderr will contain nproxy startup log message, verify child stderr reaches end
    assert!(String::from_utf8_lossy(&err).contains("err1"));
    assert!(String::from_utf8_lossy(&err).contains("err2"));
}

/// Test 6: FS huge to stdout — read 1MB from /dev/zero.
#[test]
fn test_fs_huge_to_stdout() {
    let (out, _err, status) = common::run_nproxy_with_timeout(
        &[],
        "dd",
        &["if=/dev/zero", "bs=4096", "count=256", "status=none"],
        vec![],
        Duration::from_secs(30),
    );
    assert!(status.success());
    assert_eq!(out.len(), 256 * 4096); // 1MB
}
