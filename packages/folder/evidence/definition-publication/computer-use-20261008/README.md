# Publication computer-use acceptance and collapse passes

Exercised on 2026-10-08 from
`/Users/braden/Code/worktrees/epicenter/app-schema-derive-export-import`.
Starting HEAD: `5e404a90f3875bf39f27b5a42cde6b6f31bcc316`.
The live checkout includes unrelated dirty work. Before editing, HEAD, staged and
unstaged patches, and untracked paths were recorded in
`/tmp/definition-iteration-20261008/`. Only the files described below were changed.
The original staged patch remained byte-identical.

## Pass one: one acquisition owner in the evidence page

`packages/folder/evidence/opfs/main.ts` repeated opening and handle-registration
code for changed declarations and automatic history. Both now use the existing
opener, which owns disposable IDs and handle cleanup. Manual history remains the
default. The automatic-history case still uses a separate ID and explicitly sets
`commitOnEdit: true`.

Actual Chrome 142 UI on `http://127.0.0.1:27481/` ran the production OPFS opener.
The first run, `opfs-evidence-muyw4s97-c4e2bfd7`, passed 25 checks. Its separate
history case settled at `1413f2588affd11983cd6b60d0a61f5dff957cf5` and unchanged
reopening retained it. The reload journey passed, reading saved definition bytes
before reacquiring the folder.

After both collapses, run `opfs-evidence-muywh3kt-6f558b33` again passed all 25
checks. Its history case settled at `a7c071d037a1b8ef8bf0726b1df618d3de4158e9`
and remained clean and unchanged on reopening. The stored definition's hash and
the folder read's hash matched (`3d18ee0a0b2fbc68`, displayed prefix). The final
reload check passed for `opfs-evidence-muywi68w-1e338c2e`. The page removed its
disposable folders after each run.

## Pass two: copy directly into the final array

`55a3f1cad3:packages/definition/src/export.ts` previously copied arrays into temporary
objects and then reconstructed arrays. It now creates the final array directly.
Own-key validation, descriptor inspection, cycle refusal, runtime-dependency
refusal, numeric normalization, and reference/cache fidelity checks remain.
Sparse arrays still refuse export. A regression covers nested array order,
empty arrays, negative-zero normalization, and sparse annotations.

This preserves the current native-TypeBox contract. Canonical preparation remains
a separate design proposal; no fidelity guard or history policy was removed.

## Honeycrisp browser

Command: `bun dev:honeycrisp:ui -- --host 127.0.0.1 --port 27482 --strictPort`.
Disposable browser origin: `http://127.0.0.1:27482/`, Chrome Guest.
Using the actual UI, created `notes/b86458c755.md`, titled
`Publication browser 20261008`, entered an original body, then replaced it with
`Browser acceptance edited body survives reopening.`

After a page reload and a new-tab reopening of the same origin, the list and
note editor showed the saved title and edited body. The file browser read
`definition.json` before and after reopening: Honeycrisp title, empty KV,
folders/notes schemas, date-time constraints, and x-field hints remained present.
The app terminal's `git log -1` after reopening returned the same head displayed
before it: `8b2de2ee13e33933c2acccf7dbf064debe710dfd`, Update notes/b86458c755.md.
The UI reported Saved and committed. These are actual saved-file and Git reads,
not screenshots alone.

Another UI session switched Chrome's active window during the run. One stale
element action was refused, and a read-only selection landed on that session's
note. No content was written there. Subsequent actions checked the disposable
origin before selecting controls. Results from the other origin were excluded.

## Honeycrisp native

Built with `bun run --cwd apps/honeycrisp tauri build --debug --bundles app`.
Copied the exact built bundle to
`/tmp/definition-iteration-20261008/Honeycrisp.app` and launched it with
`HONEYCRISP_ROOT=/tmp/definition-iteration-20261008/native-root`.
Actual process: 77689; first relaunch: 99794.

Through native computer use, created `notes/439f29e39f.md`, titled
`Publication native 20261008`, entered an original body, then replaced it with
`Native acceptance edited body survives reopening.` The app was quit and
relaunched. Its list and rich-text editor showed the saved title and edited body.

Physical note bytes, definition bytes, and full settled Git log were captured
before reopening and compared afterward. All matched; `git status --porcelain`
was empty. The head remained
`e6b4623d64836b7898e1a4131565531d28ea8e9e`, Update notes/439f29e39f.md.
The saved definition SHA-256 was
`ebf4cb74e522c1fedd35508a38eade4460964b0d315ede582f5cf13b5fb35405`.
It also matched current `exportSchema(honeycrispDefinition)` bytes exactly.

After the array collapse, rebuilt the integrated source and copied the exact
bundle to `/tmp/definition-iteration-20261008/Honeycrisp-integrated.app`.
Process 62563 reopened the same root. The UI retained the note, physical bytes
and full history still matched, and the tree was clean. Bundle paths identify
the tested binaries despite other installed apps sharing the application ID.

## Checks and post-implementation review

Codex ran these checks, all successful:

- Definition: 164 tests and package typecheck.
- Folder publication: 10 focused tests; folder package typecheck.
- Honeycrisp: 327 application tests and 19 DOM tests.
- OPFS build and two native bundle builds.
- Biome check: formatting corrected; three existing non-null-assertion warnings.
- Actual OPFS run/reload and browser/native create-edit-reopen journeys above.

Post-edit review read the changed export, test, and OPFS page against preparation,
the publication helper, three adapters, and Honeycrisp's definition/callers.
The array copy retains one descriptor boundary and the cache-copy mapping.
The evidence opener now owns registration once; every history-enabled caller
opts in explicitly. No new public API, importer, migration, or commit policy.

Source fingerprints and raw native bytes/history/check logs are beside this file.
Full temporary build logs and baseline patches remain in
`/tmp/definition-iteration-20261008/`. Source fingerprints include the unrelated
live layout used in browser acceptance, which displayed its temporary input
acceptance button; that layout was not changed or committed by this task.

## Remaining decision

Todos Local-scope download-before-open remains unresolved. The account-only
download API cannot directly repair its first remote pull. A question asks whether
first use should require a download or offer Download/Start empty. No incoming
Git protection was relaxed. ADR 0508 remains Proposed and the spec remains
In Progress pending that decision and repair.
