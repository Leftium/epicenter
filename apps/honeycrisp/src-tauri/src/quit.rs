//! macOS: a system quit goes through the close gate like every other way out.
//!
//! AppKit asks the application delegate `applicationShouldTerminate:` before
//! it ends the app for the Dock's Quit, a logout or shutdown, or an Apple
//! Event. Tao's delegate class, `TaoAppDelegateParent` (tao 0.37), does not
//! answer it, so AppKit goes straight on: `applicationWillTerminate:` ends the
//! event loop, Tauri never sends `RunEvent::ExitRequested`, and the page that
//! holds the drafts is never asked.
//!
//! During setup this module adds that one method to Tao's existing class. The
//! answer is always `NSTerminateCancel`, and the method asks for an ordinary
//! exit with `AppHandle::exit`, which sends `ExitRequested`: the existing
//! close gate then decides, exactly as for the Quit menu item, and saving,
//! discarding, and declining stay the page's. An exit the gate lets through
//! stops the event loop with `stop:`, never `terminate:`, so the method is
//! not asked again, and the folder plugin drains on `RunEvent::Exit` as for
//! every other exit. A logout or shutdown this cancels is not resumed; the
//! person starts it again once the page has answered.
//!
//! Nothing else about the delegate changes: not the object AppKit holds, not
//! its class's other methods, not its state. The app does not start when the
//! class is not the one this was checked against, when it already answers the
//! question, or when the method cannot be added.
//!
//! The calls are the Objective-C runtime's own C functions, each called with
//! its exact prototype.

use std::ffi::{c_char, c_int, c_void, CStr};
use std::sync::OnceLock;

use tauri::{AppHandle, Wry};

type Id = *mut c_void;
type Sel = *const c_void;
type Class = *mut c_void;

#[link(name = "objc", kind = "dylib")]
extern "C" {
    fn objc_getClass(name: *const c_char) -> Class;
    fn object_getClass(object: Id) -> Class;
    fn sel_registerName(name: *const c_char) -> Sel;
    fn class_getInstanceMethod(class: Class, selector: Sel) -> *mut c_void;
    /// `BOOL` is one byte on every Apple architecture this runs on.
    fn class_addMethod(class: Class, selector: Sel, imp: *const c_void, types: *const c_char)
        -> u8;
    /// Never called through this declaration: cast to the exact prototype first.
    fn objc_msgSend();
}

extern "C" {
    fn pthread_main_np() -> c_int;
}

/// The class Tao registers for the delegate AppKit holds.
const DELEGATE_CLASS: &CStr = c"TaoAppDelegateParent";
const SHOULD_TERMINATE: &CStr = c"applicationShouldTerminate:";
/// `- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender`:
/// an `NSUInteger` return, then `self`, `_cmd`, and one object.
const SHOULD_TERMINATE_TYPES: &CStr = c"Q@:@";
/// `NSTerminateCancel`.
const TERMINATE_CANCEL: usize = 0;

// `NSUInteger` is 64 bits on every macOS architecture Tauri builds for.
const _: () = assert!(std::mem::size_of::<usize>() == 8);

/// The app to ask for an ordinary exit. Set once, before the method exists.
static APP: OnceLock<AppHandle<Wry>> = OnceLock::new();

/// AppKit's question. It takes no lock and cannot unwind: a quit always
/// becomes an ordinary exit request, which the close gate answers.
extern "C" fn should_terminate(_delegate: Id, _selector: Sel, _sender: Id) -> usize {
    if let Some(app) = APP.get() {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| app.exit(0)));
    }
    TERMINATE_CANCEL
}

/// Add `applicationShouldTerminate:` to Tao's delegate class. Call once, on
/// the main thread, during setup: after the event loop exists, before any
/// window. An error means the app must not start.
pub fn install(app: &AppHandle<Wry>) -> Result<(), String> {
    // SAFETY: every runtime function is called with its documented prototype,
    // `objc_msgSend` only after a cast to the exact signature of the method
    // it sends, and only on the main thread, where AppKit is used.
    unsafe {
        if pthread_main_np() == 0 {
            return Err("the quit guard must be installed on the main thread".into());
        }
        let class = objc_getClass(DELEGATE_CLASS.as_ptr());
        if class.is_null() {
            return Err("the application delegate class TaoAppDelegateParent is not registered".into());
        }
        let send = std::mem::transmute::<unsafe extern "C" fn(), unsafe extern "C" fn(Id, Sel) -> Id>(
            objc_msgSend,
        );
        let application = send(
            objc_getClass(c"NSApplication".as_ptr()),
            sel_registerName(c"sharedApplication".as_ptr()),
        );
        let delegate = send(application, sel_registerName(c"delegate".as_ptr()));
        if delegate.is_null() || object_getClass(delegate) != class {
            return Err("the application delegate is not a TaoAppDelegateParent".into());
        }
        let selector = sel_registerName(SHOULD_TERMINATE.as_ptr());
        if !class_getInstanceMethod(class, selector).is_null() {
            return Err(
                "the application delegate already answers applicationShouldTerminate:".into(),
            );
        }
        APP.set(app.clone())
            .map_err(|_| "the quit guard was installed twice".to_string())?;
        let added = class_addMethod(
            class,
            selector,
            should_terminate as extern "C" fn(Id, Sel, Id) -> usize as *const c_void,
            SHOULD_TERMINATE_TYPES.as_ptr(),
        );
        if added == 0 {
            return Err("applicationShouldTerminate: could not be added to the delegate".into());
        }
    }
    Ok(())
}
