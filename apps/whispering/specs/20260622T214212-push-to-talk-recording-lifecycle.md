# Push-to-talk may only stop the recording it started

**Date**: 2026-06-22
**Status**: In Progress
**Owner**: Braden
**Branch**: feat/whispering-ptt-lifecycle

> **Implementation status**: Phase 1 (Rust synthetic-release) and Phase 2 (the
> push-to-talk controller + source-scoped stop + startup latch + 5-minute cap) are
> done and the correctness floor is met: no permanent stuck-on. Verified by
> `cargo test keyboard::matcher` (16 pass), `bun test` (green), and `svelte-check`
> (clean on touched files). Phase 3's explicit reconcile hooks are deferred (the
> synthetic release already covers tap restart / re-sync / capture, and the cap
> covers the rest); desktop smoke (3.3) is the remaining verification.

## One Sentence

A push-to-talk press owns a recording session by source and id, so a `Released` (or any backend reset) stops only the recording that press started, and a lost release edge can no longer leave recording stuck on forever.

## Overview

Push-to-talk starts recording on a `Pressed` edge and stops on `Released`. Today the edge *is* the whole state machine: `Pressed` calls `startManualRecording()`, `Released` calls `stopManualRecording()`, with nothing owning "this recording came from push-to-talk." Several layers can silently drop the `Released`; when they do, recording runs forever. This spec gives push-to-talk a tiny session controller that owns the stop, scoped by source and id, and a Rust synthetic-release as defense in depth. It deliberately does **not** build a general "recording lifecycle" layer.

## How to read this spec

```txt
Read first:   One Sentence, Motivation, The invariant, Implementation Plan, Success Criteria
Read for the model:   Research Findings, Design Decisions, Architecture
Depth:        Edge Cases
```

## The invariant (the whole point)

> Push-to-talk may only stop the recording started by the **same** push-to-talk press, including when the release arrives **before startup finishes**.

Everything below serves that one sentence. The fix is not "own the recording lifecycle"; it is "scope the stop to the session this press started, and never let a backend hook call a generic stop."

## Motivation

### Current State

The Rust matcher drops its active gesture **without** synthesizing a `Released` when it clears held state:

```rust
// matcher.rs:100 — clears held + active, emits nothing
pub fn clear_held(&mut self) {
    self.held_modifiers.clear();
    self.held_keys.clear();
    self.active = None;
}
```

`set_bindings` (`matcher.rs:137`) and `set_capturing` (`matcher.rs:79`) also null `active` silently. A unit test *blesses* the silent drop (`matcher.rs:282`).

On the frontend, the command maps edges straight to start/stop with no owner (`commands.ts:77`), and the manual recorder's state is only `IDLE | RECORDING` (`recording-states.ts:5`) — it cannot tell a push-to-talk recording from a toggle or button one. `recording.ts` has no watchdog (its only `setTimeout` is the VAD resume debounce).

### Problems

All of these leave recording stuck on. Push-to-talk ships **unbound**, so this is reachable only after a user binds it to a global hold:

| Tier | Lost-edge path | Code | Covered by Rust synthetic-release? |
| --- | --- | --- | --- |
| Tier-1 rdev | Listener restart mid-hold → `clear_held` drops active | `matcher.rs:100`, `mod.rs:264` | Yes |
| Tier-1 rdev | Binding re-sync mid-hold → `set_bindings` drops active | `matcher.rs:137` | Yes |
| Tier-1 rdev | OS tap-disable / sleep / lock eats the key-up, tap stays alive | `mac_tap.rs:124` | **No** (nothing clears or restarts) |
| Tier-0 plugin | `registerChords` unregisters mid-hold | `tauri.tauri.ts:358` | Plugin-side analogue |
| Both | `Released` arrives while `startManualRecording()` is still awaiting | `recording.ts:88`, `manual-recorder.svelte.ts:125` | **No** (a frontend race, not a keyboard one) |

The last row is the one the first draft of this spec missed, and it is the nastiest: checking `manualRecorder.state` on `Released` is insufficient because the recording may not be `RECORDING` yet.

### Desired State

A push-to-talk press mints a session `{ id, stopRequested, timer }`; the manual recorder tags its live recording with `{ source, id }`. `Released`, the 5-minute cap, and every backend reconcile hook call `stopManualRecordingIfOwned({ source: 'pushToTalk', id })` — which stops only a matching live session, and which a startup-phase release satisfies via `stopRequested`.

## Research Findings

Sharpened by an independent grill (Codex) against the live code:

