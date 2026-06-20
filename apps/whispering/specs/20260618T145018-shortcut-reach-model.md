# Shortcut Reach Model

**Date**: 2026-06-18 (re-baselined 2026-06-20 against `origin/main` @ `f45398d6`)
**Status**: Draft
**Owner**: Braden
**Branch**: thrasher-organ-pipe (planning)

## One Sentence

Replace the "one shortcut backend per platform" rule with a command catalog plus reach-routed keybinding maps, where a shortcut's reach (in-app vs system-wide) is derived from the key, the command's nature, and the platform, not chosen by the user.

## What already landed on main (re-baseline note)

This spec was first written against `ce5d25714` (the #2096 merge). `origin/main` has since moved ~149 commits and a large refactor reshaped the shortcut layer. Re-grounding the spec against current main changes what is left to build:

- Both tiers already speak the structured `KeyBinding`. The web tier stores the readable manual grammar (`"ctrl+shift+a"`) in KV and parses to `KeyBinding` on read (`parseManualBinding`) / serializes on write (`keyBindingToString`); the desktop tier stores `KeyBinding` in device-config. The string-vs-struct split is gone. This was the spec's old Phase 1.3, so 1.3 is done.
- The webview matcher already consumes `KeyBinding`: `local-shortcut-manager.ts` reads `e.code` through `domCodeToKey`, reads modifiers from the event flags through `eventModifiers`, and matches by set-equality (`bindingsEqual`). Teaching the matcher `KeyBinding` is done.
- The two reach-routed stores already exist physically: focused = synced workspace KV (`shortcut.*` in `definition.ts`), system = device-config (`shortcuts.global.*`). What is missing is routing the write by reach instead of by platform-pick-one.
- The `Shortcuts` contract already grew past the old Phase-2 facade sketch: it has `set`, `clear`, `current`, and `findConflict` (per-tier conflict policy: in-app refuses exact duplicates, global refuses reserved gestures and overlaps). The "build a facade" task becomes "add reach-routing over the two backends that already exist."
- The webview matcher already runs inside the Tauri window: `attachLocalShortcutListener` is in the ungated `runtimeOwners` array and `services.localShortcutManager` is a plain service, not a `#platform` seam. The only reason focused shortcuts do not fire on desktop is that nothing populates the matcher's registry there (on desktop `#platform/shortcuts` resolves to the rdev/plugin tier, whose `push()` never touches the matcher `Map`). Making focused shortcuts work on desktop is wiring, not a new backend.

What is genuinely left: the command catalog gains `reach`/`category` and `callback` renames to `run` (the catalog is untouched on main); one platform-computed `DEFAULT_KEYBINDINGS` literal replaces the two default sources; `keyCapability`/`realizedReach` get added beside `resolveBinding`; the reach-router composes both backends on desktop; the settings page collapses to one flat list with a live badge.

## How to read this spec

```txt
Read first:
  One Sentence
  Motivation (Current State, Problems, Desired State)
  The reach model
  Implementation Plan
  Success Criteria

Read if changing the architecture:
  Design Decisions
  Catalogs
  Call sites
  Edge Cases

Decide these:
  Open Questions
```

## Overview

A command is the unit. Every user-meaningful action (toggle recording, cancel, open settings) is a catalog entry keyed by a stable id. A keybinding is just one way to fire a command. How far a binding reaches is a computed property, surfaced to the user as a live badge ("Works in Whispering" / "Works everywhere" / "Works everywhere, needs Accessibility"), never a scope toggle.

## Motivation

### Current State

The app picks **one** shortcut backend per platform through the `#platform/shortcuts` seam:

```ts
// apps/whispering/package.json
"#platform/shortcuts": {
  "tauri":   "./src/lib/platform/shortcuts.tauri.ts",   // system-wide (rdev + plugin), device-config
  "default": "./src/lib/platform/shortcuts.browser.ts"  // in-app (webview keydown), workspace KV
}
```

Bindings are stored in two different shapes:

```ts
// focused (web): string, synced KV, definition.ts
'shortcut.toggleManualRecording': () => ' '        // bare Space

// system (desktop): structured KeyBinding, per-device, device-config.svelte.ts
toggleManualRecording: { modifiers: ['meta','shift'], keys: ['space'] }   // Cmd+Shift+Space
```

Inside the system backend, `#2096` already split each binding into permission tiers:

```ts
// shortcuts.tauri.ts push(): resolveBinding() routes each binding
//   chord -> tauri-plugin-global-shortcut  (Tier 0, no Accessibility)
//   Fn / modifier-hold -> rdev tap          (Tier 1, needs Accessibility)
```

This creates problems:

1. **No focused shortcuts on desktop**: desktop only runs the system backend, so there is nowhere to put in-app navigation like `Cmd+,` to open Settings. The webview keydown manager already works inside the Tauri window; the seam just never loads it there.
2. **Four parallel axes for one fact**: scope (focused/system), tier (chord/tap), backend (browser/tauri), and binding format (string/struct) are all separate decisions, yet each is really re-reading the physical shape of the keystroke. A bare letter cannot be system-wide; a chord can; a hold can but needs a grant.
3. **Scope is a user burden**: the model asks the user to understand "system vs focused" when the keystroke they pick already determines it.

### Desired State

The user picks a key. The system computes and shows the reach. There is no scope toggle.

```txt
"Toggle recording", you press:
  Space     ->  Works in Whispering          (bare key)
  Cmd+Shift+Space ->  Works everywhere        (chord)
  Fn        ->  Works everywhere, needs Accessibility   [Enable]
```

## The reach model

Realized reach is the minimum of three independent ceilings:

```txt
realizedReach = min(
  command.reach,        // intrinsic nature: meaningful outside the app?  focused | global   (default focused)
  keyCapability,        // bare -> focused · chord -> global · hold -> global + Accessibility
  platformCapability,   // web -> focused only · desktop -> global possible
)
```

Worked cases (these are the real defaults and bindings):

| Command | Key | Platform | min(...) | Result |
| --- | --- | --- | --- | --- |
| toggleManualRecording (global) | Space (bare) | web | min(global, focused, focused) | focused, works in-app |
| toggleManualRecording (global) | Cmd+Shift+Space (chord) | desktop | min(global, global, global) | global, no permission |
| toggleManualRecording (global) | Space (bare) | desktop | min(global, focused, global) | focused, only when focused |
| pushToTalk (global) | Fn (hold) | desktop | min(global, global+a11y, global) | global, needs Accessibility |
| openSettings (focused) | Cmd+, (chord) | desktop | min(focused, global, global) | focused, chord cannot escape its nature |

The single irreducible fact per command is `reach: 'focused' | 'global'` (default `focused`). Everything else (mechanism, storage home, permission tier) is a pure function of that bit, the key shape, and the platform.

Naming note: `reach` already names a different axis in this app. `DeliveryReach` (`delivery-reach.ts`, `dictation-lifecycle.markDelivered(reach)`, ADR-0039) is how far a finished transcript got toward its configured output. Shortcut reach is how far a keystroke fires. They are adjacent in the UI and both mean "how far did this get," so the two domains must stay explicitly distinct. Keep `command.reach` and `realizedReach` if every use is qualified by the shortcut context; otherwise rename the shortcut axis (`scope`/`extent`). Settle this when the model becomes an ADR.

### Default rule

> A command's default binding is the most ergonomic key that achieves its intended reach on that platform.

For a `global` command: a chord on desktop (`Cmd+Shift+Space`), a bare key on web (`Space`, since web caps reach at focused and a chord buys nothing there). This is exactly the split `#2096` already shipped.

### Storage: two reach-routed maps (not one)

Bindings live in two maps, **routed by reach, not chosen by the user**:

```ts
type Keybindings = {
  focused: Partial<Record<CommandId, KeyBinding | null>>;  // synced (workspace KV): in-app keys roam
  system:  Partial<Record<CommandId, KeyBinding | null>>;  // per-device (device-config): global keys collide per machine
};
```

Two maps survive (the radical "one map" collapse was rejected, see Design Decisions) because focused and global bindings have genuinely different sync semantics: in-app keys never collide with other apps so they roam, global keys collide machine-by-machine so they stay local. The user never names a map; the reach of the key they pick routes the write.

These two stores already exist on main, split by platform rather than by reach: focused lives in synced workspace KV (`shortcut.*`), system lives in device-config (`shortcuts.global.*`). Today web only ever reads the focused store and desktop only ever reads the system store, because `#platform/shortcuts` picks one backend per platform. The work is to let desktop read both and route each write by realized reach.

Desktop double-binding hazard: the focused defaults that ship today (`toggleManualRecording = space`, `cancelRecording = c`, `toggleVadRecording = v`) are inert on desktop only because the focused backend never runs there. The moment Phase 3 makes the focused backend universal, desktop would fire both `Cmd+Shift+Space` (system) and bare `Space` (focused) for the same toggle, and reintroduce the bare-Space junk-recording the desktop default deliberately avoids. So `DEFAULT_KEYBINDINGS.focused` must be platform-computed: on desktop, recording commands' focused slot is `null` and the focused store seeds navigation only; web keeps `space/c/v/t/r` (web has no system tier). This makes the single-default-literal step (Phase 1.2) a hard precondition of running both backends (Phase 3), not just a tidy-up.

## Research Findings

### How editor-class apps model commands and bindings

| App | Catalog | Bindings | Scope concept |
| --- | --- | --- | --- |
| VS Code | command registry (id, title, category) | `keybindings.json`: `{ key, command, when }` | `when` clause (context), not a stored scope on the command |
| Raycast | command catalog drives the palette | hotkeys assigned per command, global by nature | global vs in-app is per command kind |
| Linear | command palette is primary surface | sparse user-pinned shortcuts | mostly in-app (focused) |

**Key finding**: none store full command objects in the binding file; bindings are `id -> key` overlays over a code-owned catalog. None expose "scope" as a user toggle; reach is either contextual (`when`) or intrinsic to the command.

**Implication**: the catalog-plus-serializable-map shape is the established pattern, and reach-as-intrinsic-command-property (our `command.reach`) matches how these apps treat it.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Reach is derived, not a user scope toggle | 2 coherence | `realizedReach = min(command.reach, keyCapability, platformCapability)` | The keystroke shape already determines in-app vs system; surfacing it as a badge removes a whole user-facing axis. Promote to an ADR on landing. |
| `command.reach` ceiling, default `focused` | 2 coherence | one ordered bit per command | Replaces `allowedScopes` sets; also the only thing that stops a chord like `Cmd+K` from globally hijacking an in-app command. |
| One binding format everywhere (LANDED on main) | 2 coherence | structured `KeyBinding`; string is display/at-rest only | Kills the string-vs-struct split. The web tier now stores manual grammar (`"space"`, `"ctrl+shift+a"`) and parses to `KeyBinding`; the matcher matches on `KeyBinding`. `keyBindingToString` is the deliberate at-rest serializer, keep it. |
| Storage: keep two reach-routed maps | 3 taste | `{ focused: KV-synced, system: device-config }` | Sync semantics differ by reach (in-app roams, global collides per machine). The one-map collapse clobbers a desktop global default with a roamed-in focused binding. Both stores already exist on main, split by platform; reach-routing is what is new. |
| Focused backend runs on every platform | 2 coherence | split `#platform/shortcuts` into a universal focused module plus a Tauri-only system seam (`#platform/system-shortcuts` + browser `null`); a reach-router composes them | Desktop gains in-app nav. The webview matcher already runs in the Tauri window; the missing piece is populating its registry there. The pick-one seam cannot express "both backends on desktop," so it splits rather than loosens. |
| Unified dispatch spine | 2 coherence | every input source (rdev, webview, palette, button) calls `runCommand(id, edge?)` | Generalizes `dispatchCommandTrigger`; the catalog becomes the spine the palette/voice/deep-links hang off later. |
| Global bindings stay per-device for v1 | 3 taste | no roaming, no collision notice | Roaming adds a code family (collision detection + per-device override + notice UI), not deletes one. The `min()` model makes roaming a clean additive step later. |
| Double-binding (focused + system for one command) | Deferred | structurally allowed by two maps, but ship one default per platform | Recording commands default global-only on desktop (focused slot `null`), focused slot is for nav. Users may add a second; we do not ship one. |

## Catalogs

### The Command shape

```ts
type ShortcutScope = 'focused' | 'system';   // storage/reach axis, never user-chosen
type Edge = 'Pressed' | 'Released';

type Command = {
  id: CommandId;                 // stable key
  title: string;                 // settings UI + palette label
  category: string;              // palette grouping / settings section
  keywords?: string;             // extra palette search text
  reach: 'focused' | 'global';   // intrinsic ceiling, default 'focused'
  on?: Edge[];                   // press/release filter (default ['Pressed'])
  run: (edge?: Edge) => void;    // the handler, or dispatch target
};
```

### What was considered and rejected

| Candidate | Why rejected |
| --- | --- |
| `allowedScopes: ShortcutScope[]` per command | Subsumed by one ordered `reach` ceiling; reach is a min(), not a set membership test. |
| One keybinding map `Record<CommandId, KeyBinding>` | A roamed-in focused binding clobbers a per-device global default; two reach-routed maps are earned by sync semantics. |
| User-facing "system vs focused" toggle | The key shape already decides it; a live reach badge teaches without a choice. |
| `platforms` field on a command | Platform availability is already expressed by where the command is declared (shared vs `#platform/commands` seam). |
| Roaming global bindings now | Adds collision machinery; not an asymmetric win. Additive later. |

## Architecture

```txt
input sources                 spine                 backends (by realized reach)
-------------                 -----                 ---------------------------
rdev listener  ─┐
webview keydown ─┼─► runCommand(id, edge) ─► command.run     focused  -> webview matcher (all platforms, KV)
button / click ─┤        (catalog)                            global0  -> plugin chord   (desktop, device-config)
palette (later)─┘                                             global1  -> rdev tap        (desktop, +Accessibility)
```

```txt
write path (settings recorder):
  user presses key
    -> resolve keyCapability(key)               bare | chord | hold
    -> realizedReach = min(command.reach, keyCapability, platformCapability)
    -> route to keybindings.focused or keybindings.system
    -> badge reflects realizedReach
    -> sync() pushes the affected backend
```

## Call sites: before and after

### Command catalog (`apps/whispering/src/lib/commands.ts:49`)

**Before**:

```ts
const sharedCommands = [
  { id: 'toggleManualRecording', title: 'Toggle recording', on: ['Pressed'],
    callback: () => toggleManualRecording() },
  // ...
] as const satisfies SatisfiedCommand[];
```

**After**:

```ts
const sharedCommands = [
  { id: 'toggleManualRecording', title: 'Toggle recording', category: 'Recording',
    reach: 'global', on: ['Pressed'], run: () => toggleManualRecording() },
  { id: 'openSettings', title: 'Open settings', category: 'Navigation',
    reach: 'focused', run: () => goto('/settings') },
  // ...
] as const satisfies Command[];
```

**Semantic shift to flag**: `callback` becomes `run`; every command gains `category` and `reach`. `dispatchCommandTrigger` generalizes to `runCommand`.

### Focused default (`apps/whispering/src/lib/workspace/definition.ts:327`)

**Before** (current main, already re-spelled from the old `' '` space char):

```ts
'shortcut.toggleManualRecording': defineKv(nullable(field.string()), (): string | null => 'space'),
```

**After** (default sourced from one literal; the cell stays `field.string()`, serialized via `keyBindingToString`):

```ts
// reads keyBindingToString(DEFAULT_KEYBINDINGS.focused.toggleManualRecording)
// web => "space"; desktop => null (recording is system-only; focused store seeds nav)
```

**Semantic shift to flag**: the binding format is already structured `KeyBinding` at runtime (the KV cell holds the readable manual grammar and parses on read). What changes here is the default source: the per-key `getDefault` thunks stop hand-spelling values and read the one platform-computed `DEFAULT_KEYBINDINGS` literal instead.

## Implementation Plan

### Phase 1: Catalog and defaults (no behavior change yet)

Phase 1.3 (unify binding format, teach the matcher `KeyBinding`) already landed on main, so the first wave is two standalone, dependency-ordered commits, each green with no behavior change.

- [ ] **1.1** Add `reach` (default `focused`), `category`, optional `keywords` to `SatisfiedCommand`/`Command`; rename `callback` -> `run` (and `commandCallbacks`, `triggerTargetById`, `dispatchCommandTrigger`'s target read, plus the `#platform/commands` impls `commands.tauri.ts`/`commands.browser.ts` and every in-app `.callback` consumer). Tag `toggleManualRecording`, `pushToTalk`, `cancelRecording`, `toggleVadRecording`, `runTransformationOnClipboard` as `reach: 'global'`. Keep `dispatchCommandTrigger` named as-is; generalizing to `runCommand` is the Phase-2 spine.
- [ ] **1.2** Introduce one platform-computed `DEFAULT_KEYBINDINGS = { focused, system }` literal (structured `KeyBinding` values). `system` folds in today's `DEFAULT_GLOBAL_BINDINGS` verbatim; `focused` is platform-aware: web keeps `space/c/v/t/r`, desktop sets recording commands' focused slot to `null` (per the desktop double-binding hazard above). Point `definition.ts` getDefault (`keyBindingToString(DEFAULT_KEYBINDINGS.focused[id])`) and `device-config` defaults at it. Values are byte-identical to today's effective defaults, so this is single-sourcing, not a behavior change. This commit is what makes Phase 3 safe to flip.
- [x] **1.3** (DONE on main) Binding format is already structured `KeyBinding` everywhere; the webview matcher (`local-shortcut-manager.ts`) already consumes `KeyBinding` via `domCodeToKey` + `eventModifiers` + `bindingsEqual`; the manual-grammar string is the at-rest/display form.

### Phase 2: Reach derivation and the reach-router

The `Shortcuts` contract already exposes `set`/`clear`/`current`/`findConflict`, so this is not a from-scratch facade. It is the reach-derivation helpers plus a router that composes the two backends.

- [ ] **2.1** Add `keyCapability(binding)` and `realizedReach(command, binding, platform)` to `utils/key-binding.ts` beside the existing `resolveBinding`.
- [ ] **2.2** Add reach-routing over the two backends that already exist: on write, compute `realizedReach` and route to the focused store or the system store; expose `reachBadge(commandId)`. Reuse the existing `set`/`clear`/`reset`/`findConflict`; do not rebuild them.

### Phase 3: Run both backends on desktop (Build)

- [ ] **3.1** Split `#platform/shortcuts` (the pick-one seam) into a universal focused module that populates the matcher registry on every platform and a Tauri-only system seam; have desktop run both. (Precondition: Phase 1.2, so desktop's focused store does not double-bind recording.)
- [ ] **3.2** Add the first focused nav command (`openSettings` -> `Cmd+,`, via `goto('/settings')`); confirm `Cmd+,` does not register globally on desktop (reach ceiling clamps it).

### Phase 4: Settings UI (Build)

- [ ] **4.1** Collapse the shortcuts page to one flat searchable list (no tauri branch, no scope tabs); render a live reach badge per row from `keybindings.reachBadge`.
- [ ] **4.2** Recorder shows the badge as feedback while capturing; surface the Accessibility `Enable` affordance only when the key resolves to a Tier-1 hold.

### Phase 5: Prove, then Remove

- [ ] **5.1** Typecheck, `bun test`, cargo, svelte-check; smoke both web and desktop.
- [ ] **5.2** Delete the now-dead paths: the dual `getDefault` declarations replaced by `DEFAULT_KEYBINDINGS`, and the old `#platform/shortcuts` "pick one" seam once the split (Phase 3.1) is green. Note the string format is already gone; `keyBindingToString`/`parseManualBinding` are the deliberate at-rest serializers and stay.
- [ ] **5.3** The reach model is recorded as [ADR-0041](../../../docs/adr/0041-shortcut-reach-is-the-minimum-of-command-key-and-platform-ceilings.md) (Proposed). On landing, flip it to Accepted and delete this spec. (See also the article `docs/articles/20260620T120000-reach-is-computed-not-chosen.md`.)

## Edge Cases

### Bare key on a global command, on desktop

1. User binds `Space` to `toggleManualRecording` (reach global) on desktop.
2. `min(global, focused, global) = focused`.
3. Works only when Whispering is focused; routed to the focused (synced) map. Acceptable and intuitive.

### Chord on a focused command

1. User binds `Cmd+,` to `openSettings` (reach focused).
2. `min(focused, global, global) = focused`.
3. Registered in the webview only; never grabbed system-wide. The "make global" affordance is not shown for this row.

### Same command bound in both maps

1. Desktop has `system.toggleManualRecording = Cmd+Shift+Space` and (hypothetically) `focused.toggleManualRecording = Space`.
2. Both fire; both call the same `run`. Harmless but redundant.
3. v1 ships only the system default for recording (focused slot `null`) to avoid the redundancy. See Open Questions.

## Open Questions (resolved)

1. **Should global bindings roam across devices with a collision notice?** RESOLVED: (a) per-device only for v1. Main already stores system bindings per-device with no roaming; (b) would add collision detection, per-device override, and notice UI, a code family rather than a deletion. The `min()` model keeps (b) a clean additive step later.

2. **Do we ship any double-binding (focused + system) by default?** RESOLVED: no. And on main this is load-bearing, not cosmetic: the existing web focused defaults would become an accidental desktop double-binding the moment Phase 3 runs the focused backend there. So `DEFAULT_KEYBINDINGS.focused` is platform-computed (desktop recording slot `null`, focused store seeds nav), folded into Phase 1.2 as a correctness requirement. Users may still add their own second key.

3. **Which nav commands seed the focused scope first?** RESOLVED: just `openSettings` (`Cmd+,`, via the existing `goto('/settings')`). The catalog has zero nav commands today, so this is the first focused-reach entry and the cleanest proof the reach ceiling clamps `Cmd+,` to in-app on desktop. The palette is the payoff that justifies the spine; defer it.

## Success Criteria

- [ ] A command is one catalog entry with `reach`; bindings are two serializable `id -> KeyBinding` maps with one format.
- [ ] Desktop runs focused and system shortcuts at once; `Cmd+,` opens Settings in-app and does not register globally.
- [ ] The settings shortcuts page is one flat list with a live reach badge; no scope toggle, no tauri branch in the page.
- [ ] `toggleManualRecording` defaults to `Cmd+Shift+Space` (desktop) and `Space` (web) sourced from one `DEFAULT_KEYBINDINGS` literal.
- [ ] Typecheck, `bun test`, cargo, and svelte-check pass; web and desktop smoke clean.
- [ ] Reach model recorded as an ADR; this spec deleted.

## References

- `apps/whispering/src/lib/commands.ts` - command catalog (unchanged on main: `callback`, no `reach`/`category`) and `dispatchCommandTrigger` to generalize
- `apps/whispering/src/lib/commands.tauri.ts` / `commands.browser.ts` - the `#platform/commands` seam (desktop-only `openTransformationPicker`); also gains the `run`/`reach` shape
- `apps/whispering/src/lib/platform/shortcuts.{shared,browser,tauri}.ts` - both backends already speak `KeyBinding`; `shared` already exposes `set`/`clear`/`current`/`findConflict`. To re-home by reach (split the pick-one seam).
- `apps/whispering/src/lib/platform/types.ts` - the `Shortcuts` seam contract (already grew `set`/`clear`/`current`/`findConflict`)
- `apps/whispering/src/lib/workspace/definition.ts` - focused defaults (`shortcut.*`, now `'space'`/`'c'`/`'v'`/...) to source from `DEFAULT_KEYBINDINGS`
- `apps/whispering/src/lib/state/device-config.svelte.ts` - system defaults (`DEFAULT_GLOBAL_BINDINGS`, already `Cmd+Shift+Space`)
- `apps/whispering/src/lib/utils/key-binding.ts` - `resolveBinding` (tier), `bindingsEqual`/`eventModifiers`/`domCodeToKey`/`keyBindingToString` (already present); home for `keyCapability` / `realizedReach`
- `apps/whispering/src/lib/services/local-shortcut-manager.ts` - webview matcher (already consumes `KeyBinding`); registry must be populated on desktop
- `apps/whispering/src/lib/tauri.tauri.ts` - `keyboard.registerChords` + `keyboard.setBindings` (Tier 0 / Tier 1 IPC; namespace renamed from `globalShortcuts`)
- `apps/whispering/src/routes/(app)/_runtime/` - `attachLocalShortcutListener` (ungated, runs in the Tauri window), `attachShortcutSync`, `attachGlobalShortcutTriggers`
- `apps/whispering/src/routes/(app)/(config)/settings/shortcuts/` - the page (still `{#if tauri}` scope-split) and recorders to collapse to one flat badged list
