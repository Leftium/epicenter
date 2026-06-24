# 0058. Push-to-talk owns the recording it starts, scoped by source and id, not a general lifecycle layer

- **Status:** Proposed
- **Date:** 2026-06-23

## Context

Push-to-talk starts recording on a `Pressed` edge and stops on `Released`, and for a while the edge *was* the whole state machine: nothing owned "this recording came from push-to-talk." Several layers can silently drop the `Released` (a keyboard-tap restart, a binding re-sync, a capture switch, an OS-eaten key-up, or a release that lands before startup has even reached `RECORDING`), and any dropped release left the microphone recording forever. Fixing it meant scoping the stop to the exact session a press started, including the case where the release arrives before that session exists.

## Decision

A push-to-talk press owns a session `{ id, stopRequested }`, and the manual recorder tags its live recording with a `source` of `'manual' | 'pushToTalk'`. Every stop input for a held recording, the real release, the Rust synthetic release, the 5-minute cap, and the capability-loss reconcile, routes through `stopManualRecordingIfOwned('pushToTalk')`, which stops only a matching live session and which a release during startup satisfies by setting `stopRequested` (honored the moment the recording exists). We deliberately do not build a general recording-lifecycle layer: the recorder already owns its session state, so only the source tag and the scoped stop were missing. A backend reconcile hook must call the owned stop, never the generic `stopManualRecording`.

## Consequences

- A stray or duplicated release never stops a toggle or record-button recording: a source mismatch is a no-op.
- A release that lands before startup finishes is latched and honored, closing the lost-edge stuck-on the bare model had.
- `stopManualRecording` becomes idempotent and gains the `stopManualRecordingIfOwned(source)` sibling; the toggle and button paths stay `manual` and unowned.
- Defense is two layers: the Rust matcher synthesizes a `Released` for an abandoned active gesture (restart, re-sync, capture), and the frontend scoped stop handles the startup race and, via the cap, the OS-eaten key-up.
- The 5-minute cap is a safety fuse for the one path with no signal at all (an OS-eaten key-up while the tap stays alive), not the primary stop.
- Cost: a `source` tag the recorder must carry, and the standing discipline that every backend reconcile hook calls the owned variant. This forecloses a generic backend `stopManualRecording()` call, which would cut a legitimate toggle or button recording.

## Considered alternatives

- **A general "recording lifecycle" layer.** Heavier than the code earns; the recorder already owns `_current` / `_starting` / `recordingId`, so a new abstraction would re-home state that already has a home.
- **Check `manualRecorder.state` on `Released`.** Insufficient: a release can arrive while the recording is still starting (`state !== 'RECORDING'` yet), so a state check alone misses the nastiest race.
- **Focus-regain reconcile.** Rejected: global push-to-talk fires while another app is focused, so window focus is the wrong signal for "the hold ended."

## Reference

- Spec: `apps/whispering/specs/20260622T214212-push-to-talk-recording-lifecycle.md` (deep evidence; desktop smoke is the remaining verification).
