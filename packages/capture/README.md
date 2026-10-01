# Capture file model

A capture is one Markdown file, `captures/<stem>.md`, in a folder opened with
`@epicenter/app/files`. The file's bytes are the saved data. There is no Yjs
document, no thought rows, and no IDs for thoughts.

```markdown
---
capturedAt: 2026-10-01T10:30:00+08:00
---

The original capture text.

## Thoughts

- First thought.
- Another thought.
  It can continue across multiple lines.
```

`captureDefinition` declares the one table, `captures`, with one field:
`capturedAt`, an RFC 3339 datetime. A UTC time and a time with an offset are
both valid, so order captures by the parsed instant, never by the string.
Unknown frontmatter keys are kept.

## Reading a capture

`parseCapture(source)` reads the source as the capture text and its ordered
thoughts. markdown-it decides what the blocks are and which lines each owns;
this package maps those ranges to offsets in the source.

| Part | Rule |
| --- | --- |
| Capture text | Everything between the frontmatter and the one root-level `## Thoughts` heading. With no such heading, the whole body. |
| Thoughts | The items of the one bullet list directly under that heading. An item owns what Markdown gives it: continuation lines, later paragraphs, nested lists, code. |
| Everything else | Blocks after that list, and everything from the next root-level heading on, are kept and never read as thoughts. `hasOtherContent` says they exist. |

A line reading `## Thoughts` inside a code fence, an HTML block, a block
quote, or a list item is not the heading.

A document is refused, with `refusal` saying why, when the layout is
ambiguous. Its text and thoughts are then not offered, and the source stays
editable as text:

| `refusal.code` | Cause |
| --- | --- |
| `duplicate-heading` | More than one root-level heading reads "Thoughts". |
| `heading-form` | The Thoughts heading is not `## Thoughts` at the start of a line. |
| `section-shape` | Something other than a bullet list comes first under the heading, or the section holds a second bullet list. |
| `unclosed-frontmatter` | The opening `---` has no closing line. |

## Changing a capture

Every operation takes a parsed document and returns
`{ ok: true, source }` or `{ ok: false, refusal }`. It replaces one span of
the source and leaves every other byte alone: unknown YAML, a byte-order
mark, CRLF lines, original whitespace, nested content, and trailing blocks.

| Operation | Replaces |
| --- | --- |
| `setText(document, text)` | The capture text. Untouched lines keep their own line endings. |
| `addThought(document, text)` | Nothing; inserts after the last thought, or adds the section when there is none. |
| `editThought(document, thought, text)` | That item. |
| `deleteThought(document, thought)` | That item and its separator. |
| `swapThoughts(document, thought, neighbour)` | Exchanges two neighbouring items; the bytes between them stay. |

Two rules make these safe:

- The result is parsed again and accepted only if it reads back as exactly
  the intended text and thoughts. A splice that an unclosed code fence would
  absorb, or that would change a neighbouring thought, is refused
  (`unverified`) and nothing is returned to write.
- A `Thought` belongs to the parse that produced it. An operation accepts
  only a thought of the document it is given, by object identity. A thought
  from any other parse is refused (`stale`) before a span is touched, even
  when the same text sits at the same index. Parse once per source, and pass
  that document and its thoughts.

`fromTextarea(original, value, newline)` carries a textarea's value (always
LF) back into source that may use CRLF, rewriting only the changed middle.
`composeBody(text, thoughts?)` builds a new capture's body: the text exactly
as given, then the `## Thoughts` section. The app and the legacy import both
use it. A capture is the same when reopened as when created:

| Text | Body | Reads as |
| --- | --- | --- |
| Ordinary | text, then the section | That text and those thoughts. |
| Has its own "Thoughts" heading | text, then the section | Two headings: refused as `duplicate-heading`, so the pasted list is never the app's thoughts. |
| Leaves a code fence or HTML block open | text, then the section | The section is absorbed (`absorbed: true`). No thoughts until the text above is closed. |
| Has its own Thoughts list, then an open fence | one empty `## Thoughts` heading, then the text, then the section | Two visible headings: refused as `duplicate-heading`. |

