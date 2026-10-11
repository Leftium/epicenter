# Publish a portable definition when a folder opens

**Date**: 2026-10-07
**Status**: In Progress
**Owner**: Codex coordinates implementation, integration, and acceptance with Braden.

## One sentence

Each folder opener attempts to save its application's portable schema to root `definition.json` before returning a usable folder.

## Current shape and target

Browser, Bun, and Tauri openers prepare the caller's definition and assemble a
folder handle. At the task-start baseline they published no discovery file. Ordinary files already
have a create-or-replace operation, `folder.files.overwrite(path, content)`,
whose successful saves participate in existing automatic history.

The target adds one best-effort publication after assembly and before return:

```text
prepare declaration -> acquire storage -> assemble folder
  -> export portable definition
  -> await files.overwrite('definition.json', text)
  -> handle publication result -> return folder

successful save -> existing background history policy -> local checkpoint
```

Opening waits for publication, not the checkpoint. It neither reads the file
to configure the application nor pushes anything. The agreed decision is
[ADR 0508](../docs/adr/0508-folder-opening-overwrites-root-definition-json.md),
currently Proposed; runtime and UI acceptance are verified below, with Todos bootstrap unresolved.

Completion means all openers attempt publication, regressions demonstrate the
failure and history behavior, and actual browser and native application journeys
pass against the integrated source. Source tests alone do not complete UI
acceptance.

## Execution evidence

Portable export and publication are implemented. Definition, folder, native
bridge, and Honeycrisp verification results and review decisions are recorded in
[the acceptance evidence](../packages/folder/evidence/definition-publication/README.md).
The OPFS evidence page now covers publication, replacement, changed declarations,
separate automatic history, and persistence before reopening after a reload.

Real OPFS run/reload and Honeycrisp browser/native note creation, editing, and
reopening passed through computer use on 2026-10-08 with disposable data. Saved
definitions and settled Git history were inspected alongside the UI; see
[the current evidence](../packages/folder/evidence/definition-publication/computer-use-20261008/README.md).
Adversarial review also reproduced a remote-bootstrap
regression in the current Todos browser startup: publication precedes its first
pull. A separate bootstrap decision remains open; incoming Git protection has
not been relaxed. Retire this spec after that consequential
integration finding is resolved; ADR 0508 remains Proposed.

## First implementation wave

Capture the implementation baseline before editing. This planning pass inspected
HEAD `37323cf783f01f66e62a54976d2019b0ee7cb1f3`; the live checkout has substantial
uncommitted work, including folder tests and definition code. Preserve those
changes. If delegating, use a separate clone containing the relevant current
source and record exactly what was supplied, following `delegate-claude`.

Implement portable export at the definition owner, then share the publication
behavior among the actual openers. Inspect these launch points and their callers:

- `packages/definition/src/prepare.ts`: owned prepared schema and existing
  traversal of runtime callbacks. Reuse the relevant invariant where possible;
  verify installed TypeBox behavior before relying on serialization.
- `packages/folder/src/bun.ts`, `browser-adapter.ts`, and `tauri-adapter.ts`:
  acquisition and assembled-handle return points.
- `packages/folder/src/files.ts` and `storage.ts`: accounted overwrite and
  successful-save history notification.
- `packages/folder/src/git/history.ts`: coalesced automatic checkpointing and
  unchanged-tree behavior.

Export `title` when present, `kv`, and `tables`, retaining portable validation
and editor hints. Use deterministic formatting and a trailing newline. Include
no identity, timestamp, or runtime resources. Runtime validation callbacks that
cannot be represented faithfully must prevent publication and produce a
diagnostic; JSON serialization must not quietly discard them.

Attempt unconditional overwrite through the folder's public files boundary.
Handle export and write failures through `wellcrafted/logger`, naming the
destination and retaining uncertain outcomes. Return an otherwise usable folder
without rollback or looping retries. Do not introduce a second commit policy.

## Checks that decide the wave

Use regression coverage for the observable contract:

| Journey                    | Evidence needed                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| Open fresh data            | Root file exists and describes the supplied schema before the handle returns.                 |
| Open existing data         | Old or malformed description is replaced; rows and settings survive.                          |
| Reopen unchanged data      | Publication occurs again; after settled history, an unchanged tree adds no commit.            |
| Change the declaration     | Next opening publishes the new description without migrating saved values.                    |
| Disable automatic history  | Publication succeeds without requesting a checkpoint.                                         |
| Fail export or publication | Opening remains usable, diagnostic identifies the failure, and export failure makes no write. |

Run focused definition/folder tests and affected typechecks. Check existing
fixtures that assert file listings or initial Git state: the generated root
file changes those expectations. Run native bridge checks against the real
native implementation, not a mocked browser result.

## Computer-use acceptance

Start with the existing real-OPFS evidence page,
`packages/folder/evidence/opfs/main.ts`. Extend its production-opener checks for
definition publication, keeping its disposable `opfs-evidence-*` datasets and
cleanup. Its usual opener disables automatic history, so add a deliberately
separate history-enabled case rather than silently changing every existing case.

Serve it from the repository root with
`bun packages/folder/evidence/opfs/serve.ts`. Through the computer-use tools, run
the page and its reload journey, inspect the resulting definition, and record
expected versus observed results. Retain the integrated source baseline with
the evidence. A compile check is not a completed browser journey.

Then exercise Honeycrisp's real application: create a note in disposable data,
edit it, reopen the application, and verify both the persisted note and the
generated description. Start browser development from the repository root with
`bun dev:honeycrisp:ui`, using an isolated browser origin for acceptance.
For native acceptance, use `HONEYCRISP_ROOT` pointing to a fresh temporary
directory and `bun dev:honeycrisp`. Identify the actual built app by path;
several installed bundles share the same application ID. Inspect the physical
file and settled Git history alongside the UI. A screenshot proves neither.

If computer-use access or a native build is unavailable, record the exact
unverified journey and continue independent checks. Do not substitute an older
installed binary or describe source tests as UI acceptance.

## Review and stop

After integration, apply `post-implementation-review` to publication ownership,
opening lifetime, and history behavior. Re-exercise the changed journey and
adjacent note editing. A second wave needs an observed failure or a concrete
review finding; the workflow does not require a fixed number of iterations.

Finish when the contract and application journeys pass and accepted findings
are resolved. Update package documentation and the ADR's unbuilt list to match
verified behavior. Keep ADR status changes under the ADR acceptance policy.
Retire this spec under the repository's spec lifecycle when its work lands.
