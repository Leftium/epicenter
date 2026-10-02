# 0484. Conflict presentation follows the edit being resolved

- **Status:** Proposed
- **Date:** 2026-10-01
- **Unbuilt:** Consistent conflict presentation across application editors.

## Context

This record applies to applications choosing to preserve drafts and offer
conflict review. It does not impose that interaction policy on folder
consumers. Applications may instead adopt external content while typing or
deliberately overwrite current content from a local buffer. Those policies
can discard input or replace another writer's changes.

The Todos editor retains a saved baseline, a local buffer and a current saved
observation when a conditional save conflicts. Honeycrisp also needs to preserve
these distinct values. Detecting a whole-file conflict does not establish that
the person's intended edit conflicts with another person's intended edit.

A title can be understood through two displayed strings and buttons. A long
Markdown document may need a comparison view. Requiring the same three-pane
editor for both transfers unnecessary work to app developers and users.

## Decision

**Apps choosing review expose the information needed to resolve the edit.**
An editor retains three distinct content values for comparison:

| Value | Meaning |
| --- | --- |
| Baseline | The saved content from which the local edit began. |
| Current observation | The latest saved content the editor has read; it can become stale. |
| Draft | The person's current desired content, including unsaved edits. |

The baseline explains what each side changed. A short-field conflict can show
the observed value and draft with explicit choice buttons. A document can show
a difference view and offer the original on demand. The UI exposes the baseline
when it is needed to explain the conflict. There is no mandatory pane count,
Compare button, modal dialog or universal set of resolution actions.

**Review-oriented editors refresh clean content and preserve unresolved local
work.**
A clean editor may adopt an external observation after checking that it remains
clean and has no pending save. A dirty editor retains its baseline and draft.
If the app cannot safely reconcile the changes, it pauses automatic saving and
shows persistent unresolved-save state. A toast alone is insufficient because
it can disappear while the draft remains unsaved.

**Resolution acts on the version presented to the person.**
Keeping or combining local edits uses conditional replacement against the
reviewed capture. A newer observation cannot silently retarget that action.
Adopting external content explicitly discards the draft or preserves a
recoverable copy. Copy recovery is an optional document feature, not a generic
response for settings, records or other files whose duplication changes meaning.

An app may reconcile independent changes when it can establish that the
combined result preserves both intents. File-level conflict detection alone
does not establish that property. Neither an automatic merge engine nor generic
callback replay is required by this convention.

**An uncertain save is distinct from a content conflict.**
An in-flight or unconfirmed save retains its exact submitted content and target
separately from newer typing. The three comparison values do not replace that
attempt state. The UI does not call an unconfirmed save definitely unsaved or
infer command cancellation from an unchanged read.

## Consequences

Apps choosing review share draft-preservation and conditional-resolution rules
without adopting a universal merge interface. Simple editors can omit diff viewers, baseline
panes and automatic merging. Apps still choose resolution actions appropriate
to their data; this convention does not itself provide a reusable controller.

Users decide only when the app cannot establish a safe reconciliation. Some
conflicts require explicit resolution, and comparison against a baseline can
require more context than two final values provide.

## Considered alternatives

- Three panes for every conflict: adds UI and review work even for one title.
- Always hide the baseline: obscures who changed what in overlapping edits.
- Always overwrite the latest observed file: erases changes without resolving
  the person's intent and can overwrite a version never presented.
- Always create a copy: introduces duplicates whose meaning varies by app.
- Promise automatic resolution for every conflict: requires domain semantics
  that ordinary byte-file operations do not supply.
