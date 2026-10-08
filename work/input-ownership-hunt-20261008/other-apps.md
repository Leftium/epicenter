# Other apps and shared inputs: ownership hunt

Read-only source review on 2026-10-08. No application files changed. No browser, native, provider or financial writes were performed. Findings below are source-grounded, not runtime reproductions.

## Files read

Whole files or the relevant ownership/caller sections were read. The tree precedes analysis; broad search hits alone are not counted as inspected implementations.

```text
.agents/skills/
|-- collapse-pass/SKILL.md
`-- svelte/references/input-ownership.md
apps/
|-- README.md
|-- skills/
|   |-- README.md
|   `-- src/lib/
|       |-- mutation.ts
|       `-- components/
|           |-- dialogs/NewSkillDialog.svelte
|           `-- editor/
|               |-- CodeMirrorEditor.svelte
|               |-- InstructionsEditor.svelte
|               `-- SkillMetadataForm.svelte
|-- matter/
|   |-- README.md
|   |-- node_modules/@tauri-apps/plugin-store/dist-js/index.js
|   `-- src/lib/
|       |-- open-vaults.svelte.ts
|       |-- table.svelte.ts
|       `-- components/
|           |-- MarkdownBodyEditor.svelte
|           |-- RowDetailDialog.svelte
|           `-- fields/
|               |-- create-cell-edit.svelte.ts
|               |-- field-props.ts
|               |-- TextCell.svelte
|               |-- StringField.svelte
|               |-- NumericField.svelte
|               |-- JsonEditor.svelte
|               `-- TagsField.svelte
|-- local-mail/
|   |-- README.md
|   `-- ui/src/lib/components/SavedQueries.svelte
|-- local-books/
|   |-- AGENTS.md
|   |-- README.md (UI and write-contract sections)
|   `-- ui/src/
|       |-- routes/+page.svelte (RowDetail mount)
|       `-- lib/
|           |-- api.ts (input exports)
|           `-- components/
|               |-- RowDetail.svelte
|               `-- ReportPanel.svelte
|-- landing/src/components/WaitlistForm.svelte
`-- epicenter/
    |-- AGENTS.md
    `-- src/ui/Composer.svelte (excluded from conclusions; coordinator owns it)
packages/ui/
|-- README.md (contract and input sections)
`-- src/
    |-- input/input.svelte
    |-- textarea/textarea.svelte
    `-- natural-language-date-input/
        |-- natural-language-calendar-date-input.svelte
        `-- natural-language-zoned-datetime-input.svelte
```

Search scope included remaining Svelte apps and shared UI, excluding Capture, Todos, Honeycrisp, Whispering and Vocab. Home Composer and Git were handed back to the coordinator. Queries searched rune declarations/effects, submission handlers, clones/snapshots, raw mutation and setters. Follow-up searches traced actual mounts and write APIs. Search matches are not a complete inventory or proof of a bug.

## 1. Local Books: capture submission identity and preserve newer typing

Grounded correctness issue and useful draft collapse. `ui/src/lib/components/RowDetail.svelte:45-67` stores the two submitted fields separately, defines a zero-argument mutation that reads current component props/fields, then clears both fields on any success and invalidates the currently selected row. The inputs at lines 134-143 stay editable while pending; only the submit button is disabled at line 148. The parent at `ui/src/routes/+page.svelte:132` reuses RowDetail without a key as selection changes.

A request for A can finish after the person types a new target or selects B. The success handler erases that newer input and invalidates B's detail instead of the submitted A. The mutable-prop read also makes the mutation input implicit rather than fixed by the submit event. No runtime reproduction was attempted.

Current shape:

```ts
let targetAccountId = $state('');
let targetAccountName = $state('');
mutationFn: () => api.recategorize({ entity, id, account_id: targetAccountId, ... });
onSuccess: () => {
  targetAccountId = '';
  targetAccountName = '';
  invalidate(['row', entity, id]);
};
```

Proposed shape, with normalization retained:

```ts
let draft = $state.raw({ account_id: '', account_name: '' });
// Each binding replaces draft with { ...draft, editedKey }.
mutationFn: (submitted: { input: RecategorizeInput; draft: typeof draft }) =>
  api.recategorize(submitted.input);
