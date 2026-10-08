# Next ownership decisions

Claude Opus 5.5 read-only consultation, native session `c4be6522-7742-47a0-8d39-51ed9588c0c2`. Completed without errors or permission denials. This is a report; coordinator adjudication is in README.md.

I've grounded both decisions. Nothing was edited and no shell commands were run.

## Decision 1: Capture existing-thought editing

**Answer: no.** Ordinary Markdown list items can't carry exact trailing newlines without new marker metadata or a new private format. Blank thoughts already work. Both points are about the format and the product, not a parser bug.

**Evidence**
- `normalizeThought` (`packages/capture/src/document.ts:418-424`) strips leading and trailing newlines and empties lines that are only whitespace. `encode` normalizes whenever thoughts change (`:570-572`), and the parser drops trailing blank lines from an item (`:310`).
- CommonMark has nothing to fall back on. A paragraph inside an item can't end in a newline: a hard break at the end of a block is not a line break, and leading whitespace in a paragraph is ignored.
- Existing files already treat blank lines between items as spacing. The fixture `* same\r\n\r\n*   same` decodes to `['same','same']` (`body-codec.test.ts:6-12`). If blank lines (or indented whitespace-only lines) meant "trailing newline", that file would read as `['same\n','same']`.
- So any trailing-newline convention changes how existing files read. It would only exist in this app, and tools that trim trailing whitespace (Prettier, VS Code) would silently remove it. That makes it a **new format and a product promise, not a parser fix**.

**Counterexamples if every keystroke were written to the file**

| Typed value | Stored or read back | What happens |
|---|---|---|
| `a` + Enter → `a\n` | `a` (body unchanged, `encode` no-op) | The getter snaps the box back to `a`. You can't start a second line at the end. |
| `a\n\n` (paragraph break) | `a` | Same problem. |
| `a\n` + spaces (indenting a new line) | `a` | The spaces vanish until a non-space character is typed. |
| Enter at the start → `\na` | `a` | The parser could actually read `-\n  a` as `\na`; the encoder normalizes it away. |
| ` a` (leading space) | written as `-  a`, which reads back as `a` | `readsBack` fails, so it's refused as `unverified` and rolled back. Leading indentation can't be typed. |
| `''` (blank) | `-` | **Round-trips** (`body-codec.test.ts:45-55`, and CommonMark accepts an empty item between items). Today's refusal at `draft.svelte.ts:598` is product policy, not a codec limit. |

**Surrounding source:** an immediate edit loses nothing that Save doesn't already lose. The difference is that the whole list gets re-rendered on the first keystroke instead of on Save:
- `*` and `+` markers become `-`.
- Loose lists become tight, because blank lines between items are dropped.
- In continuation lines, a tab that extends past the content indent loses those extra columns (`dedent`, `:98-110`).
- Text and content after the list are kept, and CRLF is kept.

**Two UI blockers for keystroke-level writes**
- `CaptureDetail.svelte:305` wraps the list in `{#key draft.document.thoughts}`. Every accepted write produces a new array, so `ThoughtEditForm` remounts on each keystroke: focus is lost and `focusAtEnd` moves the caret to the end.
- The stale-position guard compares array identity (`draft.svelte.ts:575, 592`; `strandedEdit` at `CaptureDetail.svelte:72-76`). The editor's own write would strand the edit right after the first keystroke.

**Recommendation (smallest honest step, no format change)**
1. Submit `normalizeThought(value)` on each input, but let the edit box keep its exact raw value.
   - Today, `ThoughtEdit.text` is unsubmitted input. It would become the editor's own view of the accepted content: equal to the file except for normalization.
   - A value whose normalized form matches the current thought is a no-op, so pressing Enter no longer erases.
2. After the editor's own successful `set`, point `editing.thoughts` at the new parse. Only outside changes (reload, Source) should still strand an edit.
3. Key the list on something other than the thoughts array, so the form survives the editor's own writes.
4. Strip leading horizontal whitespace from the first line in `normalizeThought`. Markdown can't represent it anyway, so this is an encoder fix, not a format change. Without it, a leading space keeps being refused.
5. Allow blank thoughts to be stored as `-`. "Empty thought" is already rendered at `CaptureDetail.svelte:325`. This is a product decision; I'd flag it to the user rather than auto-delete, because deleting mid-edit would shift positions.
6. Remove Save. On a refusal (e.g. a lone surrogate), restore `editing.text` to the accepted thought and show only the reason.

