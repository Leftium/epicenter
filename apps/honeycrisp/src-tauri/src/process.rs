//! Run one child process to completion with a bound on its output and its
//! time.
//!
//! The child gets no input. Both of its output streams are read as they
//! arrive, so a child that writes more than the limit is never blocked on a
//! full pipe; bytes past the limit are dropped. When the time runs out the
//! child's whole process group is stopped, so a background job that kept an
//! output stream open cannot hold the caller.

use std::io::{self, Read};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// How long a stopped child's output streams get to close.
const DRAIN_GRACE: Duration = Duration::from_secs(2);

pub struct Captured {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// `None` when a signal ended the child.
    pub code: Option<i32>,
    /// Output past the limit was dropped.
    pub truncated: bool,
    /// The time ran out and the child was stopped.
    pub timed_out: bool,
}

struct Budget {
    limit: usize,
    used: AtomicUsize,
    truncated: AtomicBool,
}

/// One limit covers both streams. A chunk that arrives under the limit is
/// kept whole; every chunk after the limit is reached is dropped.
fn drain(mut pipe: impl Read, into: &Mutex<Vec<u8>>, budget: &Budget) {
    let mut chunk = [0u8; 8192];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => return,
            Ok(read) => {
                if budget.used.load(Ordering::SeqCst) >= budget.limit {
                    budget.truncated.store(true, Ordering::SeqCst);
                    continue;
                }
                budget.used.fetch_add(read, Ordering::SeqCst);
                into.lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .extend_from_slice(&chunk[..read]);
            }
            Err(cause) if cause.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return,
        }
    }
}

/// Stop the child and everything it started. Call only before the child has
/// been waited for: until then its process ID still names its group.
#[cfg(unix)]
fn stop(child: &mut Child) {
    extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    const SIGKILL: i32 = 9;
    if let Ok(group) = i32::try_from(child.id()) {
        // SAFETY: `kill` takes two integers and touches no memory of this
        // process. A negative ID names the group the child leads.
        unsafe {
            kill(-group, SIGKILL);
        }
    }
    let _ = child.kill();
}

#[cfg(not(unix))]
fn stop(child: &mut Child) {
    let _ = child.kill();
}

/// Spawn `command` and collect what it writes. An error means the child could
/// not start.
pub fn capture(command: &mut Command, limit: usize, timeout: Duration) -> io::Result<Captured> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // The child leads a new group, so `stop` reaches its descendants.
        command.process_group(0);
    }
    let mut child = command.spawn()?;
    let deadline = Instant::now() + timeout;
    let budget = Arc::new(Budget {
        limit,
        used: AtomicUsize::new(0),
        truncated: AtomicBool::new(false),
    });
    let stdout = Arc::new(Mutex::new(Vec::new()));
    let stderr = Arc::new(Mutex::new(Vec::new()));
    let (finished, streams) = mpsc::channel::<()>();
    let mut open = 0;
    {
        let mut read = |pipe: Box<dyn Read + Send>, into: &Arc<Mutex<Vec<u8>>>| {
            let (into, budget, finished) =
                (Arc::clone(into), Arc::clone(&budget), finished.clone());
            open += 1;
            thread::spawn(move || {
                drain(pipe, &into, &budget);
                let _ = finished.send(());
            });
        };
        if let Some(pipe) = child.stdout.take() {
            read(Box::new(pipe), &stdout);
        }
        if let Some(pipe) = child.stderr.take() {
            read(Box::new(pipe), &stderr);
        }
    }
    drop(finished);

    // The command is over when both streams closed and the child exited.
    let mut timed_out = false;
    while open > 0 && !timed_out {
        match streams.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(()) => open -= 1,
            Err(RecvTimeoutError::Timeout) => timed_out = true,
            Err(RecvTimeoutError::Disconnected) => open = 0,
        }
    }
    let mut status = None;
    while !timed_out && status.is_none() {
        status = child.try_wait()?;
        if status.is_none() {
            if Instant::now() >= deadline {
                timed_out = true;
            } else {
                thread::sleep(Duration::from_millis(5));
            }
        }
    }
    if timed_out {
        stop(&mut child);
        // A process that left the group may still hold a stream; do not wait
        // for it longer than the grace period.
        let grace = Instant::now() + DRAIN_GRACE;
        while open > 0 {
            match streams.recv_timeout(grace.saturating_duration_since(Instant::now())) {
                Ok(()) => open -= 1,
                Err(_) => break,
            }
        }
    }
    let status = match status {
        Some(status) => status,
        None => child.wait()?,
    };
    let take = |bytes: &Mutex<Vec<u8>>| {
        std::mem::take(
            &mut *bytes
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        )
    };
    Ok(Captured {
        stdout: take(&stdout),
        stderr: take(&stderr),
        code: status.code(),
        truncated: budget.truncated.load(Ordering::SeqCst),
        timed_out,
    })
}