onSuccess: (result, submitted) => {
  if (draft === submitted.draft) draft = emptyDraft();
  invalidate(['row', submitted.input.entity, submitted.input.id]);
};
// Submit narrows entity/id, captures draft before calling mutate,
// trims account_id and maps blank account_name to undefined.
```

The envelope carries the unfinished draft identity plus the normalized immutable API request, not another reactive payload owner. A per-selection key is a separate decision: key RowDetail by entity/id if drafts should belong to a selected row lifetime. That deliberately discards unfinished input on selection; preserving per-row drafts would need an owner above disposable detail. Do not add a key silently as a correctness fix. At minimum compare submitted/current row identity before clearing and invalidate the submitted row.

Deletion prize: two parallel field owners and request dependence on mutable props. Preserve trimming, optional-name semantics, failure toasts and QuickBooks' one explicit write. Verify with a stubbed API: hold A's response, edit the draft, switch to B, resolve A, and assert the newer draft survives and A is invalidated. Exercise failure and a normal success. No live QuickBooks write is necessary.

## 2. Local Mail: consolidate the genuine Save draft, keep its baseline

`ui/src/lib/components/SavedQueries.svelte:23-59` owns name and SQL alongside a baseline, persistence receipt, selected ID and execution state. These are not all duplicate current content. Save stores a draft; Run separately captures SQL/account and has cancellation and request-identity checks (`:178-203`). Save disables its inputs and navigation while pending (`:229-245`, `:314-327`), so the obvious late-reset issue is already handled.

Small doctrine alignment:

```ts
// Before
let name = $state('');
let sql = $state('');
queries.update(selected, { name, sql });

