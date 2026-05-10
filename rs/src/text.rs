use std::io::Write;
use std::time::Instant;

use crate::memory::MemState;
use encoding_rs::Decoder;
use encoding_rs::UTF_8;
use tokio::sync::watch;

/// Hard limit on partial-line accumulation in LineFormatter.
/// When a chunk (or sequence of chunks without newlines) exceeds this,
/// the partial is flushed as a line regardless, preventing RSS blowup
/// on binary streams or very long lines (e.g. /dev/zero).
const PARTIAL_HARD_LIMIT: usize = 1_048_576; // 1 MiB

/// Text decode modes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TextMode {
    Off,
    Passthrough,
    Transform,
    Tee,
}

impl std::str::FromStr for TextMode {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "off" => Ok(Self::Off),
            "passthrough" => Ok(Self::Passthrough),
            "transform" => Ok(Self::Transform),
            "tee" => Ok(Self::Tee),
            _ => Err(()),
        }
    }
}

impl std::fmt::Display for TextMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Off => write!(f, "off"),
            Self::Passthrough => write!(f, "passthrough"),
            Self::Transform => write!(f, "transform"),
            Self::Tee => write!(f, "tee"),
        }
    }
}

/// Statistics for text decode operations (analogous to Node's TextObserver).
#[derive(Debug, Clone, Default)]
pub struct TextStatistics {
    pub total_chars: u64,
    pub total_lines: u64,
    pub decode_ns: u64,
    pub max_line_bytes: usize,
    pub forced_flushes: u64,
    pub mode_transitions: u64,
}

/// Chunk-safe UTF-8 decoder wrapping `encoding_rs::Decoder`.
///
/// Handles multi-byte sequences split across chunk boundaries, so a 3-byte
/// UTF-8 char that arrives as (1 + 2) bytes across two reads still decodes
/// correctly. This is the Rust equivalent of Node's `StringDecoder('utf8')`.
pub struct U8Decoder {
    decoder: Decoder,
    pending_bytes: usize,
    decode_ns: u128,
}

impl U8Decoder {
    pub fn new() -> Self {
        Self::default()
    }
}

impl Default for U8Decoder {
    fn default() -> Self {
        Self {
            decoder: UTF_8.new_decoder_without_bom_handling(),
            pending_bytes: 0,
            decode_ns: 0,
        }
    }
}

impl U8Decoder {
    /// Decode a byte chunk into a `String`.
    ///
    /// Returns the decoded string. Any incomplete multi-byte sequence at the
    /// end is buffered inside `encoding_rs::Decoder` and prepended to the
    /// next call. This matches Node's StringDecoder behavior.
    pub fn decode(&mut self, src: &[u8]) -> String {
        let start = Instant::now();
        self.pending_bytes = src.len();

        // Must reserve capacity before decode_to_string or it returns OutputFull.
        // max_utf8_buffer_length_without_replacement gives worst-case expansion.
        let max_len = self
            .decoder
            .max_utf8_buffer_length_without_replacement(src.len());
        let mut dst = String::new();
        if let Some(n) = max_len {
            dst.reserve(n);
        }
        let (_result, _read, _had_errors) = self.decoder.decode_to_string(src, &mut dst, false);

        self.decode_ns += start.elapsed().as_nanos();
        dst
    }

    /// Flush any remaining bytes (should only happen on EOF with truncated multi-byte).
    pub fn flush(&mut self) -> String {
        let start = Instant::now();
        let mut dst = String::new();
        if let Some(n) = self.decoder.max_utf8_buffer_length_without_replacement(0) {
            dst.reserve(n);
        }
        let (_result, _read, _had_errors) = self.decoder.decode_to_string(&[], &mut dst, true);
        self.decode_ns += start.elapsed().as_nanos();
        dst
    }

    pub fn pending(&self) -> usize {
        self.pending_bytes
    }
}

/// Formats lines with timestamp and line number prefix (for transform/tee modes).
///
/// Produces output like:
///   `[2026-05-09T12:34:56.789Z]       1 | hello`
///   `[2026-05-09T12:34:57.012Z]       2 | world`
#[derive(Default)]
pub struct LineFormatter {
    line_no: u64,
    max_line_bytes: usize,
    forced_flushes: u64,
    partial: String,
}

impl LineFormatter {
    pub fn new() -> Self {
        Self::default()
    }
}

