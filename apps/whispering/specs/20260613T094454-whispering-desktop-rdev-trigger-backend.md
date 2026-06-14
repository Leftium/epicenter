# Whispering Desktop Trigger Backend: Replace the Tauri Global-Shortcut Plugin with a Single rdev Hook

**Date**: 2026-06-13
**Status**: Planned (execute after the transformation picker PR merges)
**Owner**: Braden
**Branch**: TBD, its own branch off `main` once the picker work lands

## One Sentence

On desktop, detect global keyboard triggers with a single low-level rdev listener
in Rust (which can see the Fn key, modifier-only chords, and true key-down/key-up)
instead of the Tauri global-shortcut plugin (which cannot), emit `{commandId, state}`
events into the command layer that already exists, and leave the browser in-app
shortcut path completely untouched.

## How to read this spec

This is a backend swap behind a seam that already exists, not a rewrite of the
shortcut system. The command layer (`src/lib/commands.ts`) is already the single
convergence point for every trigger source, and it does not change. Read "The
Current Shape" first to see why only one piece is wrong, then "The Decision" for
what we refuse.

## Why this exists

The desktop global shortcut backend is `@tauri-apps/plugin-global-shortcut`, built
on OS hotkey registration (Windows `RegisterHotKey`, macOS Carbon
`RegisterEventHotKey`). Grounded against the Tauri docs and the global-hotkey
crate, that mechanism has a hard capability ceiling for a dictation app:

- It cannot bind the **Fn key**.
- It cannot bind **modifier-only** chords (for example, hold Right-Cmd alone) or a
  bare single key as a global hold-to-talk.
- It is registration-style ("fire on this combo"), not raw key event delivery, so
  reliable hold-to-talk on arbitrary keys is not its model.

Handy (`cjpais/Handy`), a desktop-only dictation app, solves this with the `rdev`
crate (rustdesk fork): a low-level listener that sees every key down/up
system-wide, plus a custom key model (`handy_keys`) that includes an `FN` modifier
and arbitrary keys, feeding a shared handler that dispatches `start()` on press and
`stop()` on release. We want the same capability, adapted to our constraint that
Whispering also ships a **browser** build.

## The Current Shape (what already works)

The trigger architecture is already the right shape. Three layers:

1. **Command layer** (`src/lib/commands.ts`): state-agnostic commands. Each has
   `on: ShortcutEventState[]` and a `callback(state?)`. The callback owns the
   start/stop logic; the array only says when to fire. This is exactly Handy's
   `is_pressed -> action.start/stop`, in TypeScript.
2. **Two trigger backends, already converging on those callbacks:**
   - Desktop global: the Tauri plugin registrar in `src/lib/tauri.tauri.ts`
     (`tauriRegister(accelerator, (event) => { if (on.includes(event.state)) callback(event.state) })`).
   - In-app / browser: `src/lib/services/local-shortcut-manager.ts` listens to
     window `keydown`/`keyup`, arms on press, fires on the configured states.
3. **Recording operations** (`src/lib/operations/recording.ts`): the callbacks
   (`startManualRecording`, `stopManualRecording`, etc.). Audio capture is already
   platform-split behind `#platform/recorder` (CPAL on desktop, MediaRecorder in
   the browser).

Only one piece is the ceiling: the desktop global backend (the plugin). Everything
else stays.

## The Decision: single rdev backend, delete the plugin path

Product sentence:

> A command owns what to do. The active capture backend (an rdev hook on desktop,
> browser keydown in the web app) owns detecting the trigger and reports
> Pressed/Released. The command layer is the single point where they converge.

The current code matches this sentence except the desktop backend is the limited
plugin. The change: replace the plugin registrar with an rdev-driven Rust module,
behind `#platform/tauri`, and **remove the plugin from the global-trigger path
entirely**. One backend on desktop, not two.

Why single and not Handy's dual (plugin default + rdev opt-in): a second backend is
"two ways to do the same thing," which the greenfield pass flags. The only concrete
behavior the plugin preserves that rdev does not is "global shortcuts work before
the user grants Accessibility." We already require Accessibility for paste-back
(`writeToCursor`) and the new selection capture, so that permission is already on
the core flow. Keeping the plugin only to cover the pre-permission window is not
worth a permanent second code path.

### What changes

- New Rust module `src-tauri/src/keyboard/` (or `shortcut/`, mirroring Handy):
  - `rdev::listen` on a dedicated background thread (passive **listen**, not
    `grab`, so keys still reach the foreground app).
  - A key/binding model that includes an `Fn` modifier and arbitrary single keys
    (mirror `handy_keys`; do not distinguish left/right modifiers in v1).
  - Match held keys against the registered bindings; on a binding's transition,
    `app.emit` a `{ commandId, state: 'Pressed' | 'Released' }` event.
- TS registrar in `src/lib/tauri.tauri.ts` (behind `#platform/tauri`): replace
  `tauriRegister(...)` with a listener for that event that calls the existing
  `command.callback(state)`. The command layer and `local-shortcut-manager` do not
  change.
