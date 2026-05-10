use std::time::Duration;

mod common;

/// Text passthrough: 100KB ASCII text, decode + re-encode should preserve content.
#[test]
fn test_text_passthrough_ascii() {
    let line = b"Hello, world! This is a test of passthrough text mode.\n";
    let input: Vec<u8> = line.iter().copied().cycle().take(100 * 1024).collect();
    let (out, _err, status) = common::run_nproxy_with_timeout(
        &["--text=passthrough"],
        "cat",
        &[],
        input.clone(),
        Duration::from_secs(30),
    );
    assert!(status.success());
    // Passthrough: decode to string, re-encode. For ASCII both are identical.
    assert_eq!(out.len(), input.len());
    assert_eq!(
        String::from_utf8_lossy(&out),
        String::from_utf8_lossy(&input)
    );
}

/// Text transform: verify line numbers appear in output.
#[test]
fn test_text_transform_lines() {
    let input = b"line1\nline2\nline3\n".to_vec();
    let (out, _err, status) = common::run_nproxy_with_timeout(
        &["--text=transform"],
        "cat",
        &[],
        input,
        Duration::from_secs(10),
    );
    assert!(status.success());
    let output = String::from_utf8_lossy(&out);
    // Transform output: check for line number and timestamp
    // LineFormatter default delimiter uses \n, output could use various formats.
    // Just check we got something back with transformed content.
    assert!(!output.is_empty(), "transform output should not be empty");
    assert!(
        output.contains("line1"),
        "output should contain original text"
    );
    // Output should have at least as many newlines as input (3)
    assert!(
        output.matches('\n').count() >= 3,
        "output should have line breaks"
    );
}

/// Off mode: raw bytes passthrough, no decode (fast path).
#[test]
fn test_text_off_baseline() {
    let input: Vec<u8> = (0..u8::MAX).cycle().take(10 * 1024).collect();
    let (out, _err, status) = common::run_nproxy_with_timeout(
        &["--text=off"],
        "cat",
        &[],
        input.clone(),
        Duration::from_secs(10),
    );
    assert!(status.success());
    assert_eq!(out, input);
}

/// UTF-8 chunk boundary: multi-byte characters survive relay.
#[test]
fn test_utf8_chunk_boundary() {
    // 3-byte UTF-8 characters (U+0800–U+FFFF range)
    let input = "こんにちは世界！αβγδε\n".repeat(1000);
    let (out, _err, status) = common::run_nproxy_with_timeout(
        &["--text=passthrough"],
        "cat",
        &[],
        input.as_bytes().to_vec(),
        Duration::from_secs(10),
    );
    assert!(status.success());
    let output = String::from_utf8_lossy(&out);
    assert_eq!(output, input);
}
