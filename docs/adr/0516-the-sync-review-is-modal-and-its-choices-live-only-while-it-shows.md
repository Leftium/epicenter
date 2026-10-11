# 0516. The sync review is modal and its choices live only while it shows

- **Status:** Proposed
- **Date:** 2026-10-11
- **Relates:** [ADR-0514](0514-folder-sync-resolves-captured-attempts.md) (the attempt and choices), [ADR-0523](0523-applications-own-drafts-in-edit-sessions-and-leave-one-open-item.md) (shared Svelte helpers own lifecycle, apps own wording)
- **Unbuilt:** the review in Vocab, Capture, Honeycrisp, and Whispering.

## Context

`folder.sync.run()` can return a `SyncAttempt` whose conflicts need a
person's choices (ADR-0514). Every app that syncs needs the same comparison
and the same rule for how long unfinished choices last. `@epicenter/folder`
loads no Svelte, so the shared view cannot live there.

## Decision

**While an attempt waits, the page shows one `SyncReview` from
`@epicenter/svelte/sync-review` in place of everything else, and its only
state is that attempt's `SyncChoices`, kept only while it shows.**

```svelte
{#if syncs.attempt}
	{#key syncs.attempt.id}
		<SyncReview attempt={syncs.attempt} {pending} problems={syncs.problems} onCancel={() => syncs.cancel()} onApply={...} />
	{/key}
{/if}
```

- The review is modal. Nothing else on the page takes input while it shows;
  the open item is locked through the controller's `locked`.
- Cancel discards the attempt and its choices. Nothing is remembered, and no
  run starts while an attempt waits. A new attempt starts with no choices.
- One row per conflict, grouped by path: the part, the local version, the
  incoming version, and the result. `Use this` records `take`. Typing records
  `replace`: a body, a file, or a field whose captured versions are all
  strings is edited as text; any other value is edited as JSON and is not
  applied until it parses. `Leave out` records `remove` where allowed.
- Apply calls `onApply(attempt, choices)` once per press with a snapshot the
  review never changes, and only when every conflict has a choice; there is
  no partial submission. The app
  calls `folder.sync.resolve`. `problems` from `SyncError.InvalidChoices`
  show beside their rows while each row still holds the submitted choice
  object; changing the choice clears its note.
- The sides read "This device" and "Remote" unless the app passes `labels`.
- The folder validates and publishes. The review decodes nothing it sends:
  `take` names a side.

**A page keeps the attempt in `createSyncController` from
`@epicenter/svelte/sync`.** It holds `syncing`, `attempt`, `locked`
(from a run's start until its attempt ends), and `problems`, and calls
`folder.sync` between the page's `beforeSync` (wait for the open item's
saves) and `afterSync` (read again). A run that needs choices keeps its
attempt for the review. Refused choices stay as `problems`; any other result
of an Apply ends the attempt, and `cancel()` discards it. `describeSync` in `@epicenter/svelte/sync-line` words each result.

## Consequences

- Choices end with the review: Cancel, a reload, or a new attempt starts
  empty, and a person cannot edit files while deciding, so an Apply is not
  made stale by their own edits in the app.
- Apps own the review's labels and any wording beyond `describeSync`; they
  write no comparison, encoding, attempt bookkeeping, or input lock of their
  own.

## Considered alternatives

- **A review that hides and keeps its choices.** Back and "Review sync"
  let the person edit files while an attempt waited, which made their own
  Apply stale and needed a hidden-review state in every app.
- **A session wrapper around a separate grid.** Two components for one
  lifetime.
- **Carry choices to the next attempt.** A stable conflict ID can name a
  different captured value in the next attempt.
- **A larger editor dialog per row.** Text areas grow and scroll; the dialog
  added focus and cancel rules for little gain.

## Verification

`packages/svelte/src/sync-review.mounted.test.ts` mounts the review in jsdom
and covers both versions per conflict, Apply waiting for every choice,
take, text and JSON replacement, removal, a body with no removal, the
choices handed over once and never changed afterwards, Cancel
discarding the attempt, and refused choices beside their rows.
`packages/svelte/src/sync.svelte.test.ts` covers the controller's hooks,
the lock while an attempt waits, Cancel, refusals, and wording.