impl LineFormatter {
    ///
    /// Lines are delimited by `\n`. Each complete line gets the timestamp+number
    /// prefix. A trailing partial line is buffered for the next `write` call.
    ///
    /// To prevent RSS blowup on binary streams or very long lines without
    /// newlines (e.g. `/dev/zero`), a hard partial-buffer limit of 1 MiB is
    /// enforced: once exceeded the partial is flushed as a line immediately.
    pub fn write(&mut self, text: &str, out: &mut impl Write) -> std::io::Result<()> {
        // Prepend any buffered partial line to the incoming text
        let mut full = String::new();
        if !self.partial.is_empty() {
            full.push_str(&self.partial);
            self.partial.clear();
        }
        full.push_str(text);

        // Emit complete lines inline (avoids per-char O(n) scan + Vec<String> alloc).
        // full ends without \n iff the last line is partial.
        let mut start = 0usize;
        loop {
            match full[start..].find('\n') {
                None => {
                    // Remaining text is a partial line
                    let partial = &full[start..];
                    if !partial.is_empty() {
                        // If partial exceeds the hard limit, flush it immediately
                        // so we don't accumulate unbounded memory on streams that
                        // never emit newlines (e.g. /dev/zero, binary data).
                        if partial.len() > PARTIAL_HARD_LIMIT {
                            let over = partial.len() - PARTIAL_HARD_LIMIT;
                            let (flush, keep) = partial.split_at(over);
                            self.line_no += 1;
                            self.max_line_bytes = self.max_line_bytes.max(flush.len());
                            let ts = iso_timestamp();
                            writeln!(out, "[{}] {:>7} | {}", ts, self.line_no, flush)?;
                            // keep 1 MiB in the buffer for further accumulation
                            self.partial = keep.to_string();
                        } else {
                            self.partial = partial.to_string();
                        }
                    }
                    break;
                }
                Some(rel) => {
                    let line_end = start + rel;
                    let line = &full[start..line_end];
                    self.line_no += 1;
                    self.max_line_bytes = self.max_line_bytes.max(line.len());
                    let ts = iso_timestamp();
                    writeln!(out, "[{}] {:>7} | {}", ts, self.line_no, line)?;
                    start = line_end + 1; // skip past '\n'
                }
            }
        }

        Ok(())
    }

    /// Force-flush the partial line buffer (called at EOF or when memory is critical).
    ///
    /// This matches Node's forcedFlush behavior when maxLineBytes is reached
    /// or at stream end.
    pub fn flush_partial(&mut self, out: &mut impl Write) -> std::io::Result<()> {
        if self.partial.is_empty() {
            return Ok(());
        }
        self.forced_flushes += 1;
        self.line_no += 1;
        let line = std::mem::take(&mut self.partial);
        self.max_line_bytes = self.max_line_bytes.max(line.len());
        let ts = iso_timestamp();
        writeln!(out, "[{}] {:>7} | {}", ts, self.line_no, line)?;
        Ok(())
    }

    pub fn stats(&self) -> (u64, u64, u64, usize) {
        (
            self.line_no,
            self.forced_flushes,
            self.line_no,
            self.max_line_bytes,
        )
    }
}

/// Generate an ISO-8601 timestamp matching Node's `new Date().toISOString()`.
fn iso_timestamp() -> String {
    // We use a simple format since we don't want extra deps.
    // Format: "2026-05-09T12:34:56.789Z" (millisecond precision)
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();

    // UTC calculation
    let days = secs / 86400;
    let time_secs = secs % 86400;
    let hours = time_secs / 3600;
    let minutes = (time_secs % 3600) / 60;
    let seconds = time_secs % 60;

    // Days since epoch to date (Gaussian algorithm)
    let mut y = 1970i64;
    let mut d = days as i64;
    loop {
        let days_in_year = if is_leap(y) { 366 } else { 365 };
        if d < days_in_year {
            break;
        }
        d -= days_in_year;
        y += 1;
    }
    let month_days = if is_leap(y) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut m = 0usize;
    for (i, &md) in month_days.iter().enumerate() {
        if d < md {
            m = i + 1;
            break;
        }
        d -= md;
    }
    let day = d + 1;

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y, m, day, hours, minutes, seconds, millis
    )
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

/// A tee writer that mirrors output to a log file while also passing through.
pub struct TeeWriter<W: Write> {
    primary: W,
    log: Option<std::fs::File>,
}

impl<W: Write> TeeWriter<W> {
    pub fn new(primary: W, log_path: Option<&str>) -> std::io::Result<Self> {
        let log = match log_path {
            Some(path) => Some(std::fs::File::create(path)?),
            None => None,
        };
        Ok(Self { primary, log })
    }

