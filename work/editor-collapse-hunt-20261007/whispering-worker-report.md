The migration is done and every check that can run here passes; the remaining failures are identical to the baseline. Nothing is committed.

Whispering's row views and tests now go through one guarded `editing.set(next, { control })`, and `fieldText`, `bodyText`, `sourceValue`, `setField` and `setBody` are deleted with no aliases left.

**Before editing I found:**
- The old setters built the full row from `editor.row` themselves, which is why a held title or body was never overwritten by another control. With callers passing complete rows, that guarantee now needs an explicit check, so `set` refuses before publishing.
- `setField(key, undefined)` deleted a field; under `set`, deletion is leaving the key out of `fields`.
- `sourceValue()` returned `''` outside the source view. Every view renders the source textarea only in that view, so `lf(row.text)` is equivalent.
- TranscriptCard had no mounted test, and no mounted test covered refusal per control in TransformationDetail.

**`row-editing.svelte.ts`**
- New readonly `held` getter exposes the held values to views.
- `set` returns `undefined` when the gate refuses (not taken, `source` preferred, or the current row isn't valid). Otherwise it returns the native `Result`.
- A held field or body can't be changed by a row from another control, or by a command with no control. That returns `Err(HeldInput { path, control })` and publishes nothing. `same()` compares values structurally, and a missing key counts as a change.
- A body from the body control gets the file's line endings back from the current `row.body`; any other body is saved exactly.
- On success only the origin's held value is cleared. On a native refusal only the origin's typed string is held. With no origin, nothing is held or cleared.
- The module comment is updated, and its private `lf` is gone.

**Views (TransformationDetail, RecordingDetail, TranscriptCard, FileView)**
- Each getter shows the held value, else the valid row's value: `title`, `model ?? ''`, or `lf(body)`. Source shows `lf(editing?.row.text ?? '')`.
- Each setter reads `editing?.row` when the event fires, checks it is valid, builds the complete row, and calls `editing.set` with its control.
- An empty model still saves as `null`, and the endpoint button sends `endpoint: null` with no control.
- `inspectRow` in TransformationDetail is unchanged.

**Tests**
- `row-slot.test-support.ts` adds test-only helpers: `typeField`, `typeBody`, `fieldShown`, `bodyShown`, `sourceShown`.
- Every old callsite is migrated. library.test.ts already had a local `typeBody` that returned a boolean; I renamed it `bodyTaken`. In home-controls.test.ts only the import and line 84 changed.
- New coverage in `row-editing.test.ts`:
  - a held title or body is refused when another control or a command changes it (`HeldInput`)
  - a model change plus unknown metadata saves while both held values stay
  - the body's own correction clears only the body
  - an omitted field is deleted
  - a body that comes from no control is saved exactly
  - a refusal with no control holds nothing
  - the gate works for an invalid row and when `source` is preferred
- New mounted tests:
  - TranscriptCard shows a CRLF body as LF, keeps a held body visible in a newly rendered card, and saves with CRLF.
  - TransformationDetail holds title and instructions together while the model saves around them; emptying the model saves `null`; discarding the title leaves the body held.
- The existing source-repair and retired-control mounted tests are unchanged and pass.

**Changed paths** (all under `apps/whispering/src/`):
- `lib/row-editing.svelte.ts`, `lib/row-slot.test-support.ts`, `lib/row-editing.test.ts`
- `lib/library.test.ts`, `lib/leave.test.ts`, `lib/transformations.test.ts`, `lib/recipe-playground.test.ts`, `lib/recording-collection.test.ts`, `lib/home-controls.test.ts`
- `lib/workspace/desktop.test.ts`, `lib/workspace/desktop-sequences.test.ts`
- `routes/components/` `TransformationDetail.svelte`, `RecordingDetail.svelte`, `TranscriptCard.svelte`, `FileView.svelte`, `row-views.mounted.test.ts`

No README or other docs referenced the old methods, so none changed.

**Verification** (from `apps/whispering`)

| Command | Result |
| --- | --- |
| `bun run typecheck` | 0 errors in svelte-check; native `tsc` passed |
| `bun test --isolate src/lib/row-editing.test.ts` | 12 pass |
| `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test --isolate --conditions=browser --conditions=svelte src/routes` | 15 pass, 0 fail |
| `bun test --isolate --path-ignore-patterns='src/routes/**'` | 439 pass, 27 fail |
| `bun run build` | exit 0 |

- **Baseline evidence:** I stashed my changes, ran the non-mounted suite at HEAD (437 pass, 27 fail), and restored them. The sorted lists of failing tests are identical. A patch backup in `$TMPDIR` confirmed the restore was exact; the stash list is empty.
- **The 27 failures** are in `desktop-sequences.test.ts` (18), `desktop.test.ts` (4), `library.test.ts` "first launch", `publish.test.ts`, and three others. They include "no scripted reply for apply" and a sandbox loopback-port error.
- **Mounted warnings:** three `[svelte] derived_inert` warnings appear in the mounted run; the HEAD run has the same three, from pre-existing tests.
- **Not run:** `bun run test:mounted` failed with "bun: command not found" in the script's shell, so I ran its command directly. I also skipped the `build-addon.ts` step of `bun run test`, because it writes a build into `packages/folder`.

**Remaining risks**
- Because those desktop tests fail at baseline, the callsites I migrated there are only typechecked, not exercised to a passing run.
- If a single `set` changes the origin field and an unrelated field, and the codec refuses because of the unrelated one, the origin's string is still held with that reason. The views can't produce this, since they always spread the current row.
- `HeldInput` is an unexported app-level error, so `set`'s error type is now `RowSetError | HeldInput`.
- Separate edge cases, not changed: `setText` takes its line endings from `row.text`. TranscriptCard's read-only text and Copy use the raw body, which may contain CRLF.