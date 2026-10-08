The held/refused machinery is gone from Whispering. When the codec refuses typed text, nothing is kept: the control goes back to the current accepted row and a separate alert says why. Typecheck, the browser build and the mounted views pass. The other suites match the baseline exactly, with no new failures. Nothing was committed.

## What changed
- **Owner (`src/lib/row-editing.svelte.ts`):**
  - Removed `Held`/`Refused`/`NONE`, `hold`/`holding`, `HeldInput`, `same`, the `control` option, `dropRefused`, the `'refused'` status kind and the rule that blocked Source.
  - `set(next)` now forwards `next` to the native editor unchanged. It returns the native `Result`, or `undefined` when the existing gate refuses.
  - It keeps one `refusal: string | undefined`, which holds only the reason, never the rejected value.
  - `refusal` is cleared by an accepted `set`, an accepted `setText`, a successful reload, or `release`. Gated no-ops, failed reloads and save completions leave it alone.
  - `holds` is now only about save state.
- **`RowSaveStatus`** shows its own alert (`data-testid="row-refusal"`) next to the real save state: "Your last change was not taken: {reason}. What was there before it is shown instead." **`TranscriptCard`** now shows the status line when a refusal exists, even if the save state is "saved".
- **The four panels** bind straight to accepted row fields or `lf(body)`. Each textarea composes `withFileNewlines(input, current.row.body)` at its own input event. Model blank still becomes `null`, and the endpoint button is unchanged. Source `setText` keeps the whole-file newline rule.
- **`library.svelte.ts`:** removed the `'refused'` branches from the leave list and the `saveProblems` count, and fixed the comments on `settleDraft`, `draftHolds` and `renameFile`.
- **README / ARCHITECTURE:** the editing statements now describe the new behaviour.

## Tests
- I migrated the helpers in `row-slot.test-support.ts`, deleted the two owner tests built on per-control holding, and rewrote the refusal tests in the library, transformations, desktop-sequences and mounted suites.
- **New owner cases:**
  - A refusal while A is still saving: A's save landing does not clear B's notice.
  - Source still opens after a refusal.
  - Gated input and a failed reload keep the notice; a successful reload, `setText` and `release` clear it.
  - A failed save of A plus a refusal of B shows both, with only A in the row.
- **Library-level:** the notice does not block close (`prepareToLeave` returns true), rename or transform, and does not count in `saveProblems`.
- **Mounted cases:** DOM rollback is checked after `await tick()`, matching how the installed Svelte 5.56.3 `bind_value` restores the value. They cover the alert alongside a failed save, an accepted edit clearing it, CRLF bodies, and the title and model bindings.

## Checks and baseline (403257fe50)
| Check | Baseline | After |
|---|---|---|
| `bun test --isolate --path-ignore-patterns='src/routes/**'` | 441 pass / 27 fail | 442 pass / 27 fail, same failing set (checked with `diff`) |
| `test:mounted` (`src/routes`) | 15 / 15 | 15 / 15 |
| `bun run typecheck` | — | 0 errors |
| `bun run build` | — | exit 0 |

- The 27 failures were already there before any edit: scripted shell `kinds()` expectations (`"overwrite"` where `"replace"` was expected), missing scripted replies, and first-launch/definition checks.
- One test I wrote first failed because it asserted `kinds()` was empty, and that runs into the same `"overwrite"` fixture problem. I changed it to check the file text is unchanged rather than touch the fixture.
- `build-addon.ts` was denied in this sandbox, so suites ran against the existing addon.
- Nothing ran in a real browser or the desktop app.

## Unresolved
- **ADR-0507 and the Svelte skill's file-editor reference** still say refused input is kept beside its control (ADR lines ~38–48 and 159–161; `component-ui-patterns.md` lines ~156–157). Both were outside the files I was allowed to edit; they need an update or a Whispering-specific exception.
- The model input after `' '` now resets to `''` when its value is restored. That is consistent with storing `null`, but worth confirming in the browser.

## Optional fixture
`/private/tmp/refused-input-whispering-20261008/.tmp/whispering-refusal-fixture.patch` (`.tmp/` is gitignored, and `git apply --check` passes against the production state). It adds two buttons to `TransformationDetail`, shown only when `import.meta.env.DEV` is true and labelled "DEV FIXTURE: lone surrogate into title/prompt". Each appends `String.fromCharCode(0xd800)` to the real control and dispatches `input`. The prompt button only works while the Instructions tab is showing. It typechecked while applied and is removed from the source.

## Changed files (all under `apps/whispering/`)
- `src/lib/row-editing.svelte.ts`
- `src/lib/library.svelte.ts`
- `src/lib/row-slot.test-support.ts`
- `src/lib/row-editing.test.ts`
- `src/lib/library.test.ts`
- `src/lib/transformations.test.ts`
- `src/lib/workspace/desktop-sequences.test.ts`
- `src/routes/components/FileView.svelte`
- `src/routes/components/RecordingDetail.svelte`
- `src/routes/components/TranscriptCard.svelte`
- `src/routes/components/TransformationDetail.svelte`
- `src/routes/components/RowSaveStatus.svelte`
- `src/routes/components/row-views.mounted.test.ts`
- `README.md`
- `ARCHITECTURE.md`