- **A general "recording lifecycle" layer is heavier than the code earns.** The recorder already owns session state (`_current`, `_starting`, `recordingId` in `manual-recorder.svelte.ts:55` / `recorder/types.ts:230`). What is missing is a *source/owner tag* and a *scoped stop*, not a new abstraction.
- **`manualRecorder.state` cannot distinguish sources** (`IDLE | RECORDING` only), and `dictationLifecycle` collapses all manual recordings to `{ trigger: 'manual' }` (`dictation-lifecycle.svelte.ts:71`). So a source tag is genuinely required to stop a push-to-talk recording without killing a toggle one.
- **The cap is a safety fuse, not the detection mechanism.** Physical-key polling is not available: two backends (Tier-0 plugin + Tier-1 tap) and `mac_tap` only receives events, with no authoritative "is the chord still down" query (`mac_tap.rs:161`). So the cap is the floor for the OS-eaten-key-up path.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Stop ownership shape | 2 coherence | A tiny push-to-talk controller + a `{ source, id }` tag on the recorder; **not** a general lifecycle layer | The recorder already owns session state; only the source tag and scoped stop are missing. Reuse `recordingId` as the id if it can be threaded in. ADR-worthy once the controller shape lands (Phase 2). |
| Release-before-startup race | 1 evidence | `stopRequested` flag on the session; a release during startup sets it, and start completion stops immediately if set | `recording.ts:88` awaits `startRecording()`; a `Released` in that window finds `state !== RECORDING`. Verified path. |
| Source distinction | 1 evidence | Tag the recorder with `source: 'pushToTalk' \| 'manual'` | `recording-states.ts:5` and `dictation-lifecycle.svelte.ts:71` cannot tell sources apart today. |
| Max-duration cap | 3 taste | Fixed 5 minutes, **not** configurable initially, notify on fire | A blunt fallback for the OS-eaten-key-up path. Push-to-talk is for held dictation; long-form already has toggle recording (`commands.ts:83`). Revisit config only if users hit it. |
| Reconcile scope | 2 coherence | Every backend reconcile hook calls `stopManualRecordingIfOwned`, **never** a generic `stopManualRecording` | A generic stop from a backend hook would cut a legitimate recording. Scoping to the owned session is what makes the hooks safe to fire. |
| Rust synthetic-release | 1 evidence | Emit one `Released` for the active binding from `clear_held`, `set_bindings`, **and** `set_capturing` | All three null `active` silently (`matcher.rs:100,137,79`). Command-agnostic is fine: the frontend filters by `on` (`commands.ts:169`), so a press-only command ignores it. |
| Blessing test | 2 coherence | Keep its invariant; do not weaken | The old test (`matcher.rs:282`) protects "no duplicate later release, no wedged next press." Rewrite it to also assert the synthetic release, not to drop the invariant. |
| Focus-regain reconcile | Rejected | Not used | Global push-to-talk fires unfocused; window focus is the wrong signal. |
| Synthetic-release scope | 1 evidence | Deliver the synthetic abandon release only for push-to-talk, gated in `mod.rs` (the matcher stays command-agnostic) | `openTransformationPicker` also subscribes to `Released` and opens on it (`commands.tauri.ts`); a synthetic release for an abandoned tap-owned picker binding would spuriously open the picker. Only push-to-talk's `Released` means "stop a held action." Found in the implementation grill (Codex). |

## Architecture

```txt
key Pressed ──► ptt.start()
                  ├─ mint session { id, stopRequested:false, timer }
                  ├─ startManualRecording({ source:'pushToTalk', id })   // tags the recorder
                  └─ arm 5-min cap

stop inputs ──► ptt.stop() / ptt.reconcile(reason)
   key Released                   each → stopManualRecordingIfOwned({ source:'pushToTalk', id })
   5-min cap fires                   ├─ recording live & owned  → stop + clear session
   tap restart / re-sync            ├─ still starting          → set stopRequested (stops on completion)
   plugin unregister mid-hold       └─ not owned / not live    → no-op
   capability loss
   manual stop / cancel / overlay  → also clears the session if it stopped the owned recording
   recorder spontaneous IDLE/error → clears the session + timer
```

Two layers, defense in depth:

```txt
Rust matcher: synthetic Released on clear_held / set_bindings / set_capturing  → restart, re-sync, capture
Frontend ptt controller: source/id-scoped stop + stopRequested + 5-min cap     → startup race, OS-eaten key-up
```

## Call Sites: before and after

**Before** (`commands.ts:77`):

```ts
run: (state?: ShortcutEventState) => {
  if (state === 'Pressed') return startManualRecording();
  if (state === 'Released') return stopManualRecording();
},
```

**After** (sketch):

```ts
run: (state?: ShortcutEventState) => {
  if (state === 'Pressed') return ptt.start();   // tags recorder, arms cap
  if (state === 'Released') return ptt.stop();    // stops only this session; handles startup race
},
```

**Semantic shift to flag**: `stopManualRecording` becomes idempotent and gains a `stopManualRecordingIfOwned({ source, id })` sibling. A stray push-to-talk release while a toggle/button recording is live is a no-op (source mismatch). A backend reconcile hook must call the owned variant, never the generic one.

## Implementation Plan

### Phase 1: Rust synthetic-release (defense in depth) — DONE

