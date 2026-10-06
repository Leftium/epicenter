# Honeycrisp rich-state ownership acceptance

Baseline: `15ade372830671b9722e5e6a23ee3b04b0dcb90d`.
Implementation workspace: `/tmp/honeycrisp-rich-owner-20261006`.
Protected input patches are saved alongside this report. They are not task edits.

## Accepted direction

The row editor owns Markdown input and publication. `EditorView.state` owns the
sole transient ProseMirror state. Inspect current body before semantic comparison;
keep equivalent live state and replace different content with fresh state.
Serialization must produce supported, equivalent Markdown. Admit a changed body
before displaying it. Selection and pending marks write nothing.

## Baseline browser observations

Fresh origin `http://localhost:25848/`, task-owned note
`notes/ab0ecf709a.md`, title `Rich binding acceptance 20261006`.

- Enter followed by `two` after `one` creates a second paragraph.
- Source peek followed by Rich Undo returns the body to `one`.
- Type `a | b`, Shift-Enter, then `|---|---|` in Rich: saving succeeds.
  Reload the page and reopen: Rich refuses it as a table and exposes Source.
  This reproduces the serializer/admission mismatch in the actual app.

## Integrated result

`EditorView.state` is the sole live ProseMirror state. `RichSession`,
`syncedBody`, its synchronization API, and cursor clamping are removed.
`rich-text.ts` retains commands, plugins, and stateless admission/reconciliation.
`noteBody` reads the current session on each call, decodes through `rich`, and
submits checked documents through `inputDoc`. Its content cache records only
the last input and decoded answer, never write provenance.

```text
row.body -> inspect/decode -> equivalent? -> keep EditorView.state
                                |
                                +-> different -> fresh state, same plugins
                                `-> unsupported -> Source repair

transaction -> reconcile current body -> check/encode -> admit row edit
                                                      `-> update view
```

The serializer escapes table delimiter text and checks its own output for
unsupported constructs. It also omits leading empty paragraphs, which otherwise
introduced persistent blank lines during Enter/Undo. Source's existing leading
blank lines and newline convention remain preserved by the body writer.

The new rich-text fixture waits for admitted writes before closing its folder.
Existing test consumers were migrated without native production changes.
The README, app constraints, and ADR 0507 describe the final ownership.

## Coordinator verification

| Check | Result |
| --- | --- |
| Focused codec and property tests, before the additional empty-paragraph case | 79 pass |
| Complete non-DOM Honeycrisp suite, final implementation | 316 pass |
| Real mounted NoteDetail tests | 16 pass |
| Rebuilt native close-gate harness and adapted close tests | 26 pass |
| Browser and Tauri Svelte checks, scripts TypeScript check | 0 errors; 0 Svelte warnings |
| Browser and desktop UI builds | Pass |
| Scoped formatting and diff checks | Pass |

Actual browser acceptance confirmed Enter with continued typing, pending bold
through spaces, Undo after Source peek, equivalent Source respelling retaining
Undo, different Source content clearing old history, unsupported HTML exposing
Source, repair restoring Rich, and table-like typed text reopening in Rich after
page reload with the file saved and committed. Screenshots:
[baseline refusal](baseline-reopen.png), [successful Rich reopen](rich-reopen.png).

A 112 KB note opened and accepted contiguous `XYZ` keystrokes. One automation
sequence took 317 ms to fill Source and open Rich; another took 183 ms to type
three characters. These include automation overhead and are functional evidence,
not a latency benchmark. Source showed the inserted characters afterward.

The browser's only captured error was a failed module fetch while the temporary
server was stopped by the interruption. No later browser error was captured.

Pre-existing dirty `file-session.test.ts` and `platform/first-open.test.ts`, and
the staged `packages/device/src/owner.ts`, matched the protected patches byte
for byte before staging this task.

## Review and limits

The independent design review is recorded in
`work/honeycrisp-rich-binding-review-20261006.md`. Implementation worker session:
`fece4d65-280d-4b2a-8ed1-a64adfb41100`, actual model Opus 5.5. The initial run was
interrupted; the resumed run completed. Worker desktop-build commands were
denied by its sandbox; the coordinator ran and verified both builds locally.
Coordinator checks above reproduce acceptance independently of worker reports.

Post-implementation review retained the stateless helpers: semantic replacement
is shared by the follow effect and transaction admission, and admission owns the
write-before-display rule. View lifetime guards, refused input, operation fences,
and newline/timestamp policy retain separate jobs. Historical evidence reports
still mention the deleted API; current source and guidance do not.

Physical IME/composition and a real native window were not exercised. Close-gate
tests prove the page/gate agreement, not physical desktop behavior. The one-entry
decode cache can miss when alternating between different notes, without changing
correctness. Empty paragraphs inside quotes can still change Markdown spelling;
this existing formatting behavior was left outside the ownership refactor.
