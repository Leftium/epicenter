```text
Newly read files (this round)
apps/honeycrisp/
|-- src/lib/notes.svelte.ts                    (lines 122-160 and 526-540, before and after each trial edit)
|-- src/lib/notes.test.ts                      (re-read after strengthening)
|-- src/lib/effects.test-support.svelte.ts     (rewritten; current in full)
|-- src/lib/svelte-modules.test-support.ts     (final diff re-read)
`-- src/routes/components/NotesView.svelte     (lines 116-141, via a scratch copy)
```

The direct-getter candidate fails with the real components, so I kept the stable-dependency derived. The one change that does land this round is a stronger regression test, because the previous one did not catch this candidate's failure.

## Result of the comparison

| Shape | Unit regression (as it was) | Unit regression (strengthened) | Real `NotesView` in jsdom |
| --- | --- | --- | --- |
| Baseline: keyed lookups in the private derived | fail | fail | fail: stays on "Opening kv.json" |
| Candidate: no private derived, keyed lookup in `get selection()` | pass | fail | **fail: stays on "Opening kv.json"** |
| Kept: private derived that reads both collections whole | pass | pass | pass, including switching back and forth with the same draft instances |
| Extra variant: direct getter **and** a `NotesView` with no `{@const}` | n/a | n/a | pass |

## Why the direct getter fails

With the getter, `notes.selection` reports `file text` after the read, so the state is right. The view still shows loading.

`NotesView.svelte:120` holds the selection as `{@const selection = notes.selection}`, and a `{@const}` is a derived. With no store-level derived in between, that view derived now reads the per-key signals itself. When the outgoing note's components are torn down and read it, Svelte re-runs it with the old path and it loses its subscription to the `kv.json` entry, exactly as the store derived did before. The hazard moved one level down; it did not go away.

So the map copies are not there to preserve a cache. They are what makes the dependency set independent of which path is selected, and that has to hold at the first derived any consumer reaches. The store is the one place that can guarantee it for every consumer.

## The extra variant, and why I did not take it

Removing the `{@const}` from `NotesView` as well (passing `notes.selection` as a snippet parameter, which is not a derived) does pass in the harness. I did not apply it, for two reasons:

- It is outside what you asked me to test and edits a file this repair has not touched.
- It makes correctness depend on no component ever deriving over the selection. `{@const}` and `$derived` are the natural way to hold it, and the failure is silent: the state is right and one pane is stale.

If you or the user prefer that boundary anyway, the evidence is saved and it is a small change; say so and I will apply it with the test adjusted to match.

## What changed this round

- **`src/lib/notes.test.ts`**: the test now holds the selection through a derived, as the template does, and reads that in the cleanup. This is the shape that fails natively. Verified to fail on both the baseline shape and the direct-getter candidate, and to pass on the kept repair.
- **`src/lib/effects.test-support.svelte.ts`**: added `constant(read)`, a derived over `read`, next to `watch`.
- **`src/lib/notes.svelte.ts`**: same repair as before, with two sentences added to its comment recording that the accessor form was tried and why it does not help.

The trial edits to `notes.svelte.ts` were reverted. The final diff for the repair and the test support is:

```diff
--- a/apps/honeycrisp/src/lib/notes.svelte.ts
+++ b/apps/honeycrisp/src/lib/notes.svelte.ts
@@ -126,17 +126,31 @@
+	/**
+	 * Every run reads the same signals whatever is selected: both collections
+	 * whole, the note rows, and the path. Svelte re-runs a derived with the
+	 * values from before an update while an effect that read it is torn down,
+	 * and keeps that run's dependencies. A lookup by the selected key alone
+	 * would leave this subscribed to the path just left, so a file that
+	 * finishes loading afterwards would never show. Reading the lookup straight
+	 * from the accessor does not avoid it: a view's `{@const}` over the
+	 * selection is a derived too, and inherits the same keyed dependencies.
+	 */
	const selection = $derived.by((): Selection | undefined => {
-		if (selectedPath === undefined) return undefined;
-		const editor = editors.get(selectedPath);
+		const drafts = new Map(editors);
+		const files = new Map(openFiles);
+		const rows = notes;
+		const path = selectedPath;
+		if (path === undefined) return undefined;
+		const editor = drafts.get(path);
		if (editor !== undefined)
			return {
				kind: 'note',
				editor,
-				entry: notes.find((entry) => entry.path === selectedPath),
+				entry: rows.find((entry) => entry.path === path),
			};
-		const file = openFiles.get(selectedPath);
-		return file && { kind: 'file', path: selectedPath, file };
+		const file = files.get(path);
+		return file && { kind: 'file', path, file };
	});
