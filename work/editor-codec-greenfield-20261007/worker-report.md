# Completed implementation report

Session: `f86fae57-797f-4577-8ea9-169cd02f9c10`; model: Claude Opus 5.5; completed with `is_error: false`.
Permission denials: 4 command attempts; the worker reports recovering with supported file edits/commands. No broader access granted.

The refactor is implemented as specified, and I found no conflict with your contract. All 327 src tests, all 19 mounted DOM tests, the three typechecks, and the browser and desktop UI builds pass. The native close harness did not run: its source is updated and typechecks, but Cargo needs to fetch the `specta` git dependency and network access is off here.

Nothing is committed. The two `git mv` renames are staged; everything else is unstaged. I did not touch `file-session.test.ts`, `first-open.test.ts`, any package, lockfile, `AGENTS.md` or ADR.

## How it works now
- **`NoteEditor.set(doc, {control?})`** replaces `edit` and returns `string | undefined`. The native row editor stays inside the owner.
  - Every call goes through the operation, reload, release, close, path-change and hold gates first, then the valid-row and structured-view check. That includes the rich no-op.
  - Held typed text blocks a call only if it changes that field; the field's own control is never blocked by it.
  - With `rich`, held Source text always blocks, and a refused body is never kept as Source text.
  - The publish is skipped only when the control is `rich` and the document is the current row object itself (`next === row`). Any other call publishes, even an unchanged document.
- **`bodyCodec`** in `markdown.ts`: `decode` wraps `inspectNoteBody` with the one-entry memo. `encode(doc, prior)` returns `Result<string, string>` and keeps leading blank lines and CRLF. `RichAvailability` is gone.
- **`withBody(note, body, now?)`** in `note-source.ts`: it returns the same note object when the body is unchanged, and never adds `updatedAt`. Only Source and rich text use it.
- **`stateAfter(state, tr, editor)`** decodes the current body, reconciles, encodes, then calls `editor.set(withBody(row, body), {control: 'rich'})`. It shows the new state only if `set` accepts it.
- **`RichEditor`** takes `editor` and reads it at each transaction; the `admitting` prop is gone. **`NoteDetail`** composes complete rows in its function bindings. **`notes.svelte.ts`** commands and `useVersion` compose `{...row.fields, ...owned}` and `{...row.fields, ...version.fields}` with `version.body`.

## Judgment calls to review
- **Rich no-op keeps status messages.** It doesn't clear `refusal` or `reloadError`, as before. Clearing `reloadError` there would hide **Save as a note** while the file is still missing.
- **`useVersion` on a note that doesn't read** now returns the existing "field that needs fixing" message, shared with list actions.
- **Source setter** now also checks `live()`; before, it relied only on the Textarea retiring its binding.
- **`RowDraftStatus`** prop is renamed to `editor`. `Selection.session` and the `session` variables in `notes.svelte.ts` are kept, as workflow names.
- **Two test changes are weaker than before:**
  - The rich harness can't inject `now` any more, so it asserts that `updatedAt` changed, not that it equals a fixed time.
  - Two "view that is gone" tests targeted the deleted `mounted` callback. The new DOM toolbar test replacing them doesn't isolate the `Lifetime` guard.

## File inventory
```
apps/honeycrisp/
  README.md                                    paths, layout rows, empty-paragraph sentence
  native-tests/close.test.ts                   bodyCodec.decode + stateAfter(.., draft)
  src/lib/editor/markdown.ts                   + bodyCodec {decode, encode}
  src/lib/editor/markdown.test.ts              + codec tests (moved from note-source.test)
  src/lib/editor/rich-text.ts                  stateAfter takes NoteEditor
  src/lib/editor/rich-text.test.ts             production editor; + Enter/selection gate tests
  src/lib/file-session.svelte.ts               comment path
  src/lib/note-session.svelte.ts -> note-editor.svelte.ts   set() replaces edit(); withChange deleted
  src/lib/note-session.test.ts   -> note-editor.test.ts     set(); + held/rich/timestamp tests
  src/lib/note-source.ts                       withBody; drafts, adapters, memo deleted
  src/lib/note-source.test.ts                  withBody tests
  src/lib/notes.svelte.ts                      NoteEditor; changeFields/useVersion compose
  src/lib/notes.folder.test.ts                 helpers; + restore/version/held-input tests
  src/routes/components/NoteDetail.svelte      prop editor; full-row bindings
  src/routes/components/NoteDetail.dom.test.ts prop rename; + 3 mounted tests
  src/routes/components/NotesView.svelte       editor={selection.session}
  src/routes/components/RichEditor.svelte      prop editor; bodyCodec; no admitting prop
  src/routes/components/RowDraftStatus.svelte  prop editor
```

**Deleted:** `noteBody`, `BodyDraft`, `richAvailability`, `RichAvailability`, `bodyText`, `withChange`, `edit`, the `keep`/`mounted`/`now` adapter options, RichEditor's `draft` and `admitting` props, and NoteDetail's `draft` and `markdown` adapter objects. Production code is 341 lines removed for 304 added.

**New regression tests,** all through the production editor:
- **Rich text:** Enter that leaves the body unchanged writes no body or timestamp, and isn't shown while Source holds refused text, after a stopped delete, or while fenced. Selection is still shown while fenced and writes nothing. A body the editor refuses from rich text never becomes held Source text.
- **Held input:** other fields still change while title or Source text is held; retyping the accepted title clears only the title.
- **Timestamps:** no `updatedAt` is added, a title change doesn't move it, and a restored version keeps its own.
- **Commands:** restoring an open, hand-spelled note that isn't deleted republishes it in canonical form.
- **Mounted (DOM):** swapping the `editor` prop keeps equivalent-content undo history and edits the new row.

I checked the Enter fix by temporarily moving the rich no-op ahead of the gates, as the old `inputDoc` did. Three of the new tests failed, then I reverted it.

## Commands and results
`bun run <script>` can't find `bun` under this sandbox's `/bin/bash`, so I ran the script bodies directly.
- `bun node_modules/@sveltejs/kit/svelte-kit.js sync`: generates `.svelte-kit`. Without it the baseline bundle test failed 2 of 316.
- `bun test --isolate --conditions=browser --path-ignore-patterns='**/*.dom.test.ts' ./src`: **327 pass, 0 fail.**
- `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test --isolate --conditions=browser --conditions=svelte ./src/routes/components/NoteDetail.dom.test.ts`: **19 pass, 0 fail** (baseline 16).
- `node …/svelte-check --tsconfig ./tsconfig.json` and `./tsconfig.tauri.json`: 0 errors, 0 warnings. Under Bun, svelte-check can't load the Vite config, so use Node.
- `node …/tsc -p tsconfig.scripts.json` (covers `native-tests/`): exit 0.
- `NODE_ENV=production node …/vite.js build`, with and without `HONEYCRISP_DESKTOP=1`: both build.
- `cargo build --locked --offline --manifest-path src-tauri/Cargo.toml --example harness`: **fails**, because the `specta` git dependency can't be fetched offline.
- `biome ci` / `biome lint` on changed files: my lines are formatted. The five lint warnings and two unformatted lines left in `notes.folder.test.ts` were already there.

## Still open
1. Run `bun run test:native` where Cargo can fetch `specta`.
2. `apps/honeycrisp/AGENTS.md:69` still names `note-session.svelte.ts` and "the note session"; that file is yours to update.
3. Typing the accepted body back into Source publishes the same document again, by design, since only `rich` skips the publish.
4. The decode memo is still one global entry, as before. Two notes taking turns re-decode, which costs time but doesn't affect correctness.
