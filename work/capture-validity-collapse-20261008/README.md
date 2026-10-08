# Capture has one row-validity API

Starting HEAD: 42756c77b7. The user's continued straggler hunt found a redundant
getter in Capture's draft, not another retained-content buffer.

## Files read

```text
apps/capture/
|-- README.md
|-- package.json
`-- src/lib/
    |-- draft.svelte.ts
    |-- draft.test.ts
    |-- captures.test.ts
    |-- captures.svelte.ts (caller search)
    |-- platform/folder.epicenter-host.test.ts
    `-- components/
        |-- CaptureDetail.svelte
        |-- capture-detail.mounted.test.ts (caller search)
        |-- TechnicalDetails.svelte
        `-- DraftRecovery.svelte
apps/honeycrisp/src/routes/components/
`-- RichEditor.svelte (state/caller search)
apps/todos/src/lib/
|-- todo-editor.svelte.ts (API/caller search)
`-- todos.svelte.ts (caller search)
```

## Finding and resolution

Draft.structured meant only editor.row.status === valid. Draft.status already
exposes that discriminant. The boolean also suggests the body codec has admitted
Capture controls, while the UI independently checks draft.document.refusal for
that. Removed structured, updated the UI to check status directly, and removed
two duplicate assertions already checking the same row status. Other assertions
now check status directly. The recovery report's separate document.structured
field is a different contract and remains unchanged.

The change was announced before editing. No admission, save, pending input,
thought-session, tab-selection or file behavior changed. The row editor owns
validity; the body codec owns whether its body can be interpreted as Capture.

## Verification

- Draft/list tests before and after: 47 pass, 1 fail. The whitespace new-capture
  form test fails in both; no baseline failure was repaired in this slice.
- Mounted panels before and after: 12 pass, 0 fail, including invalid Source
  repair, body codec refusal, current-owner and retired-control behavior.
- Browser and Epicenter-host Svelte checks: no errors or warnings; scripts
  TypeScript passed.
- The changed host assertion's focused test passed.
- Production browser build passed.

Logs: /tmp/capture-validity-{baseline,after,mounted-baseline,mounted-after,types,
host-test,build}.log. This behavior-preserving getter collapse did not require
new browser fixtures or new mirrored tests.

## Worktree protection

The host test already had an unrelated dirty thought assertion. Its task-start
diff was captured and compared unchanged after removing this pass's single
validity assertion edit. Only the new assertion is staged through a scoped
index patch. Other touched code files were clean at task start. The commit uses
a temporary index containing only this pass, preserving existing device staging.

## Final review

Re-read the changed API and all changed callers. The removed getter has no
remaining consumer; status handles valid, invalid and not-yet-open, and the UI
uses the same valid predicate as before. The native row and decoded body remain
separate facts. No replacement wrapper or boolean was introduced. Retained
input and actual operations still earn their state. No further cleanup in
these inspected paths meets the evidence bar without changing an app policy.
