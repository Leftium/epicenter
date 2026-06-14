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
- `src/lib/services/local-shortcut-manager.ts` **source** and the **browser**
  runtime behavior. The manager keeps running unchanged in the browser. The only
  change is that desktop stops *binding* it (see "One system per platform" below).
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

### Binding shape lock (signed off 2026-06-13)

The stored shape is the **structured `KeyBinding` object** the Rust register
command already takes, one representation end to end, no accelerator strings left
on the desktop path:

```jsonc
{ "modifiers": ["meta", "shift"], "keys": ["keyD"] }  // Cmd+Shift+D
{ "modifiers": ["fn"], "keys": [] }                    // Fn alone (modifier-only)
{ "modifiers": [], "keys": ["space"] }                 // bare Space push-to-talk
null                                                    // unbound
```

- `modifiers`: `'ctrl' | 'alt' | 'shift' | 'meta' | 'fn'`. `keys`: physical key
  names (`'keyA'`, `'f1'`, `'space'`, `'semiColon'`, ...), the camelCase of the
  Rust `Key` variants exported by specta.
- The six `shortcuts.global.<commandId>` device-config entries change from
  `string | null` to `KeyBinding | null`; defaults are rewritten as objects.
  Rust's specta `KeyBinding` type is the real validation boundary; device-config
  validates the structure (modifiers enumerated, keys as strings Rust owns).
- Rejected the canonical-string alternative: it keeps two shapes (string in
  storage, struct on the wire) and a parse/serialize grammar to define and test.

One-time migration: read each existing accelerator string, parse modifiers
(`Command/Control/Alt/Option/Shift/Super/Meta`) and the final key token
(letter -> `keyX`, digit -> `numX`, punctuation -> named) into a `KeyBinding`;
reset to the default where a token is not expressible. Reset is acceptable here:
global shortcut config is device-local convenience state, not user content, and
the defaults are unchanged in spirit.

### Forced touch to the command layer (the one exception)

The command layer's behavior does not change, but `commands.ts` re-exports
`ShortcutEventState` from `@tauri-apps/plugin-global-shortcut`
(`ShortcutEvent['state']`). Deleting the plugin means that one type import must
move: `ShortcutEventState` becomes the locally-defined `'Pressed' | 'Released'`
(equivalently, the generated `TriggerState`). This is a type-source swap with
zero behavior change; the command definitions, `on` arrays, and callbacks are
untouched. It is the single unavoidable edit to `commands.ts`.

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

## Wave 1 Lock (signed off 2026-06-13)

The spec choices are confirmed, plus one decision the prose left open: **a desktop
binding matches in physical-key space, not character space.**

rdev delivers both a physical `Key` (US-QWERTY position, modifier-independent) and
a layout-dependent `name: Option<String>` (the produced character). The global
desktop path binds on the **physical `Key`**. Consequences:

- The macOS Option dead-key problem evaporates for the global path: rdev reports
  `Key::KeyA` whether or not Option is held, so there is no `å` glyph to normalize.
  This **deletes** the Option-normalization family for the global path rather than
  porting it to Rust (it does not "move to Rust" as the original cross-cutting note
  assumed; see below).
- Refusal (the asymmetric cost): a non-US-layout user's global hotkey is labeled by
  US-QWERTY position (their physical `A` on AZERTY reads as `Q`). Accepted: a global
  hold-to-talk is a physical key you hold, not a mnemonic. The browser/local path
  keeps `e.key` character matching and stays layout-aware and unchanged.

Locked key model (mirrors `handy_keys`):

```
KeyBinding {
  modifiers: bitflags { Ctrl, Alt, Shift, Meta, Fn },   // Fn is the new capability
  keys:      Set<Key>,                                    // physical rdev keys; may be empty
}
```

- Modifier-only = empty `keys` + non-empty `modifiers`. Single-key push-to-talk =
  empty `modifiers` + one key. Fn = a modifier bit. The plugin could express none.
- Matcher: track the held set from rdev down/up events; **Pressed** on the
  transition into "fully satisfied", **Released** when any required key drops.
- Left/right modifiers collapse (ControlLeft/Right -> Ctrl, etc.). Wayland gap is
  documented, not closed.

### One system per platform (signed off 2026-06-13)

The original spec refused a dual backend on desktop (plugin + rdev) as "two ways
to do the same thing", then kept `local-shortcut-manager` (browser keydown)
**also running on desktop** beside rdev. That is the same dual-backend smell. We
collapse it: **exactly one trigger backend is bound per platform.**

- **Browser**: only `local-shortcut-manager` (window keydown/keyup). Unchanged.
- **Desktop**: only the rdev global backend. Desktop stops calling
  `syncLocalShortcutsWithSettings()` (a platform gate in `register-commands.ts`);
  it binds rdev exclusively.
- `local-shortcut-manager.ts` source stays byte-for-byte; it is simply no longer
  bound on desktop. The browser path is untouched.
- The Settings "Local vs Global" duality collapses: the shortcuts page shows a
  single "Keyboard Shortcuts" table whose backend is the platform's one system
  (rdev recorder on desktop, local recorder in the browser).

Refused (the asymmetric cost): bare-key, focus-gated in-app triggers on desktop
(for example "hold space while the Whispering window is focused, but not while
typing in a text field"). User loss is small and the gesture is a footgun (space
is a common key). rdev **modifier-only** bindings (hold Right-Cmd / Right-Option,
no character, no typing collision) plus Fn are a strictly better answer to the
comfortable-hold-to-talk need that bare-key-local served. Trigger to revisit: a
concrete desktop case that genuinely needs a focus-gated bare key.

This expands **Wave 3** (the registrar swap also adds the desktop platform gate
that stops binding local shortcuts) and **Wave 5** (the settings page collapses
to one table per platform). It does **not** change the Wave 2 Rust module.

## Cross-cutting notes

- macOS Option-key normalization currently lives in `local-shortcut-manager`
  (Option+A maps to `a`, not the dead-key glyph). It stays there for the browser
  path. The global path does **not** inherit it: by binding on rdev's physical
  `Key` (Wave 1 Lock), the desktop path never sees the dead-key glyph, so there is
  nothing to normalize. The prior analyses in `apps/whispering/specs/`
  (`...-alt-key-macos-option1-plan.md`, `...-macos-option-dead-keys-analysis.md`,
  `...-keyboard-layout-code-analysis.md`) document why the browser path needs
  normalization; physical-key matching is the reason the global path does not.
- The recording trigger -> recording-start boundary is identical across platforms
  today (both converge at `startManualRecording`). This swap does not move that
  boundary; it only changes how the desktop trigger is detected.

## Waves (post-merge execution)

1. **Spec lock**: confirm backend choice (single rdev, decided here) and the key
   model. No code.
2. **Rust trigger module**: rdev `listen` background thread, binding model with Fn,
   emit `{commandId, state}` events. Unit-test the matcher with synthetic events.
3. **TS registrar swap + platform collapse**: behind `#platform/tauri`, map events
   to `command.callback(state)`; delete the plugin registration; gate
   `register-commands.ts` so desktop binds only rdev and stops binding local
   shortcuts (see "One system per platform"). Verify every existing command still
   fires (push-to-talk press/release, toggles, the picker on release).
4. **Config migration**: new binding shape + one-time migration/reset of stored
   global shortcuts.
5. **Settings UI**: collapse the Local/Global duality into one "Keyboard
   Shortcuts" table per platform; capture Fn and single/modifier-only bindings in
   the desktop recorder; validation and help text.
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
