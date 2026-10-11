# OPFS acceptance

## Current page

From the repository root:

```sh
bun packages/folder/evidence/opfs/serve.ts            # the page on 127.0.0.1:5181, or PORT
bun packages/folder/evidence/opfs/serve.ts --build    # compile check only
```

The page opens folders through the production browser opener in its own
origin's OPFS, under `Epicenter Dev/local/opfs-evidence-*`, and removes only
those directories when the run finishes. Keep the same host and port: the
origin is the storage. No application origin is touched.

Besides the file, history, recovery, identity, and closing checks, which
use conditional file and table commands, the page checks row repair against
real OPFS: malformed and schema-invalid text reads as `InvalidRow` with its
exact text, and a `replace` guarded by that read saves the canonical row.

2026-10-11: the three row editor checks (ordered `set` and observation,
repair through the editor, and a removed row's failed save and `reload`)
were retired with the row-API clean break (ADR-0515), which removed the row
editor.

Stream probes use the browser's own OPFS API in a directory of the run's own:

- An open write stream refuses the removal of its file and the recursive
  removal of a directory above it; a sibling file stays, and the write lands.
- A stream for a file removed after its handle was taken: recorded as a note,
  since an engine that does not recreate the file only makes the recheck
  unnecessary.
- With the `getFile()` recheck the replacement makes, that stream is aborted
  and the path stays absent.

These checks have not been run in a browser since they were written. Run the
page in the browser under test before claiming any result.

### Chrome 142 behavior the replacement relies on

The coordinator's probes in Chrome 142 on macOS observed what the stream
probes check: an open write stream refused removing its file and the
recursive removal of an ancestor directory, and left a sibling untouched; a
stream opened for a removed handle and closed without a recheck created the
file again; with a `getFile()` recheck, which was `NotFoundError`, aborting
the stream left the path absent. `src/opfs-store.ts` depends on these.
`src/opfs.test-support.ts` models them, and `src/opfs-store.test.ts` tests the
store against that model; the model shows the protocol, not that any browser
behaves that way. No other engine, and no other Chrome version, is verified.

## History: the 2026-10-04 run

Everything below describes a run against the integrated OPFS and native
protocol 5 source of 2026-10-04, with the row editor ADR 0504 later replaced:
a draft with a baseline, an explicit save that refused invalid drafts,
review of incoming changes, `adopt`, and `dispose`. Browser folders have
since stopped reading IndexedDB at all (see `../opfs-clean-break-review.md`):
the "legacy IndexedDB migration" check was removed, and an identity check
that refuses foreign and unmarked directories replaced it. The counts below
are not current.

Browser evidence used Chrome 142 on macOS, secure localhost origins, and the
production browser opener. Browser persistence permission was not granted
(`persisted: false`).

### Working demos

```sh
bun packages/folder/evidence/opfs/serve.ts
bun packages/folder/evidence/edit-handle/canonical-dev.ts
```

The OPFS page passed all 18 checks twice. Its separate reload check passed. It compares each logical file with the physical scoped OPFS file by hash, excludes private `.git` files from listings, and exercises independent contexts, bytes, empty directories, history, legacy IndexedDB migration, interrupted incoming updates, third-state refusal, explicit recovery, and canonical editing. Each run uses and removes its own disposable folders. A raw `getFile()` snapshot became unreadable after replacement in this browser; the opened Blob retained its bytes.

![OPFS acceptance](./acceptance.png)

The canonical page then shared one RowEditor among Vanilla, Solid, and Svelte callers. Actual use verified shared typing, invalid-field refusal, canonical save and reload, preservation of undeclared `owner` and `labels`, incoming changes held while dirty, explicit keep/adopt, and retained editing across view unmount/remount. Invalid-field refusal, the dirty state, and keep/adopt belong to the retired editor.

![Canonical editor after reload](./canonical.png)

### Application journeys

All five consumers opened their existing datasets at retained localhost origins after cutover: Capture, Vocab, Honeycrisp, Todos, and Whispering. Ordinary saves persisted through reload. Each exposed and resolved an incoming or exact-source choice without discarding the held draft implicitly. Whispering also retained the matching audio file and transcript; actual playback reached one second. No microphone or model request was exercised.

Todos additionally committed and pushed its disposable local history, pulled a file edited with ordinary native Git, and displayed its incoming comment, title, done state, `owner`, and `labels` byte for byte. A subsequent structured edit saved canonical YAML, preserving unknown metadata and normalizing the comment away. Reload retained that save. A subsequent status repair was rechecked in the same mounted editor: the footer changed from unsaved typing to saved, and reload retained the bytes. The fixture is `scripts/remote-edit.ts <native-checkout> <stem> [title]` under `apps/todos`.

![Exact incoming Todos file](./todos-pull.jpg)

![Todos after structured save and reload](./todos-reloaded.jpg)

![Todos save footer after the repair](./todos-footer.jpg)

### Automated verification

The integrated folder suite passed 685 tests with 18 opt-in native tests skipped, with a clean TypeScript check. The actual invoke bridge separately passed 18 tests and 100 assertions. Native recovery and owner tests passed 95 core tests and 20 plugin tests; one unrelated opt-in test was ignored. Honeycrisp passed 59 Rust tests and 25 native close-lifecycle tests. Whispering passed 14 Rust tests.

Application suites passed: Capture 84, Vocab 105, Honeycrisp 263, Todos 121, and Whispering 437. Their TypeScript checks and browser builds passed. Todos and Whispering host builds also passed.

Fault-injected production storage and editor tests cover lost replies and interrupted incoming updates. These are automated evidence, not a claim that the app UI can manufacture a storage failure.

### Limits

Native desktop UI acceptance remains open while the macOS session is locked. Headless native verification does not substitute for that journey. These checks establish process interruption behavior, not physical power-loss durability. External writers can still change a file after a final read; canonical saves deliberately overwrite the whole document. Browser storage remains subject to origin quota and browser retention policy.
