## Files read

```txt
.agents/skills/
|-- adversarial-review/SKILL.md
`-- post-implementation-review/SKILL.md
evidence/folder-workflow-review/
|-- ui-baseline.md
`-- native-experiment-output.txt
packages/folder/
|-- experiments/
|   |-- shared-folder-workflow.md
|   `-- shared-folder-workflow.ts
`-- src/
    |-- contract.ts, index.ts, bun.ts, folder.ts
    |-- table.ts, kv.ts, reading.ts, markdown.ts
    |-- files.ts, capture.ts, errors.ts
    `-- git/
        |-- browser-backend.ts   (push/fetch, 470-548)
        |-- history.ts           (commit/push runners, 505-604; grep of sync fields)
        `-- native-backend.ts    (runner + push, grep)
apps/todos/src/
|-- lib/ status.ts, status.test.ts, editor.svelte.ts, todos.svelte.ts, files.ts
`-- routes/components/ TodoDetail.svelte, TodosView.svelte (grep)
apps/honeycrisp/src/
|-- lib/ status.ts, note-source.ts (1-100), file-session.svelte.ts (100-175, 405-455)
`-- routes/components/ NoteDetail.svelte, RichEditor.svelte (grep)
apps/whispering/src/
|-- lib/ status.ts, editor.svelte.ts (300-409), library.svelte.ts (1222-1251, 1715-1789)
`-- routes/components/ RecordingDetail.svelte, TransformationDetail.svelte
apps/capture/src/lib/
|-- captures.svelte.ts (140-304)
`-- components/CaptureDetail.svelte (1-289)
```

Nothing was run; every claim below is from reading source and the two evidence files.

## Recommended next path

**Keep the folder API as it is and make three small repairs; do not collapse the surface in this wave.** The core (captures, conditional saves, `inspect`, source-preserving patches) is exactly what the user goal needs, and every app depends on it. The three UI findings are real, each has a root cause I could trace, and none requires a new abstraction.

## What a simpler design would have to preserve

| Guarantee | Who relies on it | Verdict |
| --- | --- | --- |
| A save is conditional on the captured hash and never retries | Every draft: `apps/todos/src/lib/editor.svelte.ts:114-140`, Whispering `editor.svelte.ts:338`, Capture `captures.svelte.ts:185`, Honeycrisp `file-session.svelte.ts:435`; UI outside-edit repro; experiment scenario 10 | Necessary. It is the only thing protecting an agent's edit from an app. |
| A structured change touches only the named value's span | `patchSource` in `todos/editor.svelte.ts:356`, `whispering/editor.svelte.ts:398`, `honeycrisp/note-source.ts:85,99`; UI round trip kept `agentOnly` and `café 🥔` | Necessary. This is "multiple apps interpret the same file". |
| An unparsed file is still listed, with exact source, and can be saved as written | `todos.svelte.ts:258-264`, `captures.svelte.ts:233-235`; UI malformed repro | Necessary. |
| One field's issue does not hide another field | `TodoDetail.svelte:77-88`, `todos.svelte.ts:512-516` (toggle needs only `done`) | Necessary for differing schemas. |
| `inspect` is pure and works on an unsaved buffer | All five detail components derive from it (`TodoDetail.svelte:32`, `NoteDetail.svelte:27`, `RecordingDetail.svelte:43`, `TransformationDetail.svelte:46`, Capture `draft.reading`) | Necessary. It is the most-used method in the package. |
| A receipt's `source` is the text of the bytes sent | `editor.svelte.ts:119` settles the buffer on it | Necessary, but apps already re-implement it for raw files (below). |
| `tables.x.update` validates supplied values (`InvalidValues`) | One production caller: `todos.svelte.ts:532` (toggle with no editor open), plus `todos/scripts/native.ts:141` | Matters for headless callers only. No UI edit path goes through it; they all call schema-less `patchSource`. |
| `tables.x.replace/rename/delete` check row membership and return a snapshot | Todos, Whispering, Capture. Honeycrisp uses none of them. | Inherited convenience, not a user-visible guarantee. |
| `kv.update` never creates (ADR-0487) | Whispering works around it: `library.svelte.ts:1752-1754` | Inherited. See the alternative below. |
| `ParseError.diagnostics` is never empty | One real dependent: `honeycrisp/note-source.ts:45` uses it as the only reasons list | Inherited, and the cause of the duplicate message. |

## The smaller alternative I constructed

Make a table a reader plus `create` and `update`; send every whole-text operation through `files`.

```ts
tables.todos: { name, inspect, list, get, create, update }   // no replace / rename / delete
files:        { read, create, replace, move, remove, ... }   // unchanged
```

**Deletion prize (the strongest one):**
- `FileTable.replace`, `rename`, `delete`, and `captureRow` (`table.ts:401-412, 523-591`).
- Three error aliases (`TableReplaceError`, `TableRenameError`, `TableDeleteError`).
- The check in `rename` that re-hashes the capture's source on every call (`table.ts:544-560`).
- Rows and KV would repair the same way, which removes the asymmetry the experiment flagged in 6c.

Honeycrisp is the existence proof: its lib code calls `tables.*.list` and `inspect` only, and saves through `files.create/replace/move/remove` (`file-session.svelte.ts:132-171, 434-435`).

