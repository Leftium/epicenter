//! Probe: does AppKit's `terminate:` ask `applicationShouldTerminate:` when
//! the method is added to the delegate's class after `setDelegate:`, as
//! `src-tauri/src/quit.rs` does to Tao's delegate? No Tao, no Tauri, no
//! window: a bare NSApplication whose delegate class is built the way Tao
//! builds `TaoAppDelegateParent` (an NSResponder subclass that answers
//! `applicationWillTerminate:` and not `applicationShouldTerminate:`).
//!
//! The first answer is NSTerminateCancel and asks for `terminate:` again; the
//! second is NSTerminateNow. Expected output, one JSON object per line:
//! added, should-terminate 1, should-terminate 2, will-terminate. A delegate
//! whose late method AppKit never asks prints added, then will-terminate.
//!
//! Build and run (macOS, no Cargo):
//!   rustc --edition 2021 -O -o "$TMPDIR/late-method-probe" late-method-probe.rs
//!   "$TMPDIR/late-method-probe"

use std::ffi::{c_char, c_void, CStr};
use std::sync::atomic::{AtomicPtr, AtomicU32, Ordering};

type Id = *mut c_void;
type Sel = *const c_void;

#[link(name = "AppKit", kind = "framework")]
extern "C" {}
#[link(name = "objc", kind = "dylib")]
extern "C" {
    fn objc_getClass(name: *const c_char) -> Id;
    fn objc_allocateClassPair(superclass: Id, name: *const c_char, extra: usize) -> Id;
    fn objc_registerClassPair(class: Id);
    fn sel_registerName(name: *const c_char) -> Sel;
    fn class_addMethod(class: Id, sel: Sel, imp: *const c_void, types: *const c_char) -> u8;
    fn objc_msgSend();
}

fn sel(name: &CStr) -> Sel {
    unsafe { sel_registerName(name.as_ptr()) }
}

fn send0(target: Id, name: &CStr) -> Id {
    unsafe {
        let f: unsafe extern "C" fn(Id, Sel) -> Id =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn() as *const c_void);
        f(target, sel(name))
    }
}

fn send1(target: Id, name: &CStr, argument: Id) {
    unsafe {
        let f: unsafe extern "C" fn(Id, Sel, Id) =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn() as *const c_void);
        f(target, sel(name), argument)
    }
}

/// `[target performSelector:name withObject:nil afterDelay:0]`.
fn later(target: Id, name: &CStr) {
    unsafe {
        let f: unsafe extern "C" fn(Id, Sel, Sel, Id, f64) =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn() as *const c_void);
        f(
            target,
            sel(c"performSelector:withObject:afterDelay:"),
            sel(name),
            std::ptr::null_mut(),
            0.0,
        )
    }
}

static ASKED: AtomicU32 = AtomicU32::new(0);
static APP: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

extern "C" fn should_terminate(_: Id, _: Sel, _: Id) -> usize {
    let asked = ASKED.fetch_add(1, Ordering::SeqCst) + 1;
    println!("{{\"event\":\"should-terminate\",\"asked\":{asked}}}");
    if asked == 1 {
        later(APP.load(Ordering::SeqCst), c"terminate:");
        0
    } else {
        1
    }
}

extern "C" fn will_terminate(_: Id, _: Sel, _: Id) {
    let asked = ASKED.load(Ordering::SeqCst);
    println!("{{\"event\":\"will-terminate\",\"asked\":{asked}}}");
}

fn main() {
    unsafe {
        let app = send0(objc_getClass(c"NSApplication".as_ptr()), c"sharedApplication");
        APP.store(app, Ordering::SeqCst);
        let class = objc_allocateClassPair(
            objc_getClass(c"NSResponder".as_ptr()),
            c"ProbeAppDelegateParent".as_ptr(),
            0,
        );
        class_addMethod(
            class,
            sel(c"applicationWillTerminate:"),
            will_terminate as extern "C" fn(Id, Sel, Id) as *const c_void,
            c"v@:@".as_ptr(),
        );
        objc_registerClassPair(class);
        let delegate = send0(send0(class, c"alloc"), c"init");
        send1(app, c"setDelegate:", delegate);
        // As the guard does: after AppKit holds the delegate.
        let added = class_addMethod(
            class,
            sel(c"applicationShouldTerminate:"),
            should_terminate as extern "C" fn(Id, Sel, Id) -> usize as *const c_void,
            c"Q@:@".as_ptr(),
        );
        println!("{{\"event\":\"added\",\"ok\":{}}}", added != 0);
        later(app, c"terminate:");
        send0(app, c"run");
        println!("{{\"event\":\"run-returned\"}}");
    }
}
