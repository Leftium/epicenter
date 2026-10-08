# 0506. Capture composes values through a source-preserving body codec

- **Status:** Proposed
- **Date:** 2026-10-06
- **Relates:** [ADR-0504](0504-row-editors-own-complete-input-and-one-publication-queue.md), the complete row editor, and [ADR-0432](0432-captures-hold-ordered-thoughts-beneath-a-dated-timeline.md), Capture's text and ordered thoughts.

## Context

Capture currently switches between Source and interpreted controls for one open
file. Capture's previous operations produced a whole file that the draft framed
again to extract a body. That crossed
Folder's frontmatter boundary twice.

Capture needs to edit text and ordered thoughts while preserving surrounding
Markdown. Exact formatting continuity for individual thoughts adds provenance
metadata and several input shapes. That promise does not help a person select
and edit the entry they clicked: its position already identifies it in the
current list.

## Decision

Capture exposes a fallible body codec named `captureBody`. `decode(body)` reads
`{ text: string, thoughts: string[] }` and view metadata. `encode(value,
currentBody)` reconstructs and verifies a body against its current source.
Encoding never reads a file or owns a save queue.

Callers compose a complete value. Edit and delete select by array position;
addition appends a string; movement reorders the array. Equal strings need no
identity or provenance. The codec preserves surrounding Markdown and writes a
changed Thoughts list as consistent `-` bullets with two-space continuation
indentation and the body's line ending. An unchanged list keeps its bytes.

```ts
const { data: body, error } = captureBody.encode({
  text: currentCapture.text,
  thoughts: currentCapture.thoughts.map((text, i) => i === index ? input : text),
}, editor.row.body);
if (error !== null) {
  // Show the refusal; immediate controls return to accepted content.
  // An explicit Save form retains its unsubmitted input.
  return;
}
editor.set({ ...editor.row, body });
```

Spreading the current editor row preserves its other fields. Folder owns
frontmatter, validation, accepted input, and publication. The Files workspace
edits complete source for repair, through an explicit handoff from Capture.
Immediate controls discard input refused before admission and show its reason.
An explicit thought Save form retains unsubmitted input; accepted input whose
publication fails remains in the editor.

A delayed editing session holds its starting list and selected index. It may
commit only while that list is still current. The draft produces a new list for
each observed source generation, including when source changes away and back to
the same bytes. Delete confirmation also keeps the list it showed. A form has
its own edit-instance identity, and destroyed controls cannot act on a later
session. These are interaction rules; the codec knows no sessions.

Encoding verifies that the resulting Markdown reads as the intended text and
thoughts. For a body without a Thoughts section, appending one preserves the
existing text bytes and consumes its trailing separator lines. Decode reports
that text without those separators, matching the existing append behavior.

[ADR-0507](0507-editor-views-compose-current-input-and-own-only-interaction-state.md)
separates Files source editing from Capture structured editing. Capture does not
switch a mounted editor to Source when its body codec becomes unavailable. It
shows the reason and offers explicit repair navigation while retaining accepted
input and unfinished forms. The current in-detail Source tab remains to migrate.

## Consequences

Capture's write path uses only the row editor and its one publication queue.
The codec needs source spans only to locate regions; thoughts are plain strings.
It holds no provenance map, original item identity, or thought input union.

Editing a list may normalize bullet markers, indentation, and spacing throughout
that list. Surrounding Markdown stays intact. Empty items remain readable and
representable; the app asks for text when adding or saving a thought.

## Considered alternatives

- `{ text, origin? }` thoughts that retain original source spans. This preserves
  each item's formatting through movement, but enlarges the value and the
  encoder for a promise Capture does not need.
- Existing handles, strings, and `{ from, text }` replacements. A union makes
  callers learn operation-shaped inputs instead of composing ordinary values.
- Persistent thought IDs. Thoughts belong to a Markdown list, and a current
  position plus an editing-session check identifies the intended entry.
- Giving Files and Capture independent active save queues for the same file.
  A workspace handoff settles publication before another editor opens; accepted
  input and unfinished forms remain explicitly owned.