**What it costs:**
- Todos, Whispering and Capture each assemble `{ ...capture, stem, source, ...inspect(source) }` themselves. All four apps already own the decode-from-bytes step for raw files (`todos/files.ts:154`, Honeycrisp `file-session.svelte.ts:147`, Whispering `editor.svelte.ts:357-367`, Capture `captures.svelte.ts:163-180`), so that burden is already paid.
- The row-membership refusal disappears, and so do the stem validation and vacancy pre-check in `rename` (`table.ts:382-395`).
- Three heavily tested save paths get rewritten.

**Why it loses for now:** it removes about 100 package lines and one concept, but three of four apps use the returned snapshot directly as the next baseline. It also leaves `update` as the only validated write, so it does not unify the two write vocabularies. The churn outweighs the prize unless the `files.move` check below shows the vacancy pre-check is redundant.

## Alternative worth considering even if you keep the design

**Let `kv.update` create the file when it is absent.** The experiment write-up says `kv.create` and `kv.update` are called only by package tests. That is wrong: Whispering's `saveSettings` already writes the update, `NotFound`, create sequence inside a two-attempt conflict loop (`library.svelte.ts:1751-1763`). Honeycrisp also seeds `kv.json` with `{}` through `files.create` (`platform/first-open.ts:49`), which looks like a second workaround, though I did not confirm the motive.

- **Prize:** `kv.create`, the `NotFound` outcome of a KV save, and the branch in Whispering.
- **Cost:** it reverses ADR-0487. A `kv.json` someone deleted on purpose comes back on the next explicit settings save, and a create race still surfaces as `Exists` or `Conflict`.

This is a product and ADR decision, not a repair.

## Correctness blockers

None of these loses data; all three make the UI say something untrue or unhelpful. I found no data-correctness defect in the paths I read.

1. **Push failure leaks third-party advice when divergence has not been observed.**
   - `browser-backend.ts:504-518` lets isomorphic-git's thrown message through, and `history.ts:587` stores it as `PushOutcome.error`.
   - `todos/status.ts:226-237` replaces it with `DIVERGED` only when `git.sync` already shows ahead and behind. Before a fetch it does not, so the raw "Use force: true" text is shown.
   - `status.test.ts:72-106` covers only the observed case, with an invented message.
   - The native backend rejects with git's stderr (`native-backend.ts:100-101`), so the desktop path probably leaks git's `hint:` lines the same way.

2. **The parse message is rendered twice.**
   - `reading.ts:76` makes the message its own first diagnostic whenever the parser has none (missing fence, unclosed fence, not a mapping, KV not an object).
   - `TodoDetail.svelte:69-74`, `NoteDetail.svelte:105-110`, `RecordingDetail.svelte:113-118` and `TransformationDetail.svelte:124-129` print the message and then every diagnostic.
   - `CaptureDetail.svelte:251` already filters the repeat inline.

3. **An unreadable todo opens looking empty.**
   - `TodoDetail.svelte:37` holds `tab` in component state, and `TodosView.svelte:88` does not key the component, so the tab survives a selection change.
   - On Notes, a malformed row shows a blank disabled textarea (`:97-105`) and a banner that says "Edit the source" with no action.
   - Capture (`CaptureDetail.svelte:257`) and Honeycrisp (`RichEditor.svelte:348`) both have a button for this.

## Authorized repairs versus product choices

**Repairs within the current contract:**
- **Duplicate message:** copy Capture's inline condition (`diagnostic.message !== parseError.message`) into the four `{#each}` blocks. No helper. Add one sentence to the `ParseError.diagnostics` doc saying it may repeat `message`.
- **Repair discoverability:** in the `TodoDetail` parse banner, add a button that sets `tab = 'source'`, shown when the tab is not already Source. `Button` is already imported.
- **Push advice:** at `browser-backend.ts:504-518`, where the library already writes its own fallback text, catch the non-fast-forward rejection and throw library-owned wording with no advice, matching `PullError.Diverged`. Add a `status.test.ts` case for unobserved divergence using the real string.

**Choices for you or the coordinator:**
- **Empty diagnostics:** making `diagnostics` possibly empty and deleting the fallback is the cleaner contract and removes Capture's filter. It is a public type change, and it touches README:187, `folder.test-d.ts:373`, about four tests, and `note-source.ts:45`.
- **Auto-select Source:** selecting Source automatically for an unreadable item, instead of a button. I would not: an outside edit adopted mid-session would move the person's tab.
- **Whispering buttons:** the same button in `RecordingDetail` and `TransformationDetail`. They have the same shape but were not in the repro.
- **Typed push rejection:** a `rejected` push status would let `pushOutcomeLine` drop its `git` parameter and offer Pull. It needs the native runner to keep stdout from `--porcelain`.
- **KV upsert and the table-as-reader collapse**, as above.

Opening writing `.git`, and shared names with differing schemas, do not change any of this.

## Deciding claims that need a check

1. Does isomorphic-git throw `PushRejectedError` from `git.push` for the diverged case, or return it in `result.refs`? This decides whether the push repair is a catch or a change at line 517.
2. What does `lastPush.error` hold on the native backend for the same divergence? If it carries git's hints, the repair needs a second site.
3. Does `files.move` refuse an occupied destination on both stores as strictly as `table.rename`'s `vacant()` pre-check (ADR-0477)? If yes, the table-as-reader collapse costs less than I estimated.
4. Why does `honeycrisp/platform/first-open.ts:49` seed `kv.json`? If it exists so `kv.update` works, two apps pay for ADR-0487 and the upsert alternative gets stronger.