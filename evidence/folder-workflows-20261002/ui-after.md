# Browser verification after seven repairs

Date 2026-10-02. Actual Chrome CUA, documented AX/click/type/setValue/pressKey/scroll interfaces only; no hidden browser state or production source edits. Existing disposable sim-20261002 fixtures used. No storage resets, force pushes, merge, or preexisting user-file edits.

## Todos: malformed selection from Notes

Origin http://127.0.0.1:5186/, reopened Chrome tab 672030396, original divergent browser storage preserved.

1. Select healthy sim-normal, leaving Notes active; open Terminal.
2. Terminal replace existing disposable todos/sim-20261002-malformed.md with “Missing fences post repair.”.
3. Select malformed Todo row.

Actual: file still selectable; Title/Done/Notes disabled. Detail now has one parse sentence:
“Needs repair The source does not start with a --- line opening its frontmatter. Edit the source to fix it.”

No repeated parent diagnostic list and no claim that text is saved as written. Button “Edit Source” appears while Notes active. Click it: Source selected and original exact text visible/editable; button disappears while already in Source. Pass.

## Todos: distinct YAML diagnostic retained

1. Embedded terminal replace disposable sim-bad-field with fenced YAML `title: [` and `done: false`, plus body.
2. Select its row.

Actual summary: “Needs repair The frontmatter is not valid YAML. Edit the source to fix it.”
Distinct diagnostic retained: “Line 3: Flow sequence in block collection must be sufficiently indented and end with a ]”.
Source contains the original invalid YAML/body. Deduplication removes only redundant diagnosis; useful detail remains. Pass.

## Honeycrisp: document parse failure owned by parent

Origin http://localhost:5175/, Chrome tab 672030392.

1. Select original malformed notes/sim-20261002-honey-malformed.md with Rich text selected by default.

Actual parent notice:
“Needs repair The source does not start with a --- line opening its frontmatter. Fix it in Source.”
Button “Edit Source”.

No duplicated parent diagnostic, no child rich fallback list, and no “rich-text editor would change or drop” explanation for this malformed document. One detail diagnosis only. Note list preview also contains the error as its identification preview, separately from detail.

2. Click Edit Source.

Actual: Source selected, exact “Missing frontmatter fences in Honeycrisp.” visible. Pass.

## Honeycrisp: external malformed-to-valid repair keeps terminal focus

1. Switch malformed note back to Rich text.
2. Open Terminal; focus Terminal command.
3. Embedded terminal printf writes valid fenced note metadata and body “External repair while terminal focused.” to same sim-malformed file.

Actual: parent repair notice clears; Title/Folder/Pin enabled; rich Formatting toolbar and body appear. Accessibility reports focused UI element remains Terminal command.

4. Without supplying an element index, type `cat notes/sim-20261002-honey-malformed.md`, then Return.

Actual: command runs in terminal and displays valid source. Rich body is not edited. This demonstrates actual keyboard focus retention during external repair. Internal mount identity cannot be established through UI; tested behavior shows no focus theft. Pass.

## Honeycrisp: rich incompatibility remains distinct

1. Select notes/sim-20261002-honey-unsupported.md containing valid frontmatter and raw `<div>Raw HTML must remain exact.</div>`.

Actual: no parent Needs repair, usable title/folder/pin. Rich fallback remains:
“This note opens in Source only”
“The rich-text editor would change or drop part of it on save, so it is not opened here. Nothing in the file was changed.”
Distinct diagnostic: “It contains HTML.”
Button: Continue in Source.

2. Continue in Source.

Actual: original full metadata/raw HTML unchanged and editable. Pass.

## Honeycrisp: rich history across Source switch preserved

1. Select valid sim-honey-valid note with heading, bold line, café and potato emoji from baseline.
2. Rich editor append “ After repair undo.”.
3. Switch Source.

Actual source preserves heading Markdown, bold markers, Unicode, and addition.

4. Switch Rich text again. Undo remains enabled. Click Undo.

Actual addition removed; prior heading/bold/Unicode retained; Undo disabled and Redo enabled. Pass. This tests rich editor history across view switching, not one shared undo stack for Source edits.

## Unobserved remote divergence: real browser push refusal

Origin http://localhost:5186/, reopened Chrome tab 672030395. Browser starts Up to date at previously verified aa708aa. Coordinator handshake: browser sends READY before mutations; native ordinary filesystem writer edits only normal body and commits/pushes 0d26a3d after aa708aa. No browser Fetch or Pull occurs after native push.

1. Browser select sim-normal and edit Title only to sim-20261002-browser concurrent title.
2. Wait for autosave using terminal cat observation.

Actual local source:

```md
---
title: sim-20261002-browser concurrent title
done: true
agentOnly: preserved by native writer
---
Native filesystem edit: café 🥔.
```

3. Click Commit and push.

Actual status: “Push failed · 1 not pushed”.
Toast: “Nothing new to commit · Push failed”.
Error: “The remote branch 'main' cannot be updated by a fast-forward Local commits are kept.”

No force:true suggestion. The browser retains its local commit and source.

4. Read-only terminal git status/log.

Actual:
`## main...origin/main [ahead 1]`
`nothing to commit, working tree clean`
`5c8ef7d Update todos/sim-20261002-normal.md`
`aa708aa Update todos/sim-20261002-normal.md`

Cached tracking ref still aa708aa because browser has not fetched native 0d26a3d. This is expected: unobserved remote divergence tested push failure rather than pre-known local/remote divergence detection.

Coordinator read-only native verification: head still 0d26a3d; title sim-20261002-browser return trip unchanged; done:true and unknown agentOnly retained; body “Native concurrent edit: café 🥔, retained remotely.” retained. Both writers' histories/source survive independently. No further mutations on localhost Todos origin after the case. Pass.

## Limits and retained state

Vite HMR reset selection/terminal during the first Todos setup; an attempted stale-index input failed before sending any input, then fresh AX controls were used. Another HMR reset Honeycrisp selection after completed rich Undo autosaved. Storage/fixtures persisted. This is development reload behavior, distinct from external file-repair focus behavior, which passed with no reload during the observation.

No production code changed by this agent. Todos original origin retains malformed/YAML fixtures and earlier divergence; localhost origin retains local concurrent title commit 5c8ef7d. Honeycrisp malformed fixture now repaired; unsupported raw HTML exact; valid heading/bold/Unicode retained after Undo. No cleanup/deletion or history rewriting.

All requested focused user-visible checks pass. Whispering UI not tested in this pass; implementation correctness beyond these representative workflows belongs to the independent reviews and regression tests.
