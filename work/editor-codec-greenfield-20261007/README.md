# Direct editor and body codec

Baseline: `155c0823a01c28e53f8a1583904f066ef98cdb04`.

The user accepted current-value getters and complete-row `editor.set` calls, and requested multiple independent adversarial passes followed by delegated implementation. This wave is Honeycrisp only. Unrelated dirty work, including two Honeycrisp tests and staged `packages/device/src/owner.ts`, remains excluded. Baseline protection patches are retained locally beside this report.

## Independent reviews

A fresh GPT 6.1 high reviewer and Claude Opus 5.5 read-only reviewer each inspected actual callers. Each then received the opposing proposal and concrete counterexamples for a second challenge pass. Claude session: `6dcf1d76-45fe-457f-8830-a4e52318dffc`; completed without permission denials.

Initial disagreement: GPT proposed complete-document guarded `set`; Claude proposed `session.body` and `setBody`. In the challenge pass Claude dropped `setBody`: complete-row composition makes the caller's replacement visible and removes patch merging. Both recommend deleting `noteBody`, `BodyDraft`, and the rich-availability conversion. Keep pure decoding/encoding and the real app operation/refusal owner. The existing Honeycrisp-specific widget imports its codec; runtime codec selection would imply schema interchangeability it does not have.

Both reviewers independently exposed an existing no-op admission hole. Enter at the end of `one\n` produces an empty paragraph whose Markdown remains unchanged. `next === previous || input(next)` shows it without asking admission. The coordinator reproduced this using the actual app session, native row editor and ProseMirror transaction with close admission disabled: `displayed: true`, two paragraphs, unchanged file input. This is a correctness issue, not a hypothetical simplification.

Installed Svelte compiler/source confirms a function binding discards the setter's return value. Exact rich-document read-back rejects permitted empty paragraphs; semantic read-back accepts fenced ones. Rich content changes need explicit admission acknowledgment; selection and stored marks remain local.

## Adjudication and assignment

Use one app-owned `NoteEditor.set(completeDocument, {control?})`, with optional `title`, `body`, or `rich` intent. Title and Source preserve their own refused input. Rich respects held Source input but never turns a serialization failure into Source's held value. Unrelated commands protect held fields only when they would change those fields.

Rich unchanged-document acknowledgment checks all admission rules, then skips publication. Generic same-document commands still publish because Restore intentionally standardizes a hand-spelled file. This combines acknowledgment and publication intent in one owner, avoiding a second admission-query protocol. A pure body replacement composer returns the current row on unchanged body and updates an existing timestamp only on actual body change. Historical restoration composes separately and retains the historical timestamp.

Keep `EditorView.state` as the sole live rich state. Accepted content belongs to the row editor; the view owns cursor, marks, history and temporary document structure. Read the current editor prop inside transaction handlers so a rename handoff cannot write to the old editor. Independently decode accepted body before semantic reconciliation.

A fresh Opus 5.5 implementation worker owns `/tmp/honeycrisp-editor-codec-20261007`, cloned from the baseline with dependencies and folder addon prepared. Its brief is retained locally at `/tmp/honeycrisp-editor-codec-brief.txt`. It must return a completed artifact, not partial live edits. Scope: Honeycrisp source and README, excluding the two pre-existing dirty tests. Coordinator owns ADR/instruction updates, integration and browser acceptance.

## Acceptance

Before integration the coordinator reproduced the live baseline: 316 source tests and 16 mounted DOM tests pass. A fresh Chrome Guest note at `http://localhost:25848/` (`notes/04460178a9.md`, title `Direct editor acceptance 20261007`) accepted title input and ordinary `one`, Enter, `two` typing. The original in-app browser is unavailable to the current computer-use surface; browser exercise uses the documented native Chrome interface. Existing unrelated tabs remain untouched.

The pre-integration close-gate suite ran 26 tests: 25 pass, one fails because an assertion hardcodes only `kv.json` and `notes/a.md`, while folder acquisition now also publishes `definition.json`. The rename was correctly refused during close and no move occurred. The test should compare against the opened folder's initial paths, which directly proves this operation created/deleted no files. This grounded stale assertion will be corrected separately from production behavior.

The coordinator reviewed and integrated the completed artifact, then reproduced 327 source tests, 19 mounted DOM tests, 26 close-gate tests, both UI builds and all three typechecks. Native hardware and IME acceptance remain separate.

## Integration review inventory

Files read before analysis (paths under this checkout):

