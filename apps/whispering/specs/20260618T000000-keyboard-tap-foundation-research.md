# Keyboard-tap foundation: decision + build plan

Status: In Progress (decision made; macOS prototype landed in this worktree)
Date: 2026-06-18
Scope: Whispering desktop global keyboard listener (macOS first), `apps/whispering/src-tauri/src/keyboard/`

> This started as a standalone research artifact in the dev-identity worktree
> (#2084 / #2087). The investigation is now resolved and a prototype exists; the
> two-state lifecycle applies, so delete this spec once the work below ships and
> the durable parts are recorded (the run-loop-bug root cause and the
> own-vs-rent decision are ADR-worthy).

---

## TL;DR

Whispering's "global shortcut stopped working" notice is a **false alarm from a
run-loop-thread bug**, not Accessibility, TCC, or signing. The supervisor runs
the **rustdesk-org/rdev** fork's `listen()` on a **background thread**, but that
fork attaches the event tap to `CFRunLoopGetMain()` and then runs the *calling*
thread's run loop. On a background thread that run loop has no sources, so
`CFRunLoopRun()` returns instantly, `listen()` returns `Ok(())`, and the
supervisor misreads "registered" as "tap died." After 5 restarts it publishes
`Broken`. This hits **release builds too**.

**Decision: A2 — permission-free floor + opt-in Accessibility tier.** The default
experience asks the OS for nothing: global shortcuts are plain chords through
`tauri-plugin-global-shortcut` (Carbon `RegisterEventHotKey`, no Accessibility,
cross-platform), and output is clipboard-only (the user presses paste). A single
Accessibility "door" is the opt-in upgrade that unlocks the two capabilities that
genuinely need it: the **Fn key** for push-to-talk (read, via a CGEventTap) and
**auto-paste at the cursor** (write, via `enigo`). The owned CGEventTap built this
session (`src/keyboard/mac_tap.rs`, the old "Option B") survives as the opt-in
**Tier-1 backend**, woken only when an Fn / modifier-only binding exists. See
"Why A2" below; the grounding that forced it is in the resolved questions.

---

## The bug, proven (unchanged from the research pass; root cause confirmed)

`rustdesk-org/rdev @ a90dbe11`, `src/macos/listen.rs`:

```rust
let current_loop = CFRunLoopGetMain();              // tap source -> MAIN run loop
CFRunLoopAddSource(current_loop, _loop, kCFRunLoopCommonModes);
CGEventTapEnable(tap, true);
CFRunLoopRun();                                      // runs THIS thread's run loop
Ok(())
```

- `Narsil/rdev` (upstream) uses `CFRunLoop::current()` here → correct on a bg
  thread. rustdesk changed it to `CFRunLoopGetMain()` for its own
  main-thread usage. (Confirmed: rustdesk's own `grab.rs` correctly uses
  `CFRunLoopGetCurrent()`; only the `listen` path is wrong.)
- Whispering calls it from `keyboard/mod.rs`'s background thread, so `listen()`
  returns instantly → `spawn_listener` sends `Stopped(None)` → `run_supervisor`
  restarts with backoff `1+2+4+8+16s`, then `phase = Broken`.

Two side effects, **now resolved by the decision** rather than left open:
- The fork's raw FFI never `CFRelease`s the tap, so it leaks onto the main run
  loop and keeps firing (which is why the shortcut probably worked *despite* the
  notice). Each restart adds another leaked tap → duplicate-fire risk.
- Neither rdev fork re-enables a tap macOS disabled via
  `kCGEventTapDisabledByTimeout`/`ByUserInput`.

The owned tap fixes all three by construction (RAII release, single tap,
re-enable loop).

---

## Open questions — RESOLVED

All verified at source level (DeepWiki, `gh`, crate checkouts, on-disk
`~/.cargo` sources), not memory.

1. **Does `handy-keys` capture the Fn key? → YES, first-class.**
   `handy-computer/handy-keys` (the crate is in its own org; `cjpais/Handy`
   consumes `handy-keys = "0.2.4"`). `Modifiers::FN` via `MaskSecondaryFn` +
   keycode `0x3F`, with discrete down/up (`platform/macos/listener.rs:248-270`,
   `keycode.rs:71,253,263`). **But this no longer decides B vs C** — Fn is also
   in our current rustdesk fork (`rdev_map.rs` maps `R::Function → Modifier::Fn`)
   and in Narsil (`Key::Function`). Every candidate has Fn. (Dedicated
   Globe/dictation keycode `0xB0` is an open feature request in handy-keys, not
   the Fn modifier itself.)

2. **`handy-keys` health → code good, project marginal.** MIT. 41 commits, first
   2026-01-14, **last 2026-03-14** (≈3 months silent). 16 stars. Effectively
   single-maintainer (cjpais 34 of 41 commits). Its macOS impl is *better* than
   rdev: correct `CFRunLoopGetCurrent` (`listener.rs:439`), **self-re-enabling
   tap** (`listener.rs:351-359, 471-474`), modifier-state reconciliation,
   channel API, `Drop`+join teardown, and `check_accessibility` /
   `open_accessibility_settings` helpers. Caveats: Linux **wraps rdev**
   underneath (so adopting it is *not* a cross-platform win — we'd keep rdev on
   Linux regardless), and its bundled accessibility URL uses the legacy
   `com.apple.preference.security?Privacy_Accessibility` scheme — the same family
   #2087 just had to fix, so do not trust it blind.

3. **Reproduce in RELEASE build → background thread is identical in prod, so the
   bug is structural, not debug-only.** The defect is in the run-loop semantics
   of the call, not in any debug assertion; the `phase = Broken` path is reached
   the same way in release. (Empirical release repro with a stopwatch on the
   ~31s escalation is the one thing still worth a manual confirmation, but the
   fix lands regardless, so it is not a blocker.)

4. **Does the leaked tap still fire, and do restarts double-fire?** Source
   analysis says: yes the leaked main-loop tap most likely *does* fire (Tauri
   drives the main run loop), and yes each of the ~6 restarts adds another
   leaked tap → genuine duplicate-fire risk. The owned tap moots both (one tap,
   RAII release). **Manual empirical confirmation is still the cheapest way to
   know the current prod severity** — see "What still needs a human" below.

5. **Why was Narsil abandoned for the rustdesk fork? → it never was; the choice
   is undocumented.** `git log -S` shows rdev entered in exactly one commit
   (`5db6e2601`, 2026-06-13) already pinned to the rustdesk fork; **Narsil was
   never in-tree.** The commit explains *why rdev* (Fn + modifier-only +
   key-up/down) but says nothing about *why the rustdesk fork* — it tracked
   Handy's choice. So Option A ("just swap to Narsil") is **not** a clean
   one-liner: Narsil's HEAD did an `objc2-core-foundation` rewrite, changing the
   build surface and the run-loop call shape. It would be a deliberate
   integration change to test, not a quick mitigation. rustdesk's macOS fixes
   (dead keys, IME, USB-HID, session-tap grab) are all on the simulate/grab
   paths Whispering never exercises, so neither direction risks a *listen*-path
   regression. **Verdict: skip the Narsil stopgap entirely.**

6. **Fix the `broken` copy regardless. → DONE** in this worktree
   (`DictationCapabilityNotice.svelte`, the `isStale` branch). It no longer
   asserts "went stale after an update" as the sole cause; it states the
   observable (allowed in Accessibility, but the listener keeps stopping) and
   offers remove-and-re-add as what "usually clears this," not "the fix."

---

## Decision: A2 — permission-free floor + opt-in Accessibility tier

This started as a straight backend choice (own a CGEventTap vs adopt handy-keys)
and ended somewhere better once the real constraint surfaced: **the pain was
never the shortcut, it was Accessibility itself** (the prompt, and the
stale-grant fragility from #2084). Two separate capabilities drag Accessibility
into the product, and they are independent:

- **Reading the Fn key** for push-to-talk → a CGEventTap (a *monitor*).
- **Auto-pasting at the cursor** → synthetic `Cmd/Ctrl+V` via `enigo` (a
  *controller*).

Both are "monitor/control tier" on macOS and share one Accessibility grant.
`tauri-plugin-global-shortcut` (Carbon `RegisterEventHotKey`) is a *subscription*,
not a monitor: it wakes the app for one registered chord and sees nothing else,
so the OS trusts it with **no permission at all** (verified — DeepWiki on
`global-hotkey`: regular keys need no Accessibility/Input Monitoring; only media
keys, which we do not bind, use a tap). It also delivers `Pressed` *and*
`Released`, so push-to-talk on a chord works (Whispering shipped exactly this
before the rdev switch: toggle `Cmd+Shift+;`, PTT `Cmd+Shift+D`).

So the architecture is two tiers:

- **Tier 0 — the floor (default, asks the OS for nothing, cross-platform):**
  global shortcuts are plain chords via the plugin; output is clipboard-only
  (the user presses paste). Works on first launch; nothing to grant, nothing to
  go stale. Desktop now behaves like the browser already does.
- **Tier 1 — the door (opt-in, one Accessibility grant):** turning on *either*
  the Fn key for a binding *or* auto-paste-at-cursor requires Accessibility, and
  that single grant unlocks both. The owned CGEventTap from this session
  (`mac_tap.rs`) is woken **only** when an Fn / modifier-only binding exists; the
  whole `DictationCapability` / supervisor apparatus is dormant until then.

Why not the alternatives: **A1 (plugin only, cut Fn)** was the simpler system but
loses the one PTT ergonomics laptops can't otherwise get — a single key to hold
(see the grill: every comfortable hold key is Fn, which needs Accessibility; no
chord holds well). **Keeping Fn the default** forces the tap (and its
Accessibility + run-loop fragility) onto everyone, which is what we are leaving.
A2 keeps Fn for the people who want it while giving everyone else a floor that
asks for nothing.

The grill that fixed the defaults: a chord is the *right* tool for a toggle (a
~100ms tap; its press-effort is accidental-trigger resistance, a virtue) and the
*wrong* tool for push-to-talk (a multi-second hold; 3-key chords are a one-handed
claw, and the only comfortable 2-key holds collide with macOS defaults). Good PTT
needs a single key; the only one a laptop has is Fn. Hence Fn lives behind the
door, not in the floor.

### Default bindings (Tier 0)

- Toggle recording: `Cmd+Shift+Space` (macOS) / `Ctrl+Shift+Space` (Win/Linux).
- Push-to-talk: unbound by default (opt into Fn behind the door, or a chord).
- Auto-paste at cursor: **off** by default (clipboard-only floor); DONE — the
  `output.transcription.cursor` / `output.transformation.cursor` defaults are now
  `false` (`workspace/definition.ts`).

### One simplification carried over from the owned tap

The flagsChanged press/release decode (the part feared hardest) **collapses to
nothing** for our model: because `Modifier` already collapses left/right, each
`FlagsChanged` event is self-describing (keycode = which modifier, flag bit = up
or down), no prior-state machine needed, shared-bit case correct by construction.
`mac_tap.rs` already implements this and is unit-tested.

---

## Build plan (A2 waves)

Two PRs are already correct and independently shippable; the rest is the A2
re-architecture.

- **Ship now, independent:**
  - **`broken` copy fix** — DONE (`DictationCapabilityNotice.svelte`); correct
    regardless of A2.
  - **Clipboard-only floor** — DONE (`workspace/definition.ts` cursor defaults
    flipped to `false`). Note: this is a *synced* default, so it flips behavior
    for existing users who never explicitly toggled auto-paste; acceptable for a
    pre-release product turn, but worth a release note.

- **Wave 2 — re-introduce the plugin as the Tier-0 backend.** Re-add
  `tauri-plugin-global-shortcut` (Rust dep + npm dep + `capabilities/desktop.json`
  permissions + registration), reversing commit `36726372e` that removed it. A
  thin backend that registers the bound chords and dispatches `Pressed`/`Released`
  into the existing `commands.ts` layer (which already speaks those states, so the
  FE is unchanged). Default toggle = `Cmd+Shift+Space`.

- **Wave 3 — make the CGEventTap Tier-1 / opt-in.** Today `mac_tap` is the
  always-on macOS backend (the interim Option-B wiring). Change `mod.rs` so the
  tap + supervisor spin up **only** when a bound global shortcut needs Fn or a
  modifier-only chord; otherwise the plugin backend is the sole listener and no
  Accessibility is touched. Backend selection is automatic from the bindings (no
  separate "advanced mode" switch) — the capability you ask for is the smallest
  that does the job.

- **Wave 4 — rework capability + notices to the tiered model.** The
  `DictationCapability` notice/guide may appear **only** when an opted-in
  capability (an Fn binding, or auto-paste) needs Accessibility and it is not
  granted. With a pure-chord setup and clipboard output, the notice never shows.
  Auto-paste, when enabled without the grant, surfaces the same one-time prompt.

- **Wave 5 — shortcut capture in plugin mode.** Capturing a chord in settings can
  use a webview keydown handler (chords are ordinary keys); only capturing Fn /
  physical-key positions needs the tap. Keep the rdev/tap-based recorder for the
  Tier-1 path; add the permission-free recorder for Tier 0.

### What still needs a human (cannot be done headless)

- Manual: default (chord) toggle fires with **no** Accessibility prompt on a
  fresh profile; transcript lands on the clipboard.
- Manual: opting into Fn prompts for Accessibility once, then Fn push-to-talk
  fires `Pressed` on down and `Released` on up exactly once.
- Manual: opting into auto-paste prompts for the same grant and then pastes.

### Note on the interim Option-B prototype

`mac_tap.rs` + the `mod.rs` seam + the macOS `core-graphics`/`core-foundation`
deps built this session are **not** wasted: `mac_tap.rs` is the Tier-1 backend.
Only its *wiring* changes in Wave 3 (always-on → woken-on-Fn-binding). The
`broken` copy fix and the clipboard-only default stand on their own.

## Verification commands (reusable)

```sh
# signature of the running dev binary
codesign -dv --verbose=2 <path-to>/target/debug/whispering
# system Accessibility grants (world-readable)
sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" \
  "select client, auth_value, client_type from access where service='kTCCServiceAccessibility';"
# the fork's listen() (the bug)
sed -n '33,69p' ~/.cargo/git/checkouts/rdev-*/a90dbe1/src/macos/listen.rs
# the owned tap + its tests
cargo test -p <whispering-crate> keyboard::mac_tap
```

## Key source references

- `apps/whispering/src-tauri/src/keyboard/mac_tap.rs` — the owned macOS tap (new).
- `apps/whispering/src-tauri/src/keyboard/mod.rs` — supervisor + the platform
  seam in `spawn_listener`.
- `apps/whispering/src-tauri/src/keyboard/{matcher,keys,event}.rs` — the
  preserved, backend-agnostic layers.
- `apps/whispering/src-tauri/src/keyboard/rdev_map.rs` — rdev mapping, now
  `cfg(not(target_os = "macos"))`.
- `apps/whispering/src/lib/components/DictationCapabilityNotice.svelte` — the
  corrected `broken`/`isStale` copy.
- Reference (do not depend on): `handy-computer/handy-keys`
  `src/platform/macos/{listener,keycode,permissions}.rs`; rdev fork
  `src/macos/{grab,listen,common}.rs`; iTerm2 `iTermEventTap.m`.
