//! macOS playback control, Tier 2: send a system pause command through the
//! private MediaRemote framework. Commands-only — there is no read path, so we
//! can't identify what we paused and do not auto-resume yet (Wave 5 adds the
//! read shim that enables remember + resume). This already beats the old
//! AppleScript path: it pauses the whole system's now-playing app, including
//! browsers / YouTube / web audio, and needs no Automation permission.
//!
//! `MRMediaRemoteSendCommand(command, userInfo) -> Boolean` is synchronous (no
//! dispatch queue, no completion block), so it runs inline. We pass null
//! userInfo and the dedicated Pause command (1), never the play/pause toggle, so
//! we never start idle playback. The macOS 15.4 entitlement lockdown gated only
//! the now-playing *read*; the command path is unaffected (LyricFever #94).
//!
//! We resolve the framework with `dlopen` rather than link it: MediaRemote is a
//! private Apple framework, so a hard link would make the whole app fail to
//! launch if a future macOS removes it. dlopen degrades to a silent no-op
//! instead (Tier 3), and loading a system-signed framework needs no entitlement.

use std::ffi::{c_char, c_int, c_void, CString};
use std::ptr;
use std::sync::OnceLock;

/// `MRMediaRemoteCommandPause`. Stable across the reversed-header sources; we
/// pass the integer directly.
const MR_COMMAND_PAUSE: c_int = 1;
const RTLD_NOW: c_int = 2;
const MEDIA_REMOTE_PATH: &str =
    "/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote";

extern "C" {
    fn dlopen(filename: *const c_char, flag: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

type SendCommandFn = unsafe extern "C" fn(c_int, *const c_void) -> u8;

/// Pause the system now-playing app. Tier 2 has no read path, so we can't name
/// what we paused and don't auto-resume: returns an empty token set.
pub async fn pause_playing() -> Result<Vec<String>, String> {
    let Some(send_command) = send_command_fn() else {
        return Ok(Vec::new());
    };
    // SAFETY: `send_command` is the resolved MRMediaRemoteSendCommand; null
    // userInfo is valid for a plain command.
    let sent = unsafe { send_command(MR_COMMAND_PAUSE, ptr::null()) };
    if sent == 0 {
        // Nothing was playing, or the command was not accepted; not an error.
        log::debug!("MediaRemote pause command not accepted (nothing playing?)");
    }
    Ok(Vec::new())
}

/// No-op on Tier 2: there is no remembered set to resume. Wave 5 (read shim)
/// replaces this with an identity-matched resume.
pub async fn resume(_sessions: Vec<String>) -> Result<(), String> {
    Ok(())
}

/// Resolve `MRMediaRemoteSendCommand` once. `None` when the framework or symbol
/// is unavailable (e.g. a future macOS removed it) -> the feature silently
/// no-ops and the app still runs (Tier 3).
fn send_command_fn() -> Option<SendCommandFn> {
    static SEND_COMMAND: OnceLock<Option<SendCommandFn>> = OnceLock::new();
    *SEND_COMMAND.get_or_init(|| unsafe {
        let path = CString::new(MEDIA_REMOTE_PATH).ok()?;
        let handle = dlopen(path.as_ptr(), RTLD_NOW);
        if handle.is_null() {
            log::debug!("MediaRemote framework unavailable");
            return None;
        }
        // The handle is intentionally never closed: the framework stays loaded
        // for the process lifetime, which is exactly what we want.
        let symbol = CString::new("MRMediaRemoteSendCommand").ok()?;
        let address = dlsym(handle, symbol.as_ptr());
        if address.is_null() {
            log::debug!("MRMediaRemoteSendCommand symbol not found");
            return None;
        }
        Some(std::mem::transmute::<*mut c_void, SendCommandFn>(address))
    })
}