The last row is the only case that writes anything before the text. Without
it the fence would absorb the second heading and the text's own list would
read as thoughts. The text's bytes are whole and in order in every row.

## Importing the old store

`@epicenter/capture/legacy` is for migration only. Nothing in the running app
imports it except the recovery screen, on request.

```ts
import {
  exportLegacyBundle,
  legacyCaptureDefinition,
  readLegacyBundle,
  runLegacyImport,
} from '@epicenter/capture/legacy';

const bundle = exportLegacyBundle(store, { exportedAt, account });
const report = await runLegacyImport(folder.files, bundle);
```

`legacyCaptureDefinition` is the old Personal store: `captures` and `thoughts`
with Yjs text bodies, `entries` from the earlier recursive model, and
`promotions` for a handoff that no longer exists.

**The bundle** is one snapshot of what one device held. It is plain JSON
(`readLegacyBundle` checks a parsed file and refuses one that is not a bundle,
naming each problem). Exporting only reads the store.

- It is bounded: a device that has not finished syncing holds less than the
  account does, and the export cannot tell. `source.scope` is
  `local-replica`.
- A row whose body could not be read has `text: null`. An empty body has
  `text: ''`. They are reported separately.
- A row whose stored values could not be read is in `unreadable`, with its
  raw values and its body text when that was readable.

**The import** writes new files and never replaces one:

| File | Holds |
| --- | --- |
| `captures/legacy-<account>-c-<hash>.md` | One old capture: its exact text, then its thoughts in position order. Its own `capturedAt`. |
| `captures/legacy-<account>-e-<hash>.md` | One old entry, with its own `capturedAt` and `legacyParentId`. |
| `captures/legacy-<account>-o-<hash>.md` | Thoughts whose capture was not in the export. `capturedAt` is the export time, labelled `capturedAtIs`, and the text names the missing capture and the thought IDs. |
| `captures/legacy-<account>-l-<hash>.md` | Thoughts that arrived after their capture was imported. The imported capture is not patched. |
| `recovery/legacy-export-<account>-<bundle>.json` | The bundle. |
| `recovery/legacy-report-<account>-<bundle>.md` | What no document carries: unreadable rows with their raw values, unreadable bodies, held and empty thoughts. |
| `recovery/legacy-import-receipt-<account>.json` | Which old rows have been imported, and where. |

`<account>` is a hash of the authority and principal, so two accounts
importing into one folder share no file name and no receipt. Every imported
file names its source in `importedFrom`.

**Retrying** an import, with the same bundle or a later one, is safe. For
each document the import would write:

| Situation | Result |
| --- | --- |
| The receipt names its source | Skipped, even if the file was since edited or deleted. |
| The destination is absent | Created, then recorded. |
| The destination holds the same bytes | Recorded. This is an earlier run that wrote the file and stopped before the receipt. |
| The destination holds other bytes | Reported as `differs`, left alone, and not recorded. |

Files are written first and the receipt last, so a run that stops partway is
finished by running it again. A row whose body could not be read is neither
imported nor recorded, so a later export that has the body imports it whole;
its thoughts are held with it and their text is kept in the report.

**Bounds.** There are no hidden tombstones:

- Deleting an imported capture does not bring it back, because the receipt
  still names it. Deleting the receipt makes the next import treat every row
  as new; files still in place are then found identical and recorded, and
  deleted ones are created again.
- A file written by a run whose receipt failed, and then edited before the
  retry, is reported as `differs` on every retry until it is renamed or the
  receipt is edited by hand. It is never overwritten.
- Thoughts imported as orphans are imported again inside their capture if a
  later export has that capture. Both documents are kept.
- An unreadable receipt stops the import before anything is written.

## Checks

```sh
bun test packages/capture
bun run --cwd packages/capture typecheck
```

The document tests compare every operation's output with literal expected
bytes. The legacy tests export from a real in-memory store and import into a
real directory.
