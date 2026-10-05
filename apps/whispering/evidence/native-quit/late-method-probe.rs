//! Does AppKit's `terminate:` ask a method added to the delegate's class
//! after `setDelegate:`? The quit guard (`src-tauri/src/quit.rs`) depends on
//! it, and startup cannot check it. No Tauri, no Tao, no crates.
//!
//!   rustc --edition 2021 -O -o "$TMPDIR/late-method-probe" evidence/native-quit/late-method-probe.rs
//!   "$TMPDIR/late-method-probe"
//!
//! A bare `NSApplication` gets a delegate class built like Tao's: an
//! `NSResponder` subclass that answers `applicationWillTerminate:` and not
//! `applicationShouldTerminate:`. The delegate is set, then the method is
//! added to its class, as the guard does. Once launched, two `terminate:` are
//! posted to the main run loop. The method answers cancel the first time and
//! now the second. Expected, and exit status 0:
//!
//!   {"event":"added","ok":true}
//!   {"event":"should-terminate","asked":1}
//!   {"event":"should-terminate","asked":2}
//!   {"event":"will-terminate","asked":2}
//!
//! A cached "does not respond" would print `added` and then `will-terminate`
//! with `asked` 0, and exit 1. The app never activates and shows no window or
//! Dock icon; it ends only itself, and gives up after 10 seconds.

use std::ffi::{c_char, c_void, CStr};
use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

type Id = *mut c_void;
type Sel = *const c_void;
type Class = *mut c_void;

#[link(name = "AppKit", kind = "framework")]
extern "C" {}

#[link(name = "objc", kind = "dylib")]
extern "C" {
    fn objc_getClass(name: *const c_char) -> Class;
    fn objc_allocateClassPair(superclass: Class, name: *const c_char, extra: usize) -> Class;
    fn objc_registerClassPair(class: Class);
    fn sel_registerName(name: *const c_char) -> Sel;
    fn class_addMethod(class: Class, selector: Sel, imp: *const c_void, types: *const c_char)
        -> u8;
    fn objc_msgSend();
}

static ASKED: AtomicUsize = AtomicUsize::new(0);

fn line(text: String) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{text}");
    let _ = out.flush();
}

fn sel(name: &CStr) -> Sel {
    // SAFETY: a NUL-terminated selector name.
    unsafe { sel_registerName(name.as_ptr()) }
}

unsafe fn send0(receiver: Id, selector: Sel) -> Id {
    let send = std::mem::transmute::<unsafe extern "C" fn(), unsafe extern "C" fn(Id, Sel) -> Id>(
        objc_msgSend,
    );
    send(receiver, selector)
}

unsafe fn shared_application() -> Id {
    send0(
        objc_getClass(c"NSApplication".as_ptr()),
        sel(c"sharedApplication"),
    )
}

/// `NSTerminateCancel` the first time, `NSTerminateNow` after.
extern "C" fn should_terminate(_this: Id, _cmd: Sel, _sender: Id) -> usize {
    let asked = ASKED.fetch_add(1, Ordering::SeqCst) + 1;
    line(format!(
        "{{\"event\":\"should-terminate\",\"asked\":{asked}}}"
    ));
    if asked == 1 {
        0
    } else {
        1
    }
}

extern "C" fn will_terminate(_this: Id, _cmd: Sel, _notification: Id) {
    let asked = ASKED.load(Ordering::SeqCst);
    line(format!(
        "{{\"event\":\"will-terminate\",\"asked\":{asked}}}"
    ));
    if asked != 2 {
        std::process::exit(1);
    }
}

/// Post two `terminate:` to the main run loop, outside this callback.
extern "C" fn did_finish_launching(_this: Id, _cmd: Sel, _notification: Id) {
    // SAFETY: on the main thread; the send is cast to the exact signature of
    // `performSelector:withObject:afterDelay:`.
    unsafe {
        let perform = std::mem::transmute::<
            unsafe extern "C" fn(),
            unsafe extern "C" fn(Id, Sel, Sel, Id, f64),
        >(objc_msgSend);
        let application = shared_application();
        for _ in 0..2 {
            perform(
                application,
                sel(c"performSelector:withObject:afterDelay:"),
                sel(c"terminate:"),
                std::ptr::null_mut(),
                0.0,
            );
        }
    }
}

fn main() {
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(10));
        line("{\"event\":\"timeout\"}".to_string());
        std::process::exit(1);
    });
    // SAFETY: every runtime function is called with its documented prototype
    // and `objc_msgSend` only after a cast to the exact signature of the
    // method it sends, all on the main thread.
    unsafe {
        let application = shared_application();
        // `NSApplicationActivationPolicyProhibited`: no Dock icon, no menu.
        let set_policy = std::mem::transmute::<
            unsafe extern "C" fn(),
            unsafe extern "C" fn(Id, Sel, isize) -> u8,
        >(objc_msgSend);
        set_policy(application, sel(c"setActivationPolicy:"), 2);

        let class = objc_allocateClassPair(
            objc_getClass(c"NSResponder".as_ptr()),
            c"LateMethodProbeDelegate".as_ptr(),
            0,
        );
        assert!(
            !class.is_null(),
            "the probe's delegate class exists already"
        );
        class_addMethod(
            class,
            sel(c"applicationWillTerminate:"),
            will_terminate as extern "C" fn(Id, Sel, Id) as *const c_void,
            c"v@:@".as_ptr(),
        );
        class_addMethod(
            class,
            sel(c"applicationDidFinishLaunching:"),
            did_finish_launching as extern "C" fn(Id, Sel, Id) as *const c_void,
            c"v@:@".as_ptr(),
        );
        objc_registerClassPair(class);
        let delegate = send0(send0(class, sel(c"alloc")), sel(c"init"));
        let set_delegate = std::mem::transmute::<
            unsafe extern "C" fn(),
            unsafe extern "C" fn(Id, Sel, Id),
        >(objc_msgSend);
        set_delegate(application, sel(c"setDelegate:"), delegate);

        // After the delegate is set, as the guard does during Tauri's setup.
        let added = class_addMethod(
            class,
            sel(c"applicationShouldTerminate:"),
            should_terminate as extern "C" fn(Id, Sel, Id) -> usize as *const c_void,
            c"Q@:@".as_ptr(),
        );
        line(format!("{{\"event\":\"added\",\"ok\":{}}}", added != 0));
        if added == 0 {
            std::process::exit(1);
        }

        send0(application, sel(c"run"));
    }
    // `terminate:` ends the process; returning from `run` means it did not.
    line("{\"event\":\"run-returned\"}".to_string());
    std::process::exit(1);
}
