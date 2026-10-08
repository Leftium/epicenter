# Coordinator source review

Read-only source hunt, 2026-10-08. No application changes or runtime acceptance
are claimed in this report.

## Files read before analysis

```text
.agents/skills/
|-- collapse-pass/SKILL.md
|-- collapse-pass/references/refactoring-methods.md
|-- consult-claude/SKILL.md
`-- svelte/references/input-ownership.md
apps/
|-- README.md
|-- epicenter/
|   |-- README.md
|   `-- src/ui/{App,Chat,Composer}.svelte
|       session.svelte.ts
|-- git/
|   |-- README.md
|   `-- src/
|       |-- lib/workspace.svelte.ts
|       `-- routes/+page.svelte
|-- vocab/src/routes/components/WordsView.svelte
|-- honeycrisp/src/routes/components/FolderNav.svelte
|-- honeycrisp/src/routes/components/FileBrowser.svelte (commit section)
|-- whispering/src/routes/components/FileBrowser.svelte
|-- whispering/src/lib/settings-draft.svelte.ts
|-- todos/src/routes/components/FileBrowser.svelte
|-- local-books/ui/src/lib/components/RowDetail.svelte
`-- matter/
    |-- src/lib/table.svelte.ts
    |-- src/lib/open-vaults.svelte.ts
    |-- src/lib/components/fields/{create-cell-edit.svelte.ts,TagsField.svelte,field-props.ts}
    `-- node_modules/@tauri-apps/plugin-store/dist-js/index.js
packages/ui/src/textarea/textarea.svelte
```

## Reviewed reports

The coordinator inspected the deciding source for these reported candidates:

- Vocab WordsView: confirmImport awaits additions then clears the current review
  or replaces the current selection, while review controls remain available.
  Starting a chat similarly clears the current focus selection after awaiting.
  A replacement-based review draft lets each completion identify its submission.
- Honeycrisp FolderNav: naming is cleared before the operation completes, so a
  failure has no unfinished name to retry. A missing rename target chooses the
  create branch. Keep create/rename intent explicit and retain failure input.
- Todos, Honeycrisp and Whispering FileBrowser: successful naming clears current editing
  unconditionally. Capturing edit-instance identity protects a newly opened form,
  but does not protect newer text typed into the same DOM-held form. A complete
  proposal needs a replacement-based draft or a deliberate pending-input lock.
- Local Books RowDetail: mutationFn reads live record props and field state;
  success clears live fields and invalidates the live selected record. Submit
  explicit variables containing target identity and normalized form input;
  invalidate the submitted target and clear only its unchanged draft. A keyed
  record form can establish the intended lifetime. This was inspected without
  making any external financial writes.

These are static event-path findings. Focused deferred-response component tests
and actual UI exercises remain necessary before accepting implementations.

Matter's field helper closes before invoking a void save callback; its async
saveField retains only a failure message. Tags also clears its submitted text.
This is a source-confirmed information gap, but retaining refused field edits is
a product promise to choose before changing that API. Matter's vault snapshot
copy has supporting installed receiver evidence; removing it is lower priority
than submission lifetime fixes and assumes current consumers remain read-only.
Honeycrisp's Files textarea uses value/oninput forwarding with a mounted check;
the shared bind:value lifetime can replace that path while retaining its real
file-session owner and newline conversion.

## Additional keep decisions

Home Composer owns one unfinished message string and clears it only after the
synchronous onSend callback reports transport admission. Chat is force-mounted
by App, so changing panes retains that draft. Session owns server snapshots;
there is no second accumulated transcript to collapse. Synchronous transport
admission is distinct from acknowledged server delivery; this hunt does not
claim the stronger guarantee or change that contract.

Git lab's workspace owns accepted raw text and publication. Its buffer, captured
file and in-flight save are not another component mirroring an editor. Its
terminal command is one explicit submission string. The submitted command is
recorded in output before awaiting execution, so clearing the input is an
observable handoff to command history. Keep these owners. Separate working-copy
and remote variables could become one opening draft, but that alone removes no
meaningful concept and is not a recommended cleanup.

## Additional search recipes

Run from the repository root, then inspect actual owners and call sites. Matches
are not defects and do not establish timing without following the event path.

```sh
# A mutation that may read live fields/props instead of captured variables.
rg -n -g '*.svelte' -g '*.svelte.ts' 'mutationFn:|onSuccess:|mutate\(|invalidateQueries' apps

# Destructive completion or pre-submission resets, beyond variables named draft.
rg -n -g '*.svelte' -g '*.svelte.ts' '= undefined|= null|= \[\]|await.*(create|rename|patch|add|onStart)' apps

# DOM-held submission drafts that a $state-only hunt misses.
rg -n -g '*.svelte' 'namedItem\(|currentTarget.value|onblur=|onsubmit=' apps

# Target lifetimes and mode decisions to trace with those handlers.
rg -n -g '*.svelte' '\{#key|RowDetail|editing =|naming =|showSource|rawMode' apps
```

The broad initial rune/effect/copy query returned 153 lines across apps and UI
source. This is a search-output size, not a deviation count. Resource handles,
fixtures and real operation state appear in it. The terminal output snapshot
was saved to `/tmp/input-ownership-hunt-20261008.txt` for this session; durable
findings are in this directory.
