use std::time::Instant;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_io_kind_label() {
        assert_eq!(IoKind::Stdin.label(), "stdin");
        assert_eq!(IoKind::Stdout.label(), "stdout");
        assert_eq!(IoKind::Stderr.label(), "stderr");
    }

    #[test]
    fn test_hex_encode_empty() {
        assert_eq!(hex_encode(b""), "");
    }

    #[test]
    fn test_hex_encode_single_byte() {
        assert_eq!(hex_encode(b"\x00"), "00");
        assert_eq!(hex_encode(b"\xff"), "ff");
        assert_eq!(hex_encode(b"AB"), "4142");
    }

    #[test]
    fn test_hex_encode_all_bytes() {
        let input: Vec<u8> = (0..16).collect();
        assert_eq!(hex_encode(&input), "000102030405060708090a0b0c0d0e0f");
    }

    #[test]
    fn test_chunk_meta_head_hex_empty() {
        let meta = ChunkMeta {
            size: 0,
            ts: Instant::now(),
            kind: IoKind::Stdout,
            head16: [0u8; 16],
            head_len: 0,
        };
        assert_eq!(meta.head_hex(), "");
    }

    #[test]
    fn test_chunk_meta_head_hex_full() {
        let meta = ChunkMeta {
            size: 100,
            ts: Instant::now(),
            kind: IoKind::Stdout,
            head16: *b"hello world!!!!!",
            head_len: 16,
        };
        // "hello world!!!!!" is 17 bytes, truncated to 16: "hello world!!!!"
        assert_eq!(meta.head_hex().len(), 32); // 16 bytes = 32 hex chars
    }

    #[test]
    fn test_ring_meta_buffer_empty() {
        let ring = RingMetaBuffer::new();
        assert!(ring.is_empty());
        assert_eq!(ring.len(), 0);
        assert_eq!(ring.iter().count(), 0);
    }

    #[test]
    fn test_ring_meta_buffer_push_and_iter() {
        let mut ring = RingMetaBuffer::new();
        let ts = Instant::now();
        for i in 0..5 {
            ring.push(ChunkMeta {
                size: i * 10,
                ts,
                kind: IoKind::Stdout,
                head16: [0u8; 16],
                head_len: 0,
            });
        }
        assert_eq!(ring.len(), 5);
        assert!(!ring.is_empty());
        let sizes: Vec<usize> = ring.iter().map(|m| m.size).collect();
        assert_eq!(sizes, vec![0, 10, 20, 30, 40]);
    }

    #[test]
    fn test_ring_meta_buffer_wraparound() {
        let mut ring = RingMetaBuffer::new();
        let capacity = RING_CAPACITY;
        let ts = Instant::now();
        // Fill the ring
        for i in 0..capacity {
            ring.push(ChunkMeta {
                size: i,
                ts,
                kind: IoKind::Stdout,
                head16: [0u8; 16],
                head_len: 0,
            });
        }
        assert_eq!(ring.len(), capacity);
        // Push one more to trigger wraparound
        ring.push(ChunkMeta {
            size: 999,
            ts,
            kind: IoKind::Stdout,
            head16: [0u8; 16],
            head_len: 0,
        });
        assert_eq!(ring.len(), capacity); // still at capacity
        let sizes: Vec<usize> = ring.iter().map(|m| m.size).collect();
        assert_eq!(sizes.len(), capacity);
        // The oldest element (0) was evicted, newest (999) is included
        assert!(sizes.contains(&999));
        assert!(!sizes.contains(&0));
    }

    #[test]
    fn test_observer_new() {
        let obs = Observer::new();
        assert_eq!(obs.stdin_bytes, 0);
        assert_eq!(obs.stdout_bytes, 0);
        assert_eq!(obs.stderr_bytes, 0);
        assert!(obs.meta.is_empty());
    }

    #[test]
    fn test_observer_record_tracks_bytes() {
        let mut obs = Observer::new();
        obs.record(100, IoKind::Stdin, Some(b"hello"));
        assert_eq!(obs.stdin_bytes, 100);
        assert_eq!(obs.meta.len(), 1);

        obs.record(200, IoKind::Stdout, Some(b"world"));
        assert_eq!(obs.stdout_bytes, 200);
        assert_eq!(obs.meta.len(), 2);

        obs.record(300, IoKind::Stderr, None);
        assert_eq!(obs.stderr_bytes, 300);
        assert_eq!(obs.meta.len(), 3);
    }

    #[test]
    fn test_observer_record_without_chunk() {
        let mut obs = Observer::new();
        obs.record(42, IoKind::Stdout, None);
        let metas: Vec<_> = obs.meta.iter().collect();
        assert_eq!(metas.len(), 1);
        assert_eq!(metas[0].head_len, 0);
        assert!(metas[0].head_hex().is_empty());
    }

    #[test]
    fn test_observer_record_head_truncation() {
        let mut obs = Observer::new();
        let long_data = b"this is more than sixteen bytes of data";
        assert!(long_data.len() > 16);
        obs.record(long_data.len(), IoKind::Stdout, Some(long_data));
        let metas: Vec<_> = obs.meta.iter().collect();
        assert_eq!(metas[0].head_len, 16);
        assert_eq!(metas[0].head_hex().len(), 32); // 16 bytes = 32 hex chars
    }

    #[test]
    fn test_hex_encode_known() {
        assert_eq!(hex_encode(b"\xde\xad\xbe\xef"), "deadbeef");
        assert_eq!(hex_encode(b"\xca\xfe\xba\xbe"), "cafebabe");
    }
}