```

`get selection()` is unchanged (`return selection`). The other hunk in that file's diff is the earlier `openNote` removal from the cleanup.

Changed paths relative to `0ae4177383`: the 15 cleanup files, plus `src/lib/notes.svelte.ts` (already in that set), `src/lib/svelte-modules.test-support.ts`, and the two new files `src/lib/notes.test.ts` and `src/lib/effects.test-support.svelte.ts`.

## Checks

Run from `apps/honeycrisp`.

| Command | Result |
| --- | --- |
| `bun test --isolate` | 151 pass, 0 fail, 414 assertions, 8 files |
| `bun run typecheck` | Browser and Tauri svelte-check: 0 errors, 0 warnings; scripts `tsc` passed |
| `bun x biome check --diagnostic-level=error .` | "Checked 55 files. No fixes applied." |
| Real-component harness, kept repair | 1 pass, 8 assertions: loading → text, back to note, back to file, same draft instances |
| `bun run build`, `build:desktop-ui`, native build | Not re-run this round; the only production change since the last browser build is the comment |

## Evidence kept outside the repo

In `/tmp/claude-501/honeycrisp-selection-evidence/`:

- `candidate-direct-getter.diff`
- `candidate-direct-getter.unit.log` (passes the old test)
- `candidate-direct-getter.strengthened-unit.log` (fails)
- `candidate-direct-getter.real-components.log` (fails)
- `baseline-keyed-derived.strengthened-unit.log` (fails)
- `candidate-direct-getter-and-view-without-const.real-components.log` (passes)
- `kept-stable-derived.real-components.log` (passes)
- `harness/` (the jsdom harness, including the `NotesViewDirect.svelte` variant)

The harness uses jsdom from the existing install store by absolute path and must sit inside `apps/honeycrisp` to resolve modules; it is removed from the app and nothing depends on it.

## Second read of touched files

| File | Inline test | Smell check | Invariant audit | API shape |
| --- | --- | --- | --- | --- |
| `notes.svelte.ts` | Four reads in fixed order, then note-before-file as before | The map copies are the dependency reads; the comment says so and records the rejected accessor form | Same draft instances returned; retention, adoption, conditional saves, recovery and close protection are untouched code | `notes.selection` and `Selection` unchanged |
| `notes.test.ts` | One fake folder, one test, real `createNotes`, selection held as a view holds it | The fake host is cast once and supplies only what is called | Asserts loading → text and that the text draft holds the file's bytes; fails on both broken shapes | n/a |
| `effects.test-support.svelte.ts` | `watch` is an effect in a root; `constant` is a derived behind a getter | Two small helpers, one test file using both; a compiled module is required for runes | n/a | Two functions |
| `svelte-modules.test-support.ts` | One replace on compiled output | Client path resolved from the installed package | Other suites unaffected; 151 pass | Unchanged for callers |

## Limits

- The repair is verified in jsdom and unit tests, not in the Tauri window; that is your native recheck.
- The cost of the kept repair is that `selection` recomputes when any open draft or open file entry changes, and copies two small maps each time.
- The underlying behavior is Svelte 5.56.3's. If an upgrade changes it, the test still passes and the keyed lookup could come back; the comment says what to re-test.

Nothing is staged or committed.
