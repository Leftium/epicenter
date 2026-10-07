The Todo editor collapse is finished in the dedicated clone and every check in scope passes. The diff is uncommitted and unstaged at `/private/tmp/editor-hunt-todos-20261007`, based on e155539b3c: 10 files, +675/−414.

## What changed

**`apps/todos/src/lib/todo-editor.svelte.ts`**
- **Public reads:** `row`, `save` and a read-only `refused` map (each held entry has `{ value, message }`). The `refusals` message list stays because `TodoStatus` uses it. The `editor` facade is gone.
- **Deleted, with no aliases:** `title()`, `done()`, `notes()`, `text()`, `setTitle`, `setDone`, `setNotes`.
- **New `set(next: CanonicalDocument, { control?: 'title' | 'notes' } = {}): string | undefined`.** Checks run in this order, all before anything reaches the native editor:
  1. A release, departure or fence refuses it.
  2. A row that isn't valid, or is in raw mode, is refused with "open in its source editor".
  3. A held field that the row changes compared with the accepted row is refused, unless the row came from that field's own control.
- **After the checks:**
  - With `control: 'notes'`, the owner restores the file's newline convention before the native `set`. If the value is refused, it stores the LF text that was typed.
  - With `control: 'title'`, a refused value stores the title exactly as supplied.
  - An accepted value clears only its own control's refusal.
  - A schema-invalid but representable row is still submitted and moves the view to Source.
  - An unchanged row is saved again, as before.
- **Unchanged:** `setText` keeps its guard, its newline conversion and the raw preference. `toggle(done)` builds the complete row, calls `set`, waits and reports the save. reload, retry, settle, fence, departure and release work as before. The internal `refused()` function is now `blocked()`, so it doesn't clash with the new `refused` getter.

**Production callers**
- **`TodoDetail.svelte`:** local getters read `todo.row` plus `todo.refused`, with LF normalization (the `lf` helper moved here). Setters read the current `todo` when the event fires, narrow to a valid row, build the complete row and call `todo.set`, passing the control for title and notes. Source binds to `lf(todo.row.text)` and `todo.setText`. Lifetime and the shared Input/Textarea retirement are unchanged.
- **`TodoStatus.svelte`:** `todo.editor.save` → `todo.save`. This file is the one that needs merging with your live edits.
- **`todos.svelte.ts`:** `item.editor.editor.save` → `item.editor.save`.
- **`README.md`:** the binding guidance now describes `row`/`save`/`refused` and `set(next, { control })`.

**Tests**
- Each test file has its own small helpers (`fieldsOf`, `typeTitle`, `typeNotes`, `check`) that build complete rows. There are no casts and no production exports added for tests.
- `written` now uses `settle()` followed by a read of `save`.
- Input refused during a fence, departure or release now asserts the returned reason instead of being ignored.
- New coverage:
  - A full row that changes a held title is refused, whether it has no control or the notes control. Holding both fields also blocks a title-control row that changes the notes.
  - The list toggle keeps both held values visible.
  - Correcting the title clears only the title.
  - A refused value from the notes control is stored as LF on a CRLF file.
  - A row that isn't valid refuses a full row.
  - A mounted test checks that notes and source show LF and that typing keeps the body's CRLF and unknown keys.

## Checks

| Check | Result |
|---|---|
| `bun test --isolate --path-ignore-patterns='src/**/*.mounted.test.ts' src` | 169 pass, 0 fail (baseline 168; one new) |
| Mounted suite (`bun test --isolate --conditions=browser --conditions=svelte mounted.test`) | 14 pass, 0 fail (baseline 13; one new) |
| `bun run typecheck` (browser and host svelte-check, then `tsc -p tsconfig.scripts.json`) | 0 errors, exit 0 |
| `bun run build` | built, exit 0 |
| Host build | built to `../epicenter/dist/todos`, exit 0 |

- **Baseline failure, not caused by this change:** `server/git-server.test.ts` expects "Add todos/milk.md" and receives "Update 2 files". It fails identically before and after the change.
- **Commands run directly:** `bun run test:mounted` and `build:epicenter` run `bun` from a nested bash that can't find it in this sandbox (exit 127). I ran their underlying commands directly, with the same flags and environment.

## Risks and things to review

- **Extra file:** `departure.test.ts` wasn't on the allowed list, but it called the removed methods. I migrated it the same way.
- **Two similar names:** `refused` (the map) and `refusals` (the message list for status) now sit side by side. `TodoStatus` could build its messages from `refused` later; I kept `refusals` to avoid more conflict in that file.
- **Existing newline behaviour the new mounted test makes visible:** after a fields edit the frontmatter is written in LF and only the body keeps CRLF. A later Source edit then turns the whole file into CRLF. The test pins this as it is; I didn't change it.
- **`toggle` checks blocking twice,** once itself and once inside `set`. This keeps `RELEASED` ahead of the source-editor message when the row isn't valid.
- **Formatting:** biome reports existing format drift in these test files. I formatted only my own changes and reverted the unrelated hunks it produced. Biome wasn't run on the `.svelte` files.
- **Stash:** I used `git stash` / `stash pop` once, in the clone only, to check baseline formatting. The tree was restored.
