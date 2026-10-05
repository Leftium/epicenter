# Complete-row editing acceptance

**Date:** 2026-10-05
**Status:** In Progress

The implementation direction is recorded in
[ADR 0504](../docs/adr/0504-row-editors-own-complete-input-and-one-publication-queue.md).
The [execution evidence](../packages/folder/evidence/complete-row-editing.md)
records the source baseline, integrated changes, checks, and their limits.

The earlier migration's background observation, unreadable row projection,
application whole-row drafts, submission timers, conflict review, and submitted
copies are retired. One retained owner takes complete input immediately. Saves
use last-publication-wins, pause on failure until Retry, and never recreate a
missing row. Reload deliberately adopts disk content and keeps input on failure.
The Svelte adapter adds tracking without another input owner.

## Remaining acceptance

Browser and native GUI access is unavailable in this execution environment.
Mounted component tests and native command harnesses are separate evidence.
They cannot close these checks:

- In each affected app, type structured and raw text, switch items/views,
  reopen, and verify the actual file's complete metadata/body and line endings.
- In two windows, verify external changes stay out of the open editor until
  deliberate Reload, and a subsequent local edit replaces the complete file.
- Make a save fail, type newer input, and verify Retry publishes that input;
  failed Reload keeps it available. A missing file stays missing until an
  explicit creation operation.
- Exercise actual desktop quit, cancel, and quit anyway with pending or failed
  saves. Keep native hardware/window assertions distinct from harness results.

Use disposable data and identify the built source exercised. When these
journeys are verified, delete this spent acceptance spec. Keep the contract and
results in the ADR and execution evidence.
