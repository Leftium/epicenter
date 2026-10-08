# Immediate editor writes: six surfaces

Source baseline: `17724f7fd6`, 2026-10-08. Preserve unrelated dirty and staged
work, including `packages/device/src/owner.ts`.

The user authorized implementing the six-surface collapse with computer-use
acceptance. Controls read accepted content and submit replacements immediately.
Rejected structured changes restore accepted content and display a reason.
Accepted input whose publication fails remains in its editor. Source stays
accessible for repair. Unsubmitted Add/Send forms remain distinct from edits of
existing content. Existing-thought immediate editing is a pending product question.

| Surface | Accepted investigation and work | Status |
| --- | --- | --- |
| Todos | Remove rejected title/notes overlays and refusal-only operation gates; preserve newline restoration and save failures. | Implemented; evidence below |
| Vocab | Remove rejected note overlay, discard action and refusal-only reload/departure blockers. | Implemented; evidence below |
| Honeycrisp | Remove rejected title/Source overlays; retain required rich widget state and loss-prevention codec. | Implemented; evidence below |
| Capture | Test immediate capture-text rejection and Source repair; consider immediate existing-thought editing separately from Add. | Implemented; evidence below |
| Matter | Removed mirrored CodeMirror draft string; retained blur submission because the store lacks accepted-but-unsaved ownership. | Implemented bounded collapse; native vault acceptance blocked |
| Skills | Inspect live body-node binding; no rejected-input owner found; startup is currently refused. | Source reviewed; UI blocked by product/auth decision |

## Finite ownership cases

1. Accepted editor content: one owner, including failed publication.
2. Rejected structured input: reason-only notice, accepted value remains visible.
3. Invalid raw source: editable source retained for repair.
4. Unsubmitted form: real temporary input until Add/Send.
5. Rich widget: selection, history and intermediate document state, no second save queue.
6. Operations: current publication/path facts and retired-control protections.

## Evidence and remaining work

Initial source inventories came from three independent scoped GPT agents in the
preceding turn. This implementation starts with a fresh GPT/Claude adversarial
design checkpoint. No app acceptance is implied by those source reports.

Baseline and integrated journeys must distinguish browser, native hardware and
provider acceptance. Use disposable local data and trace the version exercised.
Record worker reports separately from checks reproduced by Codex.

## Baseline evidence

- Codex reproduced 50 passing Todos/Vocab owner tests and 51 passing Honeycrisp
  owner/rich tests. Capture owner tests: 47 passed, 1 failed before edits
  (`whitespace typed into the new-capture form is refused and still protected`).
- Chrome Guest at localhost:25853: created todo
  `todos/16b5a499-e52a-4cff-aa45-ec78a5323c9c.md`, edited notes, opened exact
  Source. At localhost:25854: added expression `acceptance`, edited its note,
  changed stage, and reloaded; accepted note and stage remained.
- Capture localhost:25855, capture `20261008-014801-0x0d2`: created text and a
  thought, pasted an unclosed code fence into Capture text. The attempted value
  stayed outside the file with a pending notice. Source showed accepted text
  and the thought list, proving the repair route is accessible.
- Honeycrisp old origin localhost:25852 failed opening because its folder had
  no ready marker. No user data was changed to repair it. Fresh localhost:25857
  opened, created `notes/6e6fea51de.md`, accepted title and rich body, and Source
  showed that body.
- Matter localhost:25856 renders Open vault. Clicking it changes no visible
  state; the dev log traces the native Tauri folder dialog call. Full app
  acceptance requires the native target. Do not call a browser widget fixture
  full native acceptance.

## Design checkpoint

Fresh GPT 6.1 high and Claude Opus 5.5 reviews independently support deleting
scalar rejection overlays in Todos, Vocab, and Honeycrisp. Both identify real
rich-widget state and Matter's missing accepted-but-unsaved body owner.
Claude recommends keeping Capture pending text for normal incremental Markdown;
GPT supports deleting it under the user's explicit rollback tradeoff. The
focused challenge distinguishes content loss from intentionally reverted input:
keep codec preservation checks, restore accepted content, and tell the person to
re-enter incomplete Markdown in Source. Source does not contain discarded input.

Matter's bounded change removes the mirrored CodeMirror draft string, reads the
widget document when committing, and names its deduplication value submittedBody.
Commit timing is unchanged. Typecheck passed with zero errors and warnings.
Immediate Matter saving still needs an accepted-body owner; no such claim is made.

Matter actual-widget acceptance at `/acceptance-editor` used a temporary labelled
route. Typed `Widget owns this text.` into the production MarkdownBodyEditor:
submission count stayed zero during typing; clicking Toggle editor blurred and
destroyed it, submitted the exact text once, and showed count one. The fixture
was removed. This verifies the changed widget path, not native disk persistence.

Capture integrated verification: 48 owner tests passed; the same one baseline
new-form whitespace test failed because the folder now contains definition.json.
10 mounted component tests passed, including real shared-Textarea rollback after
a tick. Both browser and host Svelte checks and script typecheck passed. The new
Source regression retains exact unfinished bytes, preserves original thoughts
after repair, and does not let an unanswered deletion accept typing.

