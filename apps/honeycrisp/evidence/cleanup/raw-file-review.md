```text
Newly read files (this round)
repository/
|-- packages/
|   |-- vite-config/src/index.ts
|   `-- ui/
|       |-- package.json                      (first 60 lines)
|       `-- src/loading/loading.svelte
|-- node_modules/.bun/svelte@5.56.3/node_modules/svelte/
|   |-- package.json                          (version, export conditions)
|   `-- src/
|       |-- reactivity/map.js
|       `-- internal/client/
|           |-- runtime.js
|           |-- reactivity/sources.js
|           |-- reactivity/deriveds.js
|           |-- reactivity/batch.js           (lines 60-759)
|           |-- dom/blocks/if.js
|           `-- dom/blocks/branches.js
`-- apps/honeycrisp/src/lib/
    |-- svelte-modules.test-support.ts        (re-read, then edited)
    |-- notes.svelte.ts                       (re-read after edit)
    |-- notes.test.ts                         (new; re-read)
    `-- effects.test-support.svelte.ts        (new)
```

The stuck "Opening kv.json" view is a defect that exists at baseline `0ae4177383`, not one the cleanup introduced, and it is now repaired in `notes.svelte.ts` with a regression test. Tests, typecheck, Biome and the browser build pass; the desktop-ui and native builds still need your run.

## Diagnosis

The view was not failing to render: `notes.selection` itself stayed at `loading` after the read finished.

- **What the old code did.** The `selection` derived looked up one key: `editors.get(selectedPath)`, then `openFiles.get(selectedPath)`. With `SvelteMap`, each key has its own signal, so the derived's dependencies depended on which path was selected.
- **What Svelte 5.56.3 does.** When an effect is torn down and its cleanup reads a derived, Svelte re-runs that derived with the values from before the update (`runtime.js`, the `is_destroying_effect` branch of `get`). That re-run goes through `update_reaction`, which replaces the derived's dependency list with the ones from the old-value run.
- **How they combine.** Selecting `kv.json` after a note:
  1. The detail pane reads `selection` normally. It now depends on the `kv.json` entry.
  2. The outgoing note's components are torn down and a cleanup reads `selection`. Svelte re-runs it with the old path, so it depends on the note's entry again and is removed from the `kv.json` entry's listeners.
  3. The read completes and the entry changes from loading to text. Nothing is listening, so `selection` keeps its cached `loading` value.
- **Why the second click worked.** Selecting a note and then `kv.json` again changes `selectedPath`, which the derived always depends on, and by then the entry is already text.

History was not part of the cause; the sequence note → raw file is enough.

## Reproduction before repair

- **Real components.** I mounted the real `NotesView` in a throwaway jsdom harness (jsdom from the existing install store, not added as a dependency; harness deleted afterwards). Result: "Opening kv.json" still present after the read, no text area, no error thrown, and `notes.selection` reporting `file loading`.
- **Baseline attribution.** The same harness against `src/` extracted from `HEAD` (`0ae4177383`) fails identically. The cleanup's 15 files are not involved.
- **Automated regression.** The new `src/lib/notes.test.ts` fails on the keyed-lookup derived with the same symptom, the `text` state never arriving, and passes with the repair.

A first DOM-free attempt without a cleanup reader did not reproduce, which is what pointed at teardown.

## Repair

One change in `apps/honeycrisp/src/lib/notes.svelte.ts`: the `selection` derived now reads both collections whole, the note rows, and the path on every run, in a fixed order, before deciding anything.

```ts
const drafts = new Map(editors);
const files = new Map(openFiles);
const rows = notes;
const path = selectedPath;
```

Its dependencies are now the same whichever path is selected, so the old-value re-run cannot change them. A comment on the derived records why. There is no refresh, timer, remount or new wrapper; the copied maps hold the same draft instances.

## Changed paths this round

All under `apps/honeycrisp/src/lib/`:

- `notes.svelte.ts`: the `selection` derived only.
- `notes.test.ts` (new): the regression test.
- `effects.test-support.svelte.ts` (new): a ten-line `watch` helper built on `$effect.root` and `$effect`, so the test observes state the way a mounted component does without reaching into Svelte internals.
- `svelte-modules.test-support.ts`: compiled runes modules now import the client build of `svelte/reactivity`. Bun's default conditions resolve it to the server build, where `SvelteMap` is a plain `Map` that notifies nothing, so no test could have observed this state reactively before.

No new dependencies. The earlier 15 cleanup files are unchanged.

## Checks

Run from `apps/honeycrisp` unless noted.

| Command | Result |
| --- | --- |
| `bun test --isolate` | 151 pass, 0 fail, 414 assertions, 8 files (was 150 / 410 / 7; the new test adds 1 test and 4 assertions) |
| `bun run typecheck` | Browser and Tauri svelte-check: 0 errors, 0 warnings; scripts `tsc` passed |
| `bun x biome check --diagnostic-level=error .` | "Checked 55 files. No fixes applied." |
| `bun run build` | Passed |
| `bun scripts/check-boot-purity.ts` (repo root) | "boot-purity OK" |
| Real-component jsdom harness, after repair | Text area shown, loading gone, no errors |
| `bun run build:desktop-ui`, native build | **Not run**: nested `bun` is not on PATH in my sandbox and env-prefixed commands are denied |

## Second-read audit of newly touched files

| File | Inline test | Smell check | Invariant audit | API shape |
| --- | --- | --- | --- | --- |
| `notes.svelte.ts` | The derived reads four inputs, then resolves note-before-file exactly as before | No new helper or state; the two map copies are the dependency reads, and the comment says so | Same draft instances returned; switch retention, external adoption, conditional saves, recovery and close protection are untouched code | `Selection` and `notes.selection` unchanged |
| `notes.test.ts` | One fake folder, one test, real `createNotes` | Fake host is cast once at the boundary; it supplies only what `createNotes` calls | Asserts loading → text, and that the text draft holds the file's bytes | n/a |
| `effects.test-support.svelte.ts` | `watch` is `$effect.root` around `$effect` | One caller; kept as a file because runes need a compiled module | n/a | One function, returns stop |
| `svelte-modules.test-support.ts` | One extra replace on the compiled output | Path resolved from the installed package, not hard-coded | `draft.test.ts` and `serve.test.ts` still pass; neither imports `svelte/reactivity` | Unchanged for callers |

## Limits and things to know

- **Native confirmation is yours.** The repair is verified in jsdom with the real components and in the unit test, not in the Tauri window.
- **The regression test depends on effect order.** It needs the normal reader to run before the cleanup reader, which matches creation order today. If a Svelte upgrade fixes the underlying behavior, the test still passes and the comment on the derived becomes historical.
- **The same Svelte behavior can affect other deriveds.** Any derived whose dependencies vary with its inputs, and which is read from an effect cleanup, has this exposure. I checked the store: `notePaths` has a single dependency and is safe. I did not audit component-level deriveds; none is implicated in this defect.
- **Cost.** `selection` now recomputes when any open draft or open file entry is added, removed or replaced, not just the selected one. The collections are the open drafts, so this is small.
- **Concurrent work.** The auto-commit changes in the live checkout touch `notes.svelte.ts`; my edit there is confined to the `selection` derived (lines 129-152 in this clone).

Nothing is staged or committed.