- [x] **1.1** `clear_held`, `set_bindings`, and `set_capturing` return a synthetic `Released` for any `active` binding via `abandon_active`, instead of dropping it (`matcher.rs`).
- [x] **1.2** `mod.rs` emits those events after dropping the matcher lock: `spawn_listener` (clear_held) and `TapController::set_bindings` / `set_capturing` (which gained an `app` handle), through an `emit_trigger` helper.
- [x] **1.3** Rewrote the blessing test and added two: clear-with-no-active emits nothing, set_capturing abandons an active gesture. `cargo test keyboard::matcher` = 16 pass.

### Phase 2: The push-to-talk controller + source-scoped stop — DONE

- [x] **2.1** The manual recorder tags its live session with `source: 'manual' | 'pushToTalk'` (`currentSource`/`isStarting` getters); `recording.ts` adds `stopManualRecordingIfOwned(source)`, the idempotent owned-stop. The session id + `stopRequested` live in the controller, not the recorder.
- [x] **2.2** `operations/push-to-talk.ts`: `start()` (mint session, start tagged, arm 5-min cap, honor a startup-phase release), `stop()` (owned-stop, latch during startup, clear a stale session). The startup latch is safe because `manualRecorder.startRecording` sets `_starting` synchronously before any await.
- [x] **2.3** `pushToTalk.run` routes to `pushToTalk.start()/.stop()` (`commands.ts`); the toggle/button path stays `manual` and unowned.
- [ ] **2.4** Harvest the ownership decision into a `Proposed` ADR. Deferred until Phase 3 / the design fully settles.

### Phase 3: Precise reconcile hooks + tests — DEFERRED

The correctness floor is already met by Phase 1+2: the synthetic release covers tap restart / re-sync / capture (it routes to `pushToTalk.stop()`), and the 5-minute cap covers the rest (OS-eaten key-up, capability loss). A stale session self-heals on the next press or release. So these are latency polish, not correctness.

- [ ] **3.1** (deferred) Explicit owned-stop reconcile on capability loss, app resume/unlock, JS reload, and manual stop/cancel clearing the session sooner than the cap.
- [ ] **3.2** (partial) Rust matcher tests done. Frontend controller unit tests deferred (the async controller needs a recorder harness; covered for now by review + svelte-check).
- [ ] **3.3** (pending) Desktop smoke: bind Fn push-to-talk, hold, then (a) sleep/wake, (b) lock/unlock, (c) settings re-sync mid-hold; confirm recording stops every time.

## Edge Cases

### Release before startup completes (the central race)

1. `Pressed` → `ptt.start()` begins `startManualRecording()`, which is still awaiting.
2. `Released` arrives; the session is not `RECORDING` yet.
3. `stop()` sets `stopRequested`; when start resolves with the same id, it stops immediately. (Checking `state` alone would miss this.)

### Stray push-to-talk release during a toggle recording

1. A toggle recording is live (source `manual`, unowned by `ptt`).
2. A push-to-talk `Released` fires.
3. `stopManualRecordingIfOwned({ source:'pushToTalk', id })` finds a source mismatch → no-op. The toggle recording continues.

### Synthetic and real release both arrive

1. `clear_held` synthesizes a `Released`; later the real key-up is also delivered.
2. Both reach the owned stop; the second is a no-op (idempotent, session-scoped). The matcher's own "no duplicate release" invariant still holds.

### Recorder stops spontaneously (error, device disconnect)

1. The recorder goes `IDLE` on its own (`recorder/index.tauri.ts:127`).
2. The `ptt` session and its cap timer are cleared, so a later release does not re-stop or wedge.

## Success Criteria

- [ ] Holding a bound global push-to-talk and then sleeping/locking/re-syncing mid-hold always stops recording (no stuck-on).
- [ ] A `Released` that lands before startup finishes still stops the recording.
- [ ] A stray push-to-talk release never stops a toggle/button recording.
- [ ] `clear_held`/`set_bindings`/`set_capturing` emit a `Released` for an active binding; the blessing-test invariant still holds (Rust tests).
- [ ] The 5-minute cap stops a stuck recording and notifies.
- [ ] Typecheck + `bun test` green; desktop smoke (3.3) passes.

## References

- `src-tauri/src/keyboard/matcher.rs` — `set_capturing` (79), `clear_held` (100), `set_bindings` (137), blessing test (282)
- `src-tauri/src/keyboard/mod.rs` — listener restart / where to emit synthesized events (264)
- `src/lib/commands.ts` — `pushToTalk` run + edge filter (77, 169)
- `src/lib/operations/recording.ts` — `startManualRecording`/`stopManualRecording`; the startup await (88)
- `src/lib/state/manual-recorder.svelte.ts` — session state (`_current`, `_starting`) (55); IDLE|RECORDING only
- `src/lib/services/recorder/types.ts` — existing `recordingId` (230)
- `src/lib/tauri.tauri.ts` — Tier-0 plugin callback + `registerChords` (358)
- `src/lib/services/local-shortcut-manager.ts` — the in-app `Released`-on-blur precedent (#2172)