    pub fn write_all(&mut self, buf: &[u8]) -> std::io::Result<()> {
        self.primary.write_all(buf)?;
        if let Some(ref mut log) = self.log {
            log.write_all(buf)?;
        }
        Ok(())
    }

    pub fn flush(&mut self) -> std::io::Result<()> {
        self.primary.flush()?;
        if let Some(ref mut log) = self.log {
            log.flush()?;
        }
        Ok(())
    }
}

/// The main text processing pipeline.
///
/// Chain: raw bytes → U8Decoder (UTF-8 decode) → LineFormatter (timestamp/line_no prefix)
/// For `tee` mode, also writes original bytes to a log file.
///
/// Mode behavior (user-approved):
/// - `off`: binary passthrough only, no decode
/// - `passthrough`: decode & emit to stderr unconditionally (Node compatible)
/// - `transform`: decode & emit with timestamp/line_no prefix (planning.md extension)
/// - `tee`: same as transform + write original bytes to log file
pub struct TextPipeline {
    pub mode: TextMode,
    state: MemState,
    mem_rx: watch::Receiver<MemState>,
    decoder: U8Decoder,
    formatter: LineFormatter,
    pub stats: TextStatistics,
    log_file: Option<std::fs::File>,
    mode_at_start: TextMode,
}

impl TextPipeline {
    pub fn new(
        mode: TextMode,
        log_path: Option<String>,
        mem_rx: watch::Receiver<MemState>,
    ) -> Self {
        let log_file = log_path
            .as_ref()
            .and_then(|p| std::fs::File::create(p).ok());
        let initial_state = *mem_rx.borrow();
        Self {
            mode,
            state: initial_state,
            mem_rx,
            decoder: U8Decoder::new(),
            formatter: LineFormatter::new(),
            stats: TextStatistics::default(),
            log_file,
            mode_at_start: mode,
        }
    }

    /// Poll the watch channel for memory state changes and apply them.
    fn poll_memory(&mut self) {
        // has_changed() is O(1) — avoids unnecessary borrow() cost per chunk.
        if !self.mem_rx.has_changed().unwrap_or(false) {
            return;
        }
        let new_state = *self.mem_rx.borrow_and_update();
        if new_state != self.state {
            self.state = new_state;
            let new_mode = self.effective_mode();
            if new_mode != self.mode {
                self.stats.mode_transitions += 1;
                self.mode = new_mode;
            }
        }
    }

    /// Determine the effective mode based on configured mode + memory state.
    ///
    /// Node-compatible degradation rules (report.html §12.2):
    /// | state    | transform    | tee          | passthrough  |
    /// |----------|-------------|-------------|-------------|
    /// | NORMAL   | transform   | tee          | passthrough |
    /// | PRESSURE | passthrough | transform    | passthrough |
    /// | CRITICAL | off         | off          | passthrough |
    pub fn effective_mode(&self) -> TextMode {
        match self.mode_at_start {
            TextMode::Off => TextMode::Off,
            TextMode::Passthrough => TextMode::Passthrough,
            TextMode::Transform => match self.state {
                MemState::Normal => TextMode::Transform,
                MemState::Pressure => TextMode::Passthrough,
                MemState::Critical => TextMode::Off,
            },
            TextMode::Tee => match self.state {
                MemState::Normal => TextMode::Tee,
                MemState::Pressure => TextMode::Transform,
                MemState::Critical => TextMode::Off,
            },
        }
    }