Chrome Guest re-exercise at localhost:25855 verified rejected fenced text
restored `Immediate capture acceptance`, reason visible, header Saved. Source
accepted unfinished Markdown and reload preserved it. Its existing heading/list
bytes stayed visible inside the fence. Closing the fence in Source restored
`First acceptance thought` in Capture. Wording now says no section is readable,
rather than claiming no section exists. Browser-native drag-move splitting into
two input events remains unverified; no drag-specific preservation is promised.


## Integrated result and final review

Files read for the final review (the earlier source inventory and independent
review packets list unchanged consumers):

```text
apps/
|-- todos/
|   |-- README.md, package.json
|   `-- src/
|       |-- lib/{todo-editor,todos}.svelte.ts
|       |-- lib/{todo-editor,todos,incoming,departure}.test.ts
|       `-- routes/components/{TodoDetail,TodoStatus}.svelte
|           `-- TodoDetail.mounted.test.ts
|-- vocab/
|   |-- README.md, package.json
|   `-- src/
|       |-- lib/word.svelte.ts, word.test.ts
|       `-- routes/components/EntryCard.svelte, EntryCard.test.ts
|-- honeycrisp/
|   |-- AGENTS.md, README.md, package.json
|   `-- src/
|       |-- lib/{note-editor,notes}.svelte.ts
|       |-- lib/{note-editor,notes.folder}.test.ts
|       |-- lib/editor/rich-text.ts, rich-text.test.ts
|       `-- routes/components/{NoteDetail,RowDraftStatus}.svelte
|           `-- NoteDetail.dom.test.ts
|-- capture/
|   |-- README.md
|   `-- src/lib/
|       |-- {draft,captures}.svelte.ts, {draft,captures}.test.ts
|       `-- components/CaptureDetail.svelte, capture-detail.mounted.test.ts
`-- matter/src/lib/components/MarkdownBodyEditor.svelte
docs/adr/0507-editor-views-compose-current-input-and-own-only-interaction-state.md
```

Scalar implementation was delegated to Claude Opus 5.5 in a dedicated clone.
Native session: `5523a429-62fb-4046-b465-9ad39da444be`; launcher JSON:
`/tmp/immediate-editor-scalars-worker.json`. It finished successfully. Four tool
permission denials occurred; the worker completed with permitted alternatives.
The worker reported passing app tests and typechecks, with one Todos Git-server
failure reproduced before changes. These reports are distinct from the Codex
checks below. The existing TodoStatus inline-retry change was supplied as input
and preserved at integration. No files were staged or committed in this wave.

Codex final review kept the app admission owners: they own operation fences,
release, raw-mode admission and notices rather than merely forwarding `set`.
The deleted control-origin arguments existed for rejected-content overlays and
now have no remaining consumer. Newline conversion belongs at textarea
composition. Rich state, Markdown codec preservation checks, operation holds,
and Source repair remain real boundaries. No new public helper or state mirror
was added. One mismatch was flagged and fixed: Honeycrisp's identity no-save
admission now clears a previous notice after every gate, with regression
coverage. Equal-but-distinct complete rows still save again.

Codex reproduced in the integrated checkout:

- 330 owner/rich tests passed across the eight changed scalar test files.
- Todos mounted suite: 15 passed. Vocab component suite: 20 passed.
  Honeycrisp DOM suite: 19 passed. These include malformed-input rollback,
  repeated notices, and preserving accepted input after a failed save.
- All three app typechecks passed with zero errors and warnings, including
  Todos host and Honeycrisp desktop leaves.
- Capture: 49 owner tests and 10 mounted tests passed. Its baseline whitespace
  test was corrected to allow the folder's known definition.json initialization
  file while still rejecting any unexpected file from blank input.
- Matter: 23 focused editor tests and its typecheck passed earlier in this wave.
- A combined mounted run initially failed because the apps install incompatible
  app-local module aliases in one process. Each app's own mounted script passed.
- Scoped diff whitespace checks passed. The pre-existing staged device owner
  patch remained byte-identical. Other pre-existing dirty files were untouched.

Actual Chrome Guest integrated journeys:

- Todos rejected a malformed UTF-16 title through the real Input binding. The
  title stayed `Immediate write acceptance`, a reason appeared, the row still
  said Saved, and Source opened with the original title and body.
- Vocab rejected a malformed UTF-16 note through the real Textarea binding. The
  note stayed `Accepted Vocab note.`, Reload file remained enabled, a stage
  change to Understand succeeded and cleared the notice, and reload kept it.
- Honeycrisp rejected a malformed UTF-16 title through the real Input binding.
  The title stayed `Immediate Honeycrisp acceptance`, a reason appeared, the
  app remained Saved and committed, and Edit as file opened the exact note.
- These three rare-input journeys used labelled temporary dev buttons that
  assigned malformed text to the production control and dispatched input.
  They are browser binding acceptance, not evidence that OS paste generates
  a lone surrogate. All three fixture layout files were restored exactly.
  A production reload confirmed the temporary Honeycrisp control was gone.
- Capture and Matter journeys are recorded above. Matter native vault opening
  and Skills signed-in editor acceptance remain blocked by target/account
  availability; no provider or hardware acceptance is claimed.

Remaining product decision: existing Capture thoughts still use explicit
Save/Cancel. Its codec normalizes away a trailing newline, so a literal
per-keystroke roundtrip currently erases Enter before a second line. The Add
form remains an unsubmitted form. Immediate thought editing needs a separate
representational decision; it was not silently changed while the user question
remained unanswered.


Final production builds for Todos, Vocab, and Honeycrisp passed after fixture
removal. Capture's production browser build passed earlier. Codex then reopened
Honeycrisp's production note, typed a new paragraph `Immediate rich edit.`, and
opened Source: the exact new paragraph was present in Markdown and the save
indicator remained Saved and committed. No temporary acceptance controls remain.


## Follow-up: work backward from actual use

Files read before review:

```text
packages/capture/src/{document.ts,body-codec.test.ts,index.ts}
apps/capture/src/lib/
|-- draft.svelte.ts, draft.test.ts, captures.svelte.ts
`-- components/{ThoughtEditForm,CaptureDetail}.svelte
apps/matter/src/lib/
|-- table.svelte.ts
`-- components/{MarkdownBodyEditor,RowDetailDialog}.svelte
```

Codex reproduced the thought codec counterexample directly: `one\n` and
`one\n\n` encode/decode as `one`; an empty thought already roundtrips as an
empty bullet, and `one\nnext` roundtrips intact. This is not evidence that an
immediate multiline thought editor is supported.

Fresh bounded read-only Opus consultation is saved in next-decisions.md.
Adjudication: preserving whitespace via new Markdown conventions or keeping a
local normalized projection is additional complexity. Do not introduce either
silently to remove Save/Cancel. Keep the explicit thought form until that product
choice is resolved. Matter's widget is seeded once and keyed by filename, so
save echoes do not reset its live document. The stronger remaining ownership
gap is retaining accepted contents when publication fails and the widget closes.
Per-keystroke persistence alone does not solve that gap. No Matter rewrite was
made in this follow-up.

Current computer-use run: the previous Capture origin localhost:25855 refused
opening with a missing folder ready marker. Its data was left unchanged. A fresh
disposable origin localhost:25859 opened successfully. Created capture
`20261008-044124-6y6t4`, text `Doctrine thought acceptance`, thought `one`.
Opened Edit, typed Enter then `next`, saved and opened Source: the Markdown body
contained `- one` followed by `  next` exactly.

Actual use revealed that simply opening Edit marked the capture Not saved yet,
without changing text. The fix derives hasUnsentInput from the current thought
and form value rather than the existence of an open form. It adds no dirty flag
or mirror. If Source changes the corresponding thought, the old form still
counts as unsent so it is protected. Existing stale-form guards remain intact.

After integration in Chrome: opening Edit stayed Saved; appending ` revised`
changed it to Not saved yet; replacing the value with the current `one\nnext`
returned it to Saved. No extra Save click was needed to clear the false status.
Owner suites: 50 passed. App mounted suites: 13 passed; an existing teardown
path emits Svelte derived_inert, so no warning-free mounted claim is made.
Capture typechecks passed. No fixture source or new public abstraction was added.

Next deciding work, in order: choose the multiline thought representation before
removing its form; provide Matter one retained accepted-content owner and verify
failure/close/reopen on the native target; finish Skills signed-in acceptance.
Todos, Vocab and Honeycrisp need regression journeys rather than speculative
new rewrites. Native/provider/hardware acceptance remains separate.


## Commit waves

- `a6e8af9078`: scalar rejected-input rollback in Todos, Vocab, Honeycrisp.
- `c9f40085d8`: Capture accepted-content bindings and derived unsent status.
- `a6fb5b741a`: Matter widget body mirror removal.
- `be0f093763`: editor ownership doctrine.

Commits used explicit task paths and preserved the pre-existing staged device
owner patch byte-for-byte. The earlier no-commit statements describe the source
state before these waves.


## Final state of these waves

Matter's immediate ownership wave is committed as `2fb429d323`. See
[matter-wave.md](matter-wave.md) for independent-review adjudication, integrated
checks and the actual native permission-failure/reopen/retry journey. The final
browser keyboard test passed after an exact Close locator correction.

Completed: scalar rollback in Todos/Vocab/Honeycrisp, Capture direct accepted
content and derived unsent status, Matter immediate accepted body ownership,
and the ownership decision record. The evidence establishes that an immediate
setter needs an owner that retains accepted input independently of publication;
removing that owner would reintroduce the native failure demonstrated here.

Remaining product/external decisions:

- Capture multiline thoughts keep Save/Cancel pending the choice between its
  current Markdown representation and an explicit temporary whitespace buffer.
- Skills' actual editor requires a signed-in account. No auth bypass was added.
- Matter retains input while the table lives, without app-restart durability or
  a native conditional-write guarantee.

The device owner index patch remained byte-identical. Concurrent unrelated
commits and dirty work were preserved. No further cleanup waves are warranted
without new evidence or the pending product decision.