// After
let draft = $state.raw({ name: '', sql: '' });
queries.update(selected, draft);
// bind:value get draft.name; set draft = { ...draft, name }.
```

Preserve `baseline` and its fingerprint: it records the opened stored version for conflict/discard decisions. It is not a redundant draft. Preserve unsavedWrite, flush/retry, cancellation, destination/discard and separate Run result SQL/account. Do not merge all state into one object. Read current form lifetime and account-departure policy before changing reset behavior. Verification: Save failure/retry, external stored change while typing, Save as new, malformed row repair, and account-switch cancellation. This is a low-risk representation cleanup, not a claim that the form is overengineered.

## 3. Local Books: group report parameters without deleting normalization

`ui/src/lib/components/ReportPanel.svelte:19-34` stores report/startDate/endDate/method separately then builds one ReportInput. These fields form one explicit submission. A raw object using API-shaped names can replace the parallel scalar owners. Empty date and basis controls still need mapping to undefined and date whitespace must still be normalized.

```ts
let draft = $state.raw({
  report: 'ProfitAndLoss' as ReportInput['report'],
  start_date: '', end_date: '', accounting_method: '' as '' | 'Cash' | 'Accrual',
});
run.mutate({
  ...draft,
  start_date: draft.start_date.trim() || undefined,
  end_date: draft.end_date.trim() || undefined,
  accounting_method: draft.accounting_method || undefined,
});
```

Deletion prize: parallel field names and manual unrelated-key reconstruction, not all mapping. No snapshot is needed for this plain replace-only object. No reset occurs after success, so no late-clear issue was found here. Verify blank/default and populated parameters using an API stub, not a live provider.

## 4. Matter: a copy boundary now has concrete evidence

`src/lib/open-vaults.svelte.ts:69-98` owns a raw list, replaces it on hydrate/add/remove, and snapshots before persistence. All current app callers of `openVaults.list/get` only read entries. Installed `@tauri-apps/plugin-store/dist-js/index.js:66` awaits its store and forwards the same value; `:162` hands it to invoke without modifying it.

For the current replace-only list of plain string records, snapshot has no proxy to remove and detaches from an array that this implementation never mutates. The bounded candidate is:

```ts
// Before
store.set(STORE_KEY, $state.snapshot(vaults));
// After
store.set(STORE_KEY, vaults);
```

Deletion prize: unnecessary copy plus the claim that detachment is required by this replace-only owner. The list/get return types remain mutable; do not generalize this result to an API that permits consumers to mutate retained arrays. Verify rapid open/close updates across delayed LazyStore initialization, persisted JSON equality and no in-place mutations. This is sidebar persistence, not a content-editor migration.

## 5. Matter fields: distinguish explicit cell submission from publication failure

`create-cell-edit.svelte.ts:56-110` is an intentional cell draft: click starts, Enter/blur submits, Escape cancels, and malformed JSON remains unfinished with an error. It fits explicit submission. `TextCell.svelte:43-47` forwarding closures read changing props at event time; replacing them with initial function values would change current behavior. Do not erase the helper simply because it returns a draft getter/setter.

A separate ownership gap deserves a bounded review before any conversion: `field-props.ts:35` declares SaveField as returning void, but TableGrid/RowDetailDialog wire it to asynchronous `table.saveField`. `table.svelte.ts:240-253` stores only a failure message and applies the new value only after a successful disk write. The cell helper closes immediately on submit; TagsField additionally clears draft immediately after `save` (`TagsField.svelte:40-44`). On failure the submitted replacement is no longer available through the closed control or a retained accepted-field owner. This differs from Matter's body owner, which retains failed accepted text.

Do not fix this by deleting the cell draft or by pretending the projection accepted failed content. Choose a boundary: either explicit submission awaits a Result and keeps the open draft on failure, or the table immediately accepts and owns pending field replacements with retry. The latter is a larger publication-owner change and must protect fresh-byte field composition and unrelated external edits. The former is the smaller explicit-form interpretation:

```ts
const submitted = draft;
const result = await save(parse(submitted));
if (result.error) { showFailure(); return; }
if (draft === submitted) close();
```

This is schematic: shared `commit` must prevent blur/Enter duplicate requests and preserve invalid-JSON/cancel semantics. Verify failed string/numeric/tag edits, retry, external unrelated-field writes and switching rows. No test or UI reproduction was performed; current source demonstrates the absence of a retained replacement, but product policy decides whether field-save refusal should retain it.

## Keep

- Skills NewSkillDialog is one scalar explicit form. `runSkillsMutation` is synchronous and catches storage exceptions; there is no asynchronous success that can erase newer typing. An object solely wrapping name adds no value.
- Skills CodeMirror binds to the owning collaborative Y.Node and retains widget state/history. The document-observer feedback flag prevents publishing external changes back; it is not another application draft. InstructionsEditor keys by skill identity. Skills startup is currently refused by product/auth policy, so source review is not app acceptance.
- Skills metadata onblur is explicit acceptance with native input holding unfinished text. It does not require an extra object draft solely to match doctrine.
- Matter acceptedBodies is the accepted body/publication owner, not a redundant component mirror. MarkdownBodyEditor has a bindable body, required widget state and independent Vim reconfiguration; accepted external text replaces its document without republishing. Keep history and its actual lifecycle.
- Shared Input/Textarea shown/live retirement protects detached native bindings. That cache is an intentional terminal read boundary, not editable current-content duplication.
- Natural-language date controls own unfinished phrases and, for zoned dates, a seed-only chosen zone. Choice submits a parsed suggestion; getter/setter over a persisted date cannot represent an unfinished phrase. Grouping phrase/zone would be optional organization, not removal of a duplicate owner.
- Landing WaitlistForm is currently a Discord link with no form state despite its filename. No ownership migration is present there.

No production raw-object property mutation was established in the inspected owners. Do not treat the many raw collections, query results and interaction flags as deviations from the two input patterns.