```text
apps/honeycrisp/
|-- AGENTS.md
|-- README.md
|-- native-tests/
|   |-- close.test.ts
|   `-- gate.ts
`-- src/
    |-- lib/
    |   |-- editor/
    |   |   |-- markdown.ts
    |   |   |-- markdown.test.ts
    |   |   |-- rich-text.ts
    |   |   `-- rich-text.test.ts
    |   |-- file-session.svelte.ts
    |   |-- note-editor.svelte.ts (replaces note-session.svelte.ts)
    |   |-- note-editor.test.ts (replaces note-session.test.ts)
    |   |-- note-source.ts
    |   |-- note-source.test.ts
    |   |-- notes.svelte.ts
    |   `-- notes.folder.test.ts
    `-- routes/components/
        |-- NoteDetail.svelte
        |-- NoteDetail.dom.test.ts
        |-- NotesView.svelte
        |-- RichEditor.svelte
        `-- RowDraftStatus.svelte
docs/adr/
`-- 0507-editor-views-compose-current-input-and-own-only-interaction-state.md
packages/folder/src/
`-- editor.ts
```

The public replacement API and refusal/operation owner earn their boundary. The codec owns Markdown admission and syntax conventions. `withBody` owns the shared body-timestamp rule. `stateAfter` owns imperative transaction ordering and uses the actual app editor in tests. No native publisher is exposed for callers to bypass admission.

Two remaining findings are worth correcting before acceptance: `setFields` is a two-call wrapper that hides the desired full-row composition, and RichEditor's invalid-row fallback decodes an invented empty body as supported during removal. Inline Pin/Folder composition; represent unavailable current rich input without inventing content. The deleted adapter lifetime tests are replaced by real mounted control behavior, not another production test port. Timestamp constructor tests still assert the exact supplied value; rich integration verifies actual timestamp movement.

## Completed acceptance

The coordinator removed the two-call `setFields` wrapper, made invalid current rows unavailable to RichEditor instead of decoding invented empty text, and removed the `NoteEditor` re-export through `notes.svelte.ts`. Imports now reach `note-editor.svelte.ts` directly. Typechecks after these edits pass. No former adapter or patch-edit API remains in current Honeycrisp source.

Coordinator checks:

| Check | Result |
| --- | --- |
| Source tests, production browser folder and row editor | 327 pass, 0 fail |
| Mounted NoteDetail tests | 19 pass, 0 fail |
| Real shell close-gate harness with production page client | 26 pass, 0 fail |
| Browser and Tauri page typechecks, scripts TypeScript | Pass, no Svelte errors or warnings |
| Browser UI build and desktop UI build | Pass |
| Diff whitespace check | Pass |
| Protected test changes and staged device patch | Byte-identical to task start |

The worker could not build the close harness offline. The coordinator ran the adapted tests against the existing harness in the live checkout. This proves agreement between page and gate; it does not claim a physical native window closed or that hardware IME input was exercised.

Browser acceptance used actual native computer interaction, not DOM test results. Chrome Guest at `http://localhost:25849/`, note `notes/42304d5f03.md`: ordinary `one`, Enter, `two`; supported pending bold produced `two **bold**`; equivalent Source `__bold__` retained working Undo; saved note reopened after page reload. A punctuation-only bold edit that Markdown cannot spell was correctly refused without changing the body.

A second browser task was using Chrome concurrently. During a later navigation the coordinator briefly changed its tab, restored the original page, and moved acceptance into a task-owned Zen window. No unrelated app actions or form submissions were performed. Build-generated page reloads also interrupted the first run; the coordinator finished builds before the stable final run.

Stable final run in Zen at `http://localhost:25849/`, note `notes/d3ffb0a31e.md`, title `Editor codec acceptance`:

1. Type `one`, Enter, `two`: Source shows `one\n\ntwo\n`.
2. Replace Source with `replacement\n`: Rich displays it with Undo reset.
3. Type ` XYZ`: Source shows contiguous `replacement XYZ\n`.
4. Replace Source with `<b>x</b>\n`: Rich refuses HTML and offers Continue in Source; exact Source remains accessible.
5. Repair Source to `repaired\n`: Rich returns and accepts ` works`.
6. Pin the note: title and body remain. An immediate reload during the unsettled write is refused with a visible reason.
7. Reload once saved: pinned note and `repaired works` persist. Reopen it and type ` reopened`: Source shows `repaired works reopened\n`.

An earlier test origin at port 25848 was refused because its ready marker was missing. Its task data was left intact. Fresh-origin opening and reopening passed after dependency re-optimization, but the cause of that earlier marker absence is not established; it is not attributed to this app-local refactor. No shared folder implementation was changed to bypass its identity check.

The independent challenge passes are complete. No further cleanup wave is justified by the accepted checks. Remaining hardware acceptance and the earlier origin's marker investigation are separate from the verified editor ownership change.