    /// Process a chunk of raw bytes from child stdout.
    ///
    /// In `off` mode, bytes are written directly to `out`.
    /// Otherwise, bytes are decoded and formatted before writing.
    /// In `tee` mode, original bytes are additionally written to the log.
    pub fn process_chunk(&mut self, chunk: &[u8], out: &mut impl Write) -> std::io::Result<()> {
        // Poll for memory state changes before processing
        self.poll_memory();

        // off mode: binary passthrough, no decode
        if self.effective_mode() == TextMode::Off {
            return out.write_all(chunk);
        }

        // Decode to UTF-8
        let decoded = self.decoder.decode(chunk);
        self.stats.total_chars += decoded.chars().count() as u64;
        self.stats.decode_ns = self.decoder.decode_ns as u64;

        // For passthrough mode, decode and re-encode to stdout
        // For transform/tee, add line numbers and timestamps
        match self.effective_mode() {
            TextMode::Passthrough => {
                // Decode to UTF-8 string, then write decoded string to output.
                // This matches Node's StringDecoder behavior: bytes → string → bytes,
                // ensuring chunk-boundary UTF-8 integrity while remaining a valid
                // UTF-8 byte stream on the wire.
                write!(out, "{}", decoded)?;
            }
            TextMode::Transform => {
                // Split decoded text into manageable chunks so that
                // LineFormatter never accumulates a huge partial buffer
                // on streams with few or no newlines (e.g. /dev/zero).
                let s = &decoded;
                for chunk in s.as_bytes().chunks(PARTIAL_HARD_LIMIT) {
                    // NOTE: chunk boundaries may fall in the middle of a
                    // multi-byte UTF-8 character, making the slice invalid
                    // UTF-8.  from_utf8_lossy converts gracefully: any
                    // trailing partial character is replaced with U+FFFD.
                    let frag = String::from_utf8_lossy(chunk);
                    self.formatter.write(&frag, out)?;
                }
            }
            TextMode::Tee => {
                let s = &decoded;
                for chunk in s.as_bytes().chunks(PARTIAL_HARD_LIMIT) {
                    let frag = String::from_utf8_lossy(chunk);
                    self.formatter.write(&frag, out)?;
                }
                // Tee: write formatted (decoded) text to log, not raw bytes.
                // This keeps the log human-readable and matches Node's behavior
                // where the log receives decoded string content.
                if let Some(ref mut log) = self.log_file {
                    write!(log, "{}", decoded)?;
                }
            }
            TextMode::Off => unreachable!(),
        }

        Ok(())
    }