**What can disappear under this step**
- Trailing or leading newlines and whitespace-only lines, when the edit box closes. This is intended normalization and loses no text.
- Cancel. The only way back is Source or Git history, and native undo across a controlled value is unreliable.
- The list formatting changes above, now happening on the first keystroke instead of on Save.

**Bounded acceptance experiments**
1. **Codec test.** For each value in `a`, `a\n`, `a\nb`, `a\n  `, `\na`, ` a`, `''`, `   `: decoding the encoded result equals `normalizeThought`, and encoding a value that normalizes to the current thought returns the same body. A negative guard: `- a\n\n- b` and the `*   same` fixture still decode unchanged.
2. **Mounted test.** Type `first`, Enter, `second` into an existing thought with the real Textarea:
   - the box reads `first\nsecond` and so does the stored thought;
   - focus stays and the same form instance survives;
   - no stranded-edit alert appears.
3. **Mounted test.** Clear a thought: the file gets `-`; after blur and reload it shows "Empty thought".
4. **Mounted test.** Assign a lone surrogate: a reason appears and the box shows the accepted thought again.
5. **Chrome Guest on a CRLF capture.** Repeat experiment 2 and confirm in Source that CRLF and the content after the list survive.

## Decision 2: Matter body ownership

**Answer: feasible without new shared infrastructure.** While it's mounted, the CodeMirror document can own the accepted content. The store doesn't need to.

**Evidence**
- `MarkdownBodyEditor.svelte:75` seeds the editor once via `untrack`, and `RowDetailDialog.svelte:154` keys it only on `fileName`. So save echoes and watcher deltas never reset the document.
- `saveBody` (`table.svelte.ts:197`) does a serialized read-modify-write per call, with no coalescing (`:128-179`).
- Failures only set `writeError` (`:172-175`), and the promise always resolves. The caller can't tell success from failure.
- `editBody` (`matter-core/src/core/serialize.ts:60-64`) returns `raw` unchanged when the frontmatter doesn't parse. That counts as a silent "successful" write that drops the body.

**Smallest migration (two files)**
1. In `MarkdownBodyEditor`, add `EditorView.updateListener` and call `commitCurrentBody` when `docChanged` is set. Keep the blur and teardown flushes.
2. In `table.svelte.ts`, coalesce `saveBody` per file to the latest value: keep the newest body per file, and enqueue a write only if none is waiting to start. That write reads the newest body when it runs, so a burst of keystrokes costs at most one in-flight write plus one queued write.

**What can disappear**
- **Closing the dialog after a failed last write loses the document.** `submittedBody` is set before the write's outcome is known, so teardown won't resubmit, and there's nowhere left to keep the text. Blur commits already have this problem today.
- The minimal fix is for `write` to return whether it landed and set `submittedBody` only on success. That still can't keep text after destroy; that would need a close guard, which is a separate decision.
- **Body text is dropped silently when the frontmatter doesn't parse** (the `editBody` case above). Immediate writes make this more likely to happen.
- **Outside edits to the body get overwritten on every keystroke instead of on blur.** This was already the behavior, just less often.

**Bounded acceptance experiments**
1. **Table unit test with mocked `invoke`.** 50 rapid `saveBody` calls produce at most 2 `write_entry` calls, and the final content is the last body.
2. **Fail one write mid-typing.** `writeError` is visible, the editor keeps its document, and the next keystroke writes the latest body.
3. **Unparseable frontmatter.** Assert the current silent no-op, then decide to surface it.
4. **Native Tauri vault.** Type continuously while the watcher echoes earlier writes: the document never resets and the file on disk matches.
5. **Close the dialog after a forced write failure.** Record the loss as a known gap.

## Open issues
- Whether persisted blank thoughts and removing Cancel are acceptable is the user's call.
- I didn't check whether `fromRowEditor` exposes the new `row.text` synchronously after `set`. Step 2 of the Capture recommendation depends on that.
- Matter native acceptance is still blocked on the native target.