/// Helper enum to allow returning different iterator types from `iter()`.
#[allow(dead_code)]
enum EitherIter<A, B> {
    Left(A),
    Right(B),
}

impl<A, B, T> Iterator for EitherIter<A, B>
where
    A: Iterator<Item = T>,
    B: Iterator<Item = T>,
{
    type Item = T;
    fn next(&mut self) -> Option<Self::Item> {
        match self {
            EitherIter::Left(a) => a.next(),
            EitherIter::Right(b) => b.next(),
        }
    }
}

type RingIter<'a> = Box<dyn Iterator<Item = &'a ChunkMeta> + 'a>;

const RING_CAPACITY: usize = 8192;

/// Kinds of I/O events the observer can record.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum IoKind {
    Stdin,
    Stdout,
    Stderr,
}

impl IoKind {
    pub fn label(&self) -> &'static str {
        match self {
            IoKind::Stdin => "stdin",
            IoKind::Stdout => "stdout",
            IoKind::Stderr => "stderr",
        }
    }
}

/// Metadata for a single I/O chunk.
#[derive(Debug, Clone, Copy)]
pub struct ChunkMeta {
    pub size: usize,
    pub ts: Instant,
    pub kind: IoKind,
    /// Hex preview of the first 16 bytes (empty string if empty chunk / disabled).
    pub head16: [u8; 16],
    pub head_len: u8,
}

impl ChunkMeta {
    pub fn head_hex(&self) -> String {
        if self.head_len == 0 {
            return String::new();
        }
        hex_encode(&self.head16[..self.head_len as usize])
    }
}

/// Minimal hex encoding (no alloc for the common case of 0-16 bytes).
fn hex_encode(src: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(src.len() * 2);
    for &b in src {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// Bounded ring buffer of chunk metadata.  Never retains the data bytes.
pub struct RingMetaBuffer {
    buffer: [Option<ChunkMeta>; RING_CAPACITY],
    write_pos: usize,
    count: usize,
}

impl RingMetaBuffer {
    pub fn new() -> Self {
        Self::default()
    }
}

impl Default for RingMetaBuffer {
    fn default() -> Self {
        Self {
            buffer: [None; RING_CAPACITY],
            write_pos: 0,
            count: 0,
        }
    }
}

impl RingMetaBuffer {
    pub fn push(&mut self, meta: ChunkMeta) {
        self.buffer[self.write_pos] = Some(meta);
        self.write_pos = (self.write_pos + 1) % RING_CAPACITY;
        if self.count < RING_CAPACITY {
            self.count += 1;
        }
    }

    #[allow(dead_code)]
    pub fn iter(&self) -> RingIter<'_> {
        if self.count == 0 {
            return Box::new([].iter().filter_map(|_: &Option<ChunkMeta>| None));
        }
        if self.count < RING_CAPACITY {
            // Not full: elements are at buffer[0..count]
            return Box::new(self.buffer[..self.count].iter().filter_map(|m| m.as_ref()));
        }
        // Full: elements wrap around write_pos
        Box::new(
            self.buffer[self.write_pos..]
                .iter()
                .chain(self.buffer[..self.write_pos].iter())
                .filter_map(|m| m.as_ref()),
        )
    }

    pub fn len(&self) -> usize {
        self.count
    }

    pub fn is_empty(&self) -> bool {
        self.count == 0
    }
}

/// Observer records I/O chunk metadata into a ring buffer.
pub struct Observer {
    pub meta: RingMetaBuffer,
    pub stdin_bytes: u64,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
}

impl Observer {
    pub fn new() -> Self {
        Self::default()
    }
}

impl Default for Observer {
    fn default() -> Self {
        Self {
            meta: RingMetaBuffer::new(),
            stdin_bytes: 0,
            stdout_bytes: 0,
            stderr_bytes: 0,
        }
    }
}

impl Observer {
    pub fn record(&mut self, size: usize, kind: IoKind, chunk: Option<&[u8]>) {
        let mut head16 = [0u8; 16];
        let mut head_len = 0u8;
        if let Some(data) = chunk {
            let n = data.len().min(16);
            head16[..n].copy_from_slice(&data[..n]);
            head_len = n as u8;
        }
        let meta = ChunkMeta {
            size,
            ts: Instant::now(),
            kind,
            head16,
            head_len,
        };
        self.meta.push(meta);
        match kind {
            IoKind::Stdin => self.stdin_bytes += size as u64,
            IoKind::Stdout => self.stdout_bytes += size as u64,
            IoKind::Stderr => self.stderr_bytes += size as u64,
        }
    }
}
