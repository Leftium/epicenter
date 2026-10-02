# Honeycrisp browser workflow baseline

Date 2026-10-02. Chrome actual computer use through documented cua APIs, URL http://localhost:5175/. Tab ID 672030392. No browser evaluation or hidden state, source edits, storage reset, or changes to preexisting user files. Workspace initially showed zero notes/no files. Created three disposable sim-prefixed note files. One New note action initially generated notes/d351776ff6.md; immediately renamed through file Actions → Rename… → Enter to notes/sim-20261002-honey-valid.md.

## Malformed note and repeated diagnostics

1. Toggle Terminal and Files in header.
2. Create normal note with New note; rename generated file via Files actions, then terminal cat to inspect current schema. Normal source uses folderId, title, pinned, createdAt, updatedAt, deletedAt and YAML fences.
3. Embedded terminal: `printf '%s\n' 'Missing frontmatter fences in Honeycrisp.' > notes/sim-20261002-honey-malformed.md`.
4. Note appears under Needs repair as “Untitled”, with the parse diagnostic preview. Select it.

Actual: file remains visible/selectable. Detail Title, Folder, and Pin disabled. Saved path is visible. Rich text is initially selected. Same parse error appears three times in detail:

- Repair notice: “Needs repair The source does not start with a --- line opening its frontmatter. The text is saved as written. Fix it in Source.”
- Parent diagnostic list: “The source does not start with a --- line opening its frontmatter”.
- Rich fallback diagnostic bullet: “The source does not start with a --- line opening its frontmatter”.

Rich fallback copy:
“This note opens in Source only”
“The rich-text editor would change or drop part of it on save, so it is not opened here. Nothing in the file was changed.”
Button: “Continue in Source”.

That fallback explanation is inaccurate for this cause: missing frontmatter fences are a document parse failure, rather than evidence that rich editing would drop Markdown. The direct Continue in Source action does work: it selects Source and exposes original exact text. Source remains editable. Malformed note left unchanged as a persistent fixture for repair rerun. Screenshot emitted showing all three diagnostic renderings and direct action.

## Valid Source and Rich text views; undo survives switch

1. Select healthy sim-honey-valid note; Title to sim-20261002-honey-valid.
2. Switch Source. Set fenced source using valid metadata and body:

```md
# A heading

A **bold** line with café 🥔.
```

3. Switch Rich text.

Actual: heading and bold formatting render; Unicode and text preserved. Rich Undo disabled initially because the content was seeded in Source.

4. Click Note text editor, move to end with super+End, type “ Rich addition.”.
5. Switch Source.

Actual: exact semantic Markdown content preserved: heading, bold markers, Unicode, and addition. updatedAt changes to current time as normal note save behavior. Rich edit autosaves/commits; no loss or representation fallback.

6. Switch Rich text again.

Actual: Undo still enabled after round trip. Click toolbar Undo.

Actual: “ Rich addition.” removed, prior source-seeded heading/bold/Unicode retained, Undo disabled and Redo enabled. This demonstrates actual usable rich undo history survives the view switch. Source-seeded undo across editor kinds was not asserted or tested.

## Valid document with unsupported rich Markdown

1. Embedded terminal create notes/sim-20261002-honey-unsupported.md with valid frontmatter:
folderId:null; title:sim-20261002-honey-unsupported; pinned:false; valid createdAt/updatedAt ISO strings; deletedAt:null.
Body: `<div>Raw HTML must remain exact.</div>`.
2. Select the note.

Actual: appears in normal Today section, with usable title/folder/pin and no parent Needs repair notice. Rich fallback shows same “This note opens in Source only” and preservation copy, distinct diagnostic “It contains HTML.”, and Continue in Source action. This is an appropriate rich-representation limitation for a valid document.

3. Continue in Source, then embedded terminal `cat notes/sim-20261002-honey-unsupported.md`.

Actual: raw HTML and metadata unchanged; no rewriting or dropped source. Source usable/editable. Switch Rich text again: distinct HTML fallback remains. Screenshot emitted showing fallback and terminal original text.

## Fix implications

1. Collapse document parse diagnostic duplicates. Malformed note has parent summary, parent list, and rich fallback list repeating the same error.
2. Distinguish malformed document recovery from valid-document rich incompatibility. Malformed source needs a parse-specific repair path, while valid raw HTML correctly needs a rich representation warning. Keep Continue in Source or equivalent direct action.
3. Preserve rich editor history during any repair refactor: observed Source→Rich→Source→Rich with real rich Undo currently works.
4. Malformed notes display Untitled despite literal stem. Files/detail path still identifies them; multiple malformed notes could be difficult to distinguish in the note list. This baseline tested only one malformed item, so does not establish a multi-item selection bug.

## Retained state and limits

Tab marked handoff for focused repair rerun. Selected sim-20261002-honey-unsupported in Rich fallback. Malformed fixture remains unchanged; valid fixture contains heading/bold/Unicode with rich addition undone; unsupported fixture retains exact raw HTML. Initial zero-note browser workspace preserved apart from these disposable additions.

No native round trip, deletion, malformed raw save/repair, save conflict, Source keyboard undo, additional Markdown incompatibilities, folders, or Recently Deleted workflows tested in this focused pass. Separate Todos baseline covers malformed raw saving, partial fields, conflicts, and native Git boundary. Screenshots emitted through documented screenshot API; no disk-save capability exposed.
