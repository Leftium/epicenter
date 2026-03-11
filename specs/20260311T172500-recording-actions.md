# Centralize Recording Management Actions

## Problem

Recording management actions (delete, transcribe, download) are copy-pasted across multiple UI surfaces with no shared abstraction. The "confirm → delete → notify" pattern is duplicated verbatim in 3 files:

- `RecordingRowActions.svelte` (single delete)
- `recordings/+page.svelte` (bulk delete)
- `EditRecordingModal.svelte` (single delete from modal)

The existing `actions.ts` centralizes recording **lifecycle** actions (start/stop/cancel/upload) but recording **management** actions have no equivalent.

## Solution

Create `recording-actions.ts` in `$lib/query/isomorphic/` that exports a `recordingActions` object with `deleteWithConfirmation()`. This follows the exact same pattern as the existing `commands` export in `actions.ts`—UI-boundary functions that compose confirmation + rpc call + notification. Not a new layer.

Wire it into the `rpc` namespace as `rpc.recordingActions` so it's accessible everywhere.

## Todo

- [x] Write spec
- [x] Create `$lib/query/isomorphic/recording-actions.ts` with `deleteWithConfirmation`
- [x] Export from `$lib/query/isomorphic/index.ts` into rpc namespace
- [x] Replace delete pattern in `RecordingRowActions.svelte`
- [x] Replace delete pattern in `recordings/+page.svelte` (bulk)
- [x] Replace delete pattern in `EditRecordingModal.svelte`
- [x] Verify LSP diagnostics clean on all changed files

## Decisions

- **New file vs extending actions.ts**: New file. `actions.ts` is 780 lines of recording lifecycle. Clean separation.
- **Home page actions**: Minimal surface is intentional. No changes needed.
- **RecordingRowActions decomposition**: Not worth it. The duplication is in action logic, not component structure.

## Review

### Changes Made

**New file**: `apps/whispering/src/lib/query/isomorphic/recording-actions.ts`
- Exports `recordingActions.deleteWithConfirmation(recordings, options?)` 
- Accepts single `Recording` or `Recording[]` (same signature as `rpc.db.recordings.delete`)
- Optional `onSuccess` callback for post-deletion UI cleanup (e.g., closing a modal)
- Optional `skipConfirmation` flag (passthrough to `ConfirmationDialog`)
- Follows the same pattern as `commands` in `actions.ts`—UI-boundary function, always returns void, errors flow sideways through notifications

**Modified files** (4 existing, net -75 lines / +12 lines):
- `isomorphic/index.ts`: Added import and `recordingActions` to rpc namespace
- `RecordingRowActions.svelte`: 22-line inline delete → single function call, removed unused `confirmationDialog` import
- `recordings/+page.svelte`: 26-line bulk delete → single function call, removed unused `confirmationDialog` import
- `EditRecordingModal.svelte`: 25-line inline delete → single function call with `onSuccess` to close modal (kept `confirmationDialog` import—still used for unsaved changes prompt)

### Behavioral Notes

- The `notify` calls in `recording-actions.ts` use `notify.success(...)` and `notify.error(...)` directly (synchronous fire, same as the existing inline code was calling `rpc.notify.success/error`). These go through the defineMutation pattern in notify.ts which handles both toast + OS notification.
- The `throw error` pattern in `onConfirm` is preserved—this keeps the `ConfirmationDialog` open on failure (its built-in behavior).
- Slight wording normalization: all three sites now use the same messages ("Are you sure you want to delete this recording?" / "these recordings?") instead of the slightly different strings they had before.
