use std::io;
use std::time::Duration;
use tracing::debug;

/// Memory pressure states.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MemState {
    Normal,
    Pressure,
    Critical,
}

/// Reads the current RSS from /proc/<pid>/status (VmRSS in kB).
fn read_vmrss_kb(pid: u32) -> io::Result<u64> {
    let path = format!("/proc/{}/status", pid);
    let content = std::fs::read_to_string(&path)?;
    for line in content.lines() {
        if let Some(val) = line.strip_prefix("VmRSS:") {
            let val = val.trim();
            if let Some(kb_str) = val.split_whitespace().next() {
                if let Ok(kb) = kb_str.parse::<u64>() {
                    return Ok(kb);
                }
            }
        }
    }
    Err(io::Error::new(io::ErrorKind::NotFound, format!("VmRSS not found in {}", path)))
}

/// Memory-aware policy that tracks RSS and drives state transitions.
pub struct MemoryPolicy {
    /// Child PID to monitor.
    pub pid: u32,
    /// Pressure threshold (MB). Default: env PRESSURE_MB or 512.
    pub pressure_mb: u64,
    /// Critical threshold (MB). Default: env CRITICAL_MB or 1024.
    pub critical_mb: u64,
    /// Tick interval (ms). Default: env TICK_MS or 100.
    pub tick_ms: u64,
    /// Current state.
    pub state: MemState,
    /// Learning mode – active while waiting for process RSS to stabilize.
    pub learning: bool,
}

impl MemoryPolicy {
    pub fn new(pid: u32, pressure_mb: u64, critical_mb: u64) -> Self {
        let tick_ms = env_u64("TICK_MS", 100);

        debug!(
            "MemoryPolicy: pid={} pressure_mb={} critical_mb={} tick_ms={}",
            pid, pressure_mb, critical_mb, tick_ms
        );

        Self {
            pid,
            pressure_mb,
            critical_mb,
            tick_ms,
            state: MemState::Normal,
            learning: true,
        }
    }

    /// Classify RSS (MB) into a memory state based on configured thresholds.
    pub fn classify(&self, rss_mb: u64) -> MemState {
        if rss_mb >= self.critical_mb {
            MemState::Critical
        } else if rss_mb >= self.pressure_mb {
            MemState::Pressure
        } else {
            MemState::Normal
        }
    }

    /// Poll RSS and update state. Returns true if state changed.
    pub fn tick(&mut self) -> bool {
        let rss_kb = match read_vmrss_kb(self.pid) {
            Ok(v) => v,
            Err(e) => {
                debug!("MemoryPolicy: failed to read VmRSS: {}", e);
                return false;
            }
        };
        let rss_mb = rss_kb / 1024;

        let new_state = self.classify(rss_mb);

        if new_state != self.state {
            debug!(
                "MemoryPolicy: state transition {:?} -> {:?} (rss={} MB)",
                self.state, new_state, rss_mb
            );
            self.state = new_state;
            return true;
        }
        false
    }

    /// Mark learning phase as complete.
    pub fn end_learning(&mut self) {
        self.learning = false;
    }

    /// Return the tick interval as a Duration.
    pub fn interval(&self) -> Duration {
        Duration::from_millis(self.tick_ms)
    }
}

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_normal_below_pressure() {
        let p = MemoryPolicy { pid: 0, pressure_mb: 512, critical_mb: 1024, tick_ms: 100, state: MemState::Normal, learning: false };
        assert_eq!(p.classify(0), MemState::Normal);
        assert_eq!(p.classify(511), MemState::Normal);
    }

    #[test]
    fn test_classify_pressure_threshold() {
        let p = MemoryPolicy { pid: 0, pressure_mb: 512, critical_mb: 1024, tick_ms: 100, state: MemState::Normal, learning: false };
        assert_eq!(p.classify(512), MemState::Pressure);
        assert_eq!(p.classify(800), MemState::Pressure);
        assert_eq!(p.classify(1023), MemState::Pressure);
    }

    #[test]
    fn test_classify_critical_threshold() {
        let p = MemoryPolicy { pid: 0, pressure_mb: 512, critical_mb: 1024, tick_ms: 100, state: MemState::Normal, learning: false };
        assert_eq!(p.classify(1024), MemState::Critical);
        assert_eq!(p.classify(2048), MemState::Critical);
    }

    #[test]
    fn test_state_transition_tracking() {
        let mut p = MemoryPolicy { pid: 0, pressure_mb: 200, critical_mb: 500, tick_ms: 100, state: MemState::Normal, learning: false };
        // Initial state is Normal
        assert_eq!(p.state, MemState::Normal);
        // Mutate state directly to simulate tracked transitions
        p.state = MemState::Pressure;
        assert_eq!(p.state, MemState::Pressure);
        p.state = MemState::Critical;
        assert_eq!(p.state, MemState::Critical);
    }

    #[test]
    fn test_learning_flag_default() {
        let p = MemoryPolicy::new(std::process::id(), 512, 1024);
        assert!(p.learning);
    }

    #[test]
    fn test_end_learning() {
        let mut p = MemoryPolicy::new(std::process::id(), 512, 1024);
        assert!(p.learning);
        p.end_learning();
        assert!(!p.learning);
    }
}