    /// Flush any buffered partial line (called at EOF).
    pub fn flush(&mut self, out: &mut impl Write) -> std::io::Result<()> {
        // Poll for memory state changes before flushing
        self.poll_memory();

        // Flush any partial line from the formatter
        if self.mode == TextMode::Transform || self.mode == TextMode::Tee {
            self.formatter.flush_partial(out)?;
        }

        // Flush the decoder (should be empty, but handle truncated sequences).
        // In Tee mode we skip writing to log_file because the raw bytes
        // that produced this decoder residue are gone (they were buffered in
        // the decoder and never written to the log via the Passthrough path).
        let remaining = self.decoder.flush();
        if !remaining.is_empty() {
            self.stats.total_chars += remaining.chars().count() as u64;
            match self.effective_mode() {
                TextMode::Passthrough => {
                    write!(out, "{}", remaining)?;
                }
                TextMode::Transform => {
                    self.formatter.write(&remaining, out)?;
                    self.formatter.flush_partial(out)?;
                }
                TextMode::Tee => {
                    self.formatter.write(&remaining, out)?;
                    self.formatter.flush_partial(out)?;
                    // Intentionally skip log_file — see comment above.
                }
                TextMode::Off => {}
            }
        }

        // Update stats from formatter
        let (lines, flushes, _, max_bytes) = self.formatter.stats();
        self.stats.total_lines = lines;
        self.stats.forced_flushes = flushes;
        self.stats.max_line_bytes = max_bytes;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_text_mode_from_str() {
        assert_eq!("off".parse(), Ok(TextMode::Off));
        assert_eq!("passthrough".parse(), Ok(TextMode::Passthrough));
        assert_eq!("transform".parse(), Ok(TextMode::Transform));
        assert_eq!("tee".parse(), Ok(TextMode::Tee));
        assert_eq!("invalid".parse::<TextMode>(), Err(()));
    }

    #[test]
    fn test_utf8_decode_ascii() {
        let mut dec = U8Decoder::new();
        let result = dec.decode(b"hello world");
        assert_eq!(result, "hello world");
    }

    #[test]
    fn test_utf8_decode_multibyte() {
        let mut dec = U8Decoder::new();
        let result = dec.decode("こんにちは".as_bytes());
        assert_eq!(result, "こんにちは");
    }

    #[test]
    fn test_utf8_decode_chunk_boundary() {
        // 3-byte UTF-8 char: 貓 = [0xE8, 0xB2, 0x93]
        let bytes = [0xE8u8, 0xB2, 0x93];
        let mut dec = U8Decoder::new();
        let result = dec.decode(&bytes);
        assert_eq!(result, "貓");
    }

    #[test]
    fn test_utf8_decode_split_across_chunks() {
        // 3-byte char split as 2 + 1 bytes: 貓 = [0xE8, 0xB2, 0x93]
        let bytes = [0xE8u8, 0xB2]; // first 2 bytes of 貓
        let mut dec = U8Decoder::new();
        let result1 = dec.decode(&bytes);
        assert_eq!(result1, ""); // incomplete, buffered internally

        let result2 = dec.decode(&[0x93]); // last byte
        assert_eq!(result2, "貓");
    }

    #[test]
    fn test_line_formatter_single_line() {
        let mut fmt = LineFormatter::new();
        let mut out = Vec::new();
        fmt.write("hello", &mut out).unwrap();
        fmt.flush_partial(&mut out).unwrap();
        let output = String::from_utf8(out).unwrap();
        assert!(output.contains("| hello"));
        assert!(output.contains("1 |"));
    }

    #[test]
    fn test_line_formatter_multi_line() {
        let mut fmt = LineFormatter::new();
        let mut out = Vec::new();
        fmt.write("hello\nworld\n", &mut out).unwrap();
        let output = String::from_utf8(out).unwrap();
        assert!(output.contains("1 | hello"));
        assert!(output.contains("2 | world"));
    }

    #[test]
    fn test_line_formatter_line_no_padding() {
        let mut fmt = LineFormatter::new();
        let mut out = Vec::new();
        // Write 100 lines to see padding
        for i in 0..100 {
            fmt.write(&format!("line{}\n", i), &mut out).unwrap();
        }
        let output = String::from_utf8(out).unwrap();
        assert!(output.contains("100 | line99"));
    }

    #[test]
    fn test_line_formatter_forced_flush() {
        let mut fmt = LineFormatter::new();
        let mut out = Vec::new();
        fmt.write("no newline here", &mut out).unwrap();
        assert_eq!(fmt.forced_flushes, 0);
        fmt.flush_partial(&mut out).unwrap();
        assert_eq!(fmt.forced_flushes, 1);
        let output = String::from_utf8(out).unwrap();
        assert!(output.contains("| no newline here"));
    }

    #[test]
    fn test_iso_timestamp_format() {
        let ts = iso_timestamp();
        // Should match ISO-8601 pattern: 2026-05-09T12:34:56.789Z
        assert!(
            ts.len() == 24,
            "timestamp length should be 24, got: {} (len={})",
            ts,
            ts.len()
        );
        assert!(ts.ends_with('Z'));
        assert!(ts.contains('T'));
    }

    fn make_pipe(mode: TextMode, log_path: Option<String>) -> TextPipeline {
        let (_tx, rx) = watch::channel(MemState::Normal);
        TextPipeline::new(mode, log_path, rx)
    }

    #[test]
    fn test_text_pipeline_off_mode() {
        let mut pipe = make_pipe(TextMode::Off, None);
        let mut out = Vec::new();
        pipe.process_chunk(b"hello", &mut out).unwrap();
        assert_eq!(out, b"hello");
    }

    #[test]
    fn test_text_pipeline_passthrough() {
        let mut pipe = make_pipe(TextMode::Passthrough, None);
        let mut out = Vec::new();
        // Passthrough writes original bytes to out
        pipe.process_chunk(b"hello", &mut out).unwrap();
        assert_eq!(out, b"hello");
    }

    #[test]
    fn test_effective_mode_degradation() {
        let (tx, rx) = watch::channel(MemState::Normal);
        let mut pipe = TextPipeline::new(TextMode::Transform, None, rx);
        assert_eq!(pipe.effective_mode(), TextMode::Transform);

        tx.send(MemState::Pressure).unwrap();
        pipe.poll_memory();
        assert_eq!(pipe.effective_mode(), TextMode::Passthrough);

        tx.send(MemState::Critical).unwrap();
        pipe.poll_memory();
        assert_eq!(pipe.effective_mode(), TextMode::Off);

        tx.send(MemState::Normal).unwrap();
        pipe.poll_memory();
        assert_eq!(pipe.mode, TextMode::Transform);
    }

    #[test]
    fn test_effective_mode_degradation_tee() {
        let (tx, rx) = watch::channel(MemState::Normal);
        let mut pipe = TextPipeline::new(TextMode::Tee, None, rx);
        assert_eq!(pipe.effective_mode(), TextMode::Tee);

        tx.send(MemState::Pressure).unwrap();
        pipe.poll_memory();
        assert_eq!(pipe.effective_mode(), TextMode::Transform);

        tx.send(MemState::Critical).unwrap();
        pipe.poll_memory();
        assert_eq!(pipe.effective_mode(), TextMode::Off);

        tx.send(MemState::Normal).unwrap();
        pipe.poll_memory();
        assert_eq!(pipe.mode, TextMode::Tee);
    }

    #[test]
    fn test_effective_mode_passthrough_never_degrades() {
        let (tx, rx) = watch::channel(MemState::Normal);
        let mut pipe = TextPipeline::new(TextMode::Passthrough, None, rx);
        assert_eq!(pipe.effective_mode(), TextMode::Passthrough);

        tx.send(MemState::Pressure).unwrap();
        pipe.poll_memory();
        assert_eq!(pipe.effective_mode(), TextMode::Passthrough);

        tx.send(MemState::Critical).unwrap();
        pipe.poll_memory();
        assert_eq!(pipe.effective_mode(), TextMode::Passthrough);
    }

    #[test]
    fn test_large_text_passthrough() {
        let mut pipe = make_pipe(TextMode::Passthrough, None);
        let mut out = Vec::new();

        // 100MB of ASCII text through decode pipeline
        let line = b"Hello, world! This is a test line for nproxy text decode.\n";
        let total_lines = 1_000_000;
        let mut total_bytes = 0usize;
        for _ in 0..total_lines {
            pipe.process_chunk(line, &mut out).unwrap();
            total_bytes += line.len();
        }
        pipe.flush(&mut out).unwrap();

        assert_eq!(
            out.len(),
            total_bytes,
            "all original bytes should passthrough"
        );
        assert!(pipe.stats.total_chars > 0, "should have decoded characters");
        assert!(pipe.stats.decode_ns > 0, "should have measured decode time");
    }

    #[test]
    fn test_large_text_transform() {
        let mut pipe = make_pipe(TextMode::Transform, None);
        let mut out = Vec::new();

        // 10MB of text through transform pipeline
        let line = b"Line of text for transform testing.\n";
        for _ in 0..200_000 {
            pipe.process_chunk(line, &mut out).unwrap();
        }
        pipe.flush(&mut out).unwrap();

        let output = String::from_utf8(out).unwrap();
        // Should have timestamps and line numbers
        assert!(
            output.contains("| Line of text"),
            "should contain formatted line"
        );
        assert!(
            pipe.stats.total_lines >= 200_000,
            "should count lines: {}",
            pipe.stats.total_lines
        );
    }

    #[test]
    fn test_utf8_mixed_length_across_chunks() {
        let mut pipe = make_pipe(TextMode::Passthrough, None);
        let mut out = Vec::new();

        // Mix ASCII (1-byte), Japanese (3-byte), emoji (4-byte surrogate pairs)
        let chunks = vec![
            b"Hello ",
            "世界".as_bytes(), // 3 bytes each = 6 bytes, may split
            b"! ",
            "🌍🌏🌎".as_bytes(), // 4 bytes each = 12 bytes
        ];
        for chunk in &chunks {
            pipe.process_chunk(chunk, &mut out).unwrap();
        }
        pipe.flush(&mut out).unwrap();

        assert!(
            pipe.stats.total_chars > 0,
            "should have decoded all characters"
        );
        let output = String::from_utf8(out).unwrap();
        assert!(output.contains("Hello"), "ASCII passthrough");
    }

    #[test]
    fn test_tee_writer() {
        let tmpdir = std::env::temp_dir();
        let log_path = tmpdir.join("nproxy_tee_test.log");
        let log_str = log_path.to_str().unwrap().to_string();

        let mut buf = Vec::new();
        {
            let mut tee = TeeWriter::new(&mut buf, Some(&log_str)).unwrap();
            tee.write_all(b"hello tee").unwrap();
        }
        assert_eq!(buf, b"hello tee");

        // Verify log file was written
        let log_content = std::fs::read_to_string(&log_path).unwrap();
        assert_eq!(log_content, "hello tee");

        // Cleanup
        let _ = std::fs::remove_file(&log_path);
    }

    #[test]
    fn test_zero_length_decode() {
        let mut dec = U8Decoder::new();
        let result = dec.decode(b"");
        assert_eq!(result, "");
    }

    #[test]
    fn test_text_statistics_tracking() {
        let mut pipe = make_pipe(TextMode::Transform, None);
        let mut out = Vec::new();

        pipe.process_chunk(b"hello\nworld\n", &mut out).unwrap();
        pipe.flush(&mut out).unwrap();

        assert_eq!(pipe.stats.total_lines, 2);
        assert!(pipe.stats.decode_ns > 0);
    }
}
