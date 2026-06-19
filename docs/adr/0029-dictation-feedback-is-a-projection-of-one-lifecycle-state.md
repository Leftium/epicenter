# 0029. Dictation feedback is a projection of one lifecycle state, not an event log

- **Status:** Proposed
- **Date:** 2026-06-18

## Context

A dictation moves through one sequence of phases (recording, transcribing,
delivered or failed), but the app reports it through two unrelated mechanisms.
The floating pill (`recording-overlay/`) is a projection of recorder state: one
self-replacing value, the correct shape. The toasts are fired imperatively, step
by step, from `operations/recording.ts` and `operations/pipeline.ts`
("Stopping..." then "Recording stopped" then "Transcribing..." then a success
notice), so a single thing moving through four phases reads as a four-line append
log. Toasts are also doing duty as an informal failure record even though every
failed dictation already persists as a recording row. The pill only represents
`RECORDING` and VAD states today; transcription and failure feedback live
entirely in toasts. With the pill now carrying glanceable in-flight status on
desktop, the per-step toast sequence is redundant noise, and on web (no pill) it
is still the only feedback, so the two platforms have drifted into two models.

## Decision

Dictation feedback derives from one lifecycle value owned by the main window,
modeled as two orthogonal tracks: **capture** (`idle | recording-manual |
listening | speaking`, the live session, derived from the recorder machines) and
**outcome** (`none | transcribing | delivered | failed`, the most-recent
utterance's pipeline result). Every surface is a pure projection, never an
imperative emission. The two tracks exist because voice-activated capture is
*continuous*: an utterance transcribes while the session keeps listening, so
capture and outcome run concurrently. Manual capture is sequential, so its two
tracks never overlap and it reads as one linear phase sequence.

Outcome is most-recent-wins, which is right for the OS-notification path (each
distinct failure notifies once) but too weak for the live pill: a focused VAD
user could miss a failure that the next utterance's spinner or success overwrites
before it is read. So a third fact, an **unreviewed-failure latch**, holds the
failed VAD utterance until the user reviews it (opens its row) or ends the
session (disarm or restart). Failure breaks through; success never clears it.

- The **pill is the status surface.** It projects the pair. When capture is idle
  (manual after stop, or a VAD session after disarm) the outcome is the pill's
  primary content: a transcribing indicator, a sub-second delivered flash, or a
  red failed state with inline Retry. While VAD capture is live, the listening
  meter is the primary content and the outcome rides alongside it as a small
  secondary pip: a spinner while an utterance transcribes, cleared when it lands
  (the delivered text is the receipt, so a continuous session shows no
  per-utterance success flash), and a red mark while an unreviewed failure is
  latched. The latched failure outranks an in-flight spinner, so it stays red
  until reviewed or the session ends, never overwritten by the next utterance.
  Manual keeps the full linear flow unchanged. It is the same Svelte component on both
  platforms; the Tauri build mounts it in a native always-on-top window driven
  over IPC, the web build mounts it as a fixed in-page element driven directly.
  Style, icons, and states are identical by construction; only mount target and
  wiring differ.
- The **happy path emits no toast.** Success is the output: the transcribed text
  landing in the clipboard or cursor is the receipt. The delivered flash plus the
  existing opt-in completion sound are the only success feedback.
- **Failures surface by severity, not as one bucket.** Silent-loss failures
  (recording never started: no mic, denied permission) are the loudest, because
  the user is talking into nothing and there is no artifact to recover. A failed
  transcription is a red pill carrying an inline Retry, because the audio is safe
  in the recordings list. A delivery failure (text transcribed but paste or
  injection failed) is quiet, because the text is in the clipboard. When the
  window is unfocused, a failure also fires the existing OS notification
  (`report/index.ts`, error and unfocused), the one earned platform conditional.
  The exception projection reads the **outcome** track directly, never the
  composed pill value, so a VAD utterance that fails mid-session still notifies
  even though the live meter is what the pill is showing.
- **The dictation path emits no toasts.** The pill is the alert and carries the
  primary action (Retry), the recordings row is the failure-detail surface, and
  the OS notification is the unfocused alert. There is no toast in the dictation
  loop and no `MoreDetailsDialog` step: failure detail lives on the row that holds
  the audio. Toasts survive only for non-dictation app messages outside this
  decision's scope.
- The **recordings list is the only failure log.** A failed dictation is a
  durable recording row, not an ephemeral event. Transient surfaces point at that
  row; they do not store a parallel copy. There is no separate notification
  center or failure-log popover.
- **Standing-condition warnings are not failures.** A revoked Accessibility
  grant, a dead listener, or a disconnected mic is a present condition that
  self-clears, owned by the pill's degraded state and the existing dedup-by-id
  `report.warning`, not the per-event lifecycle.

## Consequences

- The per-step toast sequence is deleted on every platform, and the toast leaves
  the dictation path entirely. The happy path is silent; the pill plus the output
  carry it. The `report.error` / `MoreDetailsDialog` failure-detail wiring is
  removed from the dictation flow, replaced by the pill's inline Retry plus the
  recordings row.
- The browser stops being a second model. `recording-overlay/index.browser.ts`
  stops being a no-op stub and mounts the shared pill, so desktop and web are
  identical by construction rather than kept in sync by discipline.
- One value has one set of consumers, so "what is my dictation doing" and "what
  failed" each have exactly one home (the pill, the recordings list). Toasts stop
  being an accidental, reload-losing log.
- Cost: the latch holds one failure at a time, so in a rapid VAD burst a second
  failure replaces the first on the pip before it is read. This is acceptable
  because the pip is the live glance, not a queue: the durable record is the
  per-failure OS notification (when unfocused) and the recordings rows, which keep
  every failure. The latch only guarantees that *some* unreviewed failure stays
  visible, not that each is individually acknowledged. Capture and outcome no
  longer compete for the pill, so the live meter and the in-flight/failure pip
  render at once instead of one masking the other.
- Cost: extending the pill to terminal phases adds timed transitions (the
  delivered flash auto-hides; the failed state persists until the next dictation),
  which the current RECORDING-only pill did not have.
- We forgo any always-available activity feed. If one is ever justified it must be
  a filtered view of the recordings table, never a parallel store.

## Considered alternatives

- **A dedicated failure-log popover (bottom-right notification center).** Lost
  because it duplicates the recordings list, which is durable, searchable, holds
  the audio, and survives reload, while the popover would be a transient, worse
  copy built as standing infrastructure for a rare event.
- **Keep success toasts for explicit confirmation.** Lost because the output is
  the confirmation; a toast announcing text the user is already watching appear is
  pure redundancy. A single opt-in setting can restore a success toast for the
  minority who want one.
- **Pill on desktop only, toasts remain the web model.** Lost because it freezes
  the two-model drift in place; sharing one component collapses the
  per-platform conditional instead of tuning it.
- **Keep a focused-window failure toast with inline Retry.** Lost because when the
  main window is focused the recordings row and the pill are both already present,
  so the toast is redundant; when unfocused the toast is in a window the user is
  not looking at, so it is useless. The pill's inline Retry plus the OS
  notification cover both, and the pill works cross-app where a toast cannot.
- **Collapse the two tracks into one most-recent-wins value (the original
  shape).** Lost because a live capture masks the outcome: for continuous VAD an
  entire armed session would then show no transcribing, delivered, or failed
  state, silently dropping per-utterance failures and their OS notification. The
  single-value collapse is sound only when capture and outcome are sequential, as
  in manual mode; voice activation makes them concurrent, so they must be two
  tracks.
- **Show a per-utterance delivered flash in VAD too (symmetric with manual).**
  Lost because in continuous dictation the landing text is the receipt, and a
  green flash every few seconds reads as nagging. Comparable continuous-dictation
  apps (superwhisper, live-caption tools) surface processing and errors but not
  per-utterance success. In VAD, success earns no pixels; only in-flight and
  failure do.
