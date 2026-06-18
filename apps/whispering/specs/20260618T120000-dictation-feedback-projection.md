# Dictation feedback as one projected lifecycle state

- **Status:** Draft
- **Decision:** [ADR-0029](../../../docs/adr/0029-dictation-feedback-is-a-projection-of-one-lifecycle-state.md)

Collapse the two drifting feedback mechanisms (the per-step toast log and the
RECORDING-only pill) into one: a single dictation lifecycle value that the pill
and the failure surfaces both project from. Delete the imperative toast sequence,
share one pill component across web and desktop, surface failures by severity,
and make a failed recording row legible and retryable.

## Current state (ground truth)

- `src/lib/recording-overlay/events.ts` — `RecordingOverlayStatus` is a
  discriminated union over `RECORDING` and non-idle VAD states only. The comment
  already encodes the governing rule: idle hides the overlay rather than emitting
  a status.
- `src/lib/recording-overlay/index.tauri.ts` — `recordingOverlay.sync(status)` /
  `reportLevel(level)`. `latestStatus` is the single source of truth for "what
  should show", pushed to the overlay webview over Tauri events.
- `src/lib/recording-overlay/index.browser.ts` — no-op stub.
- `src/routes/recording-overlay/+page.svelte` — the pill UI, welded to Tauri
  `emit`/`listen`. This is why the browser side is a dead stub.
- `src/routes/(app)/_runtime/attach-recording-overlay.svelte.ts` — the main-window
  driver: reads recorder state, calls `recordingOverlay.sync`, routes overlay
  actions back to `stopManualRecording` / `cancelRecording`.
- `src/lib/operations/recording.ts`, `src/lib/operations/pipeline.ts` — fire the
  imperative toast sequence via `report.loading(...).resolve/reject`.
- `src/lib/report/index.ts` — `report.*` fans a notice to console + sonner + OS
  notification. Line 136: OS notification fires only on `error` when
  `!document.hasFocus()`. `report.warning` is the dedup-by-id standing notice.
- `src/routes/(app)/(config)/recordings` — the recordings list route (the durable
  log).

## Target model

One lifecycle value owned by the main window:

```ts
type DictationLifecycle =
  | { phase: 'idle' }
  | { phase: 'recording'; trigger: 'manual' | 'vad'; vadState?: VadState }
  | { phase: 'transcribing' }
  | { phase: 'delivered' }                         // sub-second flash, then idle
  | { phase: 'failed'; error: WhisperingError };   // persists until next dictation
```

Two projections, both derived, neither imperative:

1. **Pill** renders every non-idle phase; `idle` hides it. Most-recent-wins: a new
   dictation takes the pill from an older one.
2. **Exception surface** fires only on `failed`, tiered by severity. No toast in
   the dictation path: the pill is the alert and carries Retry, the recordings row
   is the detail.
   - Silent-loss (recording never started): loudest. Pill red immediately with the
     reason ("No microphone") and retry-in-place; OS notification if unfocused. No
     row exists.
   - Transcription failed: red pill with an inline Retry button; OS notification if
     unfocused. Full error detail lives on the recordings row (Wave 5).
   - Delivery failed (text transcribed, paste/inject failed): quiet. A tinted
     delivered note ("copied to clipboard"); the row records it.

Severity is a property of the `WhisperingError`, read by the projection. Standing
conditions (revoked Accessibility, dead listener, mic gone) stay on the pill's
degraded state and `report.warning`; they are not lifecycle failures.

## Waves

Each wave compiles, passes `bun run check`, and is independently reviewable.

### Wave 1 — Extract the pill into a pure component

Split `recording-overlay/+page.svelte` into a presentational `RecordingPill.svelte`
(props `status`, `level`; callbacks `onStop`, `onCancel`, `onFocusMain`; zero Tauri
imports) plus a thin Tauri adapter that keeps the existing `listen`/`emit` glue and
renders `<RecordingPill .../>`. No behavior change yet; the pill still shows only
RECORDING and VAD. Pure refactor, proves the component is platform-free.

### Wave 2 — Define the lifecycle value and make the pill a projection of it

Introduce `DictationLifecycle` as the single source of truth in the main window
(extend or replace `latestStatus`'s producer in
`attach-recording-overlay.svelte.ts`). Extend `RecordingOverlayStatus` (or its
successor) and `RecordingPill.svelte` to render `transcribing`, `delivered`
(sub-second flash, auto-hide), and `failed` (red, terse `error.title`, clickable).
Drive the value from recorder + pipeline state. Pill now follows a dictation end to
end on desktop. Toasts unchanged this wave.

### Wave 3 — Mount the shared pill on web

Replace the `index.browser.ts` no-op with a mount of the same `RecordingPill` as a
`position: fixed` bottom-center element in the app layout, fed directly from the
lifecycle value (no IPC) and calling recorder functions directly. Desktop and web
now render the identical component.

### Wave 4 — Delete toasts from the dictation path; route failures through the projection

Remove the `report.loading/resolve/reject` step sequence and every success toast
from `recording.ts` and `pipeline.ts`. Add one reactive exception projection over
`DictationLifecycle`: `failed` selects a surface by the error's severity tier
(silent-loss / transcription / delivery). The failed pill carries an inline Retry
action (same callback mechanism as Stop/Cancel in `RecordingPill.svelte`); there is
no toast and no `MoreDetailsDialog` in the dictation flow. Keep the
OS-notification-when-unfocused leg in `report/index.ts` untouched, and keep
`report` itself for non-dictation app messages. Verify the standing-warning path
(`report.warning`) is untouched. The delivered flash plus the opt-in completion
sound carry success.

### Wave 5 — Make failed recording rows the detail surface and log

In the recordings list (`routes/(app)/(config)/recordings`), give a failed
`transcription.status` a clear badge, the full error detail, and a Retry action
that re-runs the pipeline for that recording. This is the failure-detail surface
the pill's Retry and the OS notification both lead to, and the durable log that
replaces any notification center. Wire the failed pill's "open detail" gesture
(the existing focus-main path) to land on this row.

## Open and deferred

- **No notification center / failure-log popover.** Explicitly out of scope. If
  ever justified, it is a filtered view of the recordings table, not a store.
- **Optional "confirm on complete" setting.** Not built now. Hook it to restoring a
  single success toast if the silent default draws complaints.
- **Concurrency.** Most-recent-wins is the rule; do not build a pill queue. A
  superseded failure still reaches the user via the exception projection and its
  recordings row.

## Verification

- `bun run check` green per wave.
- Manual: manual + VAD recording show the pill through transcribe to delivered
  flash on both web and desktop; happy path fires zero toasts.
- Manual: kill transcription (bad key) focused -> red pill, click -> detail with
  Retry; unfocused -> OS notification; recordings row shows failed + Retry works.
- Manual: deny mic -> loudest silent-loss surface, no orphaned waiting state.
