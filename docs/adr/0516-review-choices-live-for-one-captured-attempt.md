# 0516. Review choices live for one captured attempt

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

**One `SyncReview` from `@epicenter/svelte/sync-review` answers one attempt,
and its only state is that attempt's `SyncChoices`.**

```svelte
{#key attempt.id}
	<SyncReview {attempt} open={reviewing} {pending} {problems} onBack={...} onApply={(attempt, choices) => ...} />
{/key}
```

- The parent keys the review on `attempt.id`, so a new attempt starts with no
  choices. While `open` is false the review renders nothing and keeps its
  choices, so Back and returning show them again. Unmounting discards them.
- One row per conflict, grouped by path: the part, the local version, the
  incoming version, and the result. `Use this` records `take`. Typing records
  `replace`: a body, a file, or a field whose captured versions are all
  strings is edited as text; any other value is edited as JSON and is not
  applied until it parses. `Leave out` records `remove` where allowed.
- Apply calls `onApply(attempt, choices)` once per press with a snapshot the
  review never changes, and only when every conflict has a choice. The app
  calls `folder.sync.resolve`. `problems` from `SyncError.InvalidChoices`
  show beside their rows while each row still holds the submitted choice
  object; changing the choice clears its note.
- The sides read "This device" and "Remote" unless the app passes `labels`.
- The folder validates and publishes. The review decodes nothing it sends:
  `take` names a side.

## Consequences

- A review lost to a reload, another sync, or a new attempt starts empty.
- Apps own when to show the review, its labels, and what a person is told
  after `resolve`; they write no comparison or encoding of their own.

## Considered alternatives

- **A session wrapper around a separate grid.** Two components for one
  lifetime; `open` on one component keeps the same lifetime.
- **Carry choices to the next attempt.** A stable conflict ID can name a
  different captured value in the next attempt.
- **A larger editor dialog per row.** Text areas grow and scroll; the dialog
  added focus and cancel rules for little gain.

## Verification

`packages/svelte/src/sync-review.mounted.test.ts` mounts the review in jsdom
and covers both versions per conflict, Apply waiting for every choice,
take, text and JSON replacement, removal, a body with no removal, the
choices handed over once and never changed afterwards, Back keeping
choices, and refused choices beside their rows.