- Settings: extend the global shortcut recorder
  (`GlobalKeyboardShortcutRecorder`) to capture Fn and single/modifier-only
  bindings. The recorder already reads raw keys; this is mostly a
  validation/format change.

### What does not change

- `src/lib/commands.ts` command definitions and callbacks.
- `src/lib/services/local-shortcut-manager.ts` and the entire browser path.
- `#platform/recorder` and the recording operations.
- Global shortcuts remain **desktop-only**; the Fn-key binding is therefore a
  desktop-only capability. The browser cannot do global shortcuts at all, and that
  is a platform limit we accept, not a gap to close.

## Durable Config: stop and migrate

Global shortcut bindings are stored device-local
(`deviceConfig.get('shortcuts.global.<commandId>')`) as Electron-style accelerator
strings (for example `Command+Shift+D`). rdev needs its own binding
representation (it must express Fn and modifier-only, which the accelerator string
cannot). This is a durable-format change, so it is a stop-and-decide:

- Define a new binding shape that can represent Fn and modifier-only.
- Ship a one-time migration that maps existing accelerator strings to the new
  shape where they are expressible, and resets to defaults where they are not.
  Reset is acceptable here: global shortcut config is device-local convenience
  state, not user content, and the defaults are unchanged in spirit.

## Refused / deferred (record the refusals)

- **The Tauri global-shortcut plugin path.** Refused on desktop. User loss: global
  shortcuts will not fire until Accessibility is granted. Trigger to revisit: if
  pre-permission global shortcuts become a hard product requirement, reintroduce
  the plugin as an explicitly-earned fallback behind the same command layer
  (Handy's dual-backend shape).
- **Left/right modifier distinction.** Deferred. handy_keys does not split them and
  it is rarely worth the confusion. Trigger: a concrete binding a user asks for
  that needs it (for example "right Cmd only").
- **Linux Wayland parity.** rdev's listener is solid on X11 and weak on Wayland
  (same class of limitation the plugin has). Document the gap; do not pretend
  parity. Trigger: Wayland becomes a supported target.

## Cross-cutting notes

- macOS Option-key normalization currently lives in `local-shortcut-manager`
  (Option+A maps to `a`, not the dead-key glyph). With rdev, the desktop path gets
  raw keys in Rust, so normalization for the global path moves to (or is duplicated
  in) the Rust key model. See the prior analyses in `apps/whispering/specs/`
  (`...-alt-key-macos-option1-plan.md`, `...-macos-option-dead-keys-analysis.md`,
  `...-keyboard-layout-code-analysis.md`) before implementing key mapping.
- The recording trigger -> recording-start boundary is identical across platforms
  today (both converge at `startManualRecording`). This swap does not move that
  boundary; it only changes how the desktop trigger is detected.

## Waves (post-merge execution)

1. **Spec lock**: confirm backend choice (single rdev, decided here) and the key
   model. No code.
2. **Rust trigger module**: rdev `listen` background thread, binding model with Fn,
   emit `{commandId, state}` events. Unit-test the matcher with synthetic events.
3. **TS registrar swap**: behind `#platform/tauri`, map events to
   `command.callback(state)`; delete the plugin registration. Verify every existing
   command still fires (push-to-talk press/release, toggles, the picker on
   release).
4. **Config migration**: new binding shape + one-time migration/reset of stored
   global shortcuts.
5. **Settings UI**: capture Fn and single/modifier-only bindings in the global
   recorder; validation and help text.
6. **Permissions + cross-platform**: macOS Accessibility prompt wiring for the
   listener, Windows hook, Linux X11 (document Wayland gap). Real-device test on
   each.

## Success Criteria

- A user can bind Fn (or any single key) as a global push-to-talk and it starts on
  press, stops on release.
- A user can bind a modifier-only global trigger.
- Every existing command keeps working through the new backend with no change to
  `commands.ts`.
- The browser build is byte-for-byte unaffected in its shortcut behavior.
- The Tauri global-shortcut plugin dependency is removed from the trigger path.
- Existing global shortcut config migrates without error (or resets cleanly where
  not expressible).

## References

- `cjpais/Handy` `src-tauri/src/shortcut/{handler.rs,handy_keys.rs,tauri_impl.rs}`
  and `Cargo.toml` (`rdev = { git = "rustdesk-org/rdev" }`): the rdev + custom key
  model + shared handler pattern this mirrors.
- `src/lib/commands.ts`: the command layer (the convergence point; unchanged).
- `src/lib/tauri.tauri.ts`: the desktop registrar to swap.
- `src/lib/services/local-shortcut-manager.ts`: the browser path (unchanged).
- `src/routes/(app)/_layout-utils/register-commands.ts`: default global vs local
  shortcuts.
- `apps/whispering/specs/...-alt-key-macos-option1-plan.md` and the macOS dead-key
  analyses: prior keyboard-mapping art relevant to moving normalization into Rust.
- DeepWiki `tauri-apps/tauri`: confirmed the plugin's OS-registration ceiling and
  that low-level hooks are the recommended bypass for raw push-to-talk.
