# Coalesced automatic history acceptance

This app exercises the production browser opener and row editor with disposable
OPFS data. The textarea publishes through `folder.tables.notes.edit().setText`.
The saved-file panel reads `folder.files`; the committed-file panel reads the
blob in the branch's actual commit tree. Inspecting requests no checkpoint.

Start the app from the repository root:

```sh
bun packages/folder/evidence/coalesced-history/serve.ts
```

Open [the acceptance editor](http://127.0.0.1:5197/). Its folder is
`Epicenter Dev/local/so.epicenter.evidence.coalesced-history` in this origin's
OPFS. Other application origins and folders are untouched. Reload reopens the
same disposable data.

## Gates

**Hold Git protection** acquires the production folder's actual Web Lock.
**Release Git protection** releases that lock. Another tab of this evidence
origin can hold it while the editor saves.

**Hold next branch publication** gates the actual OPFS branch-ref stream's
`close()`, after the candidate tree and commit objects exist. Saves remain
available while this checkpoint holds Git protection. **Release branch
publication** lets it finish.

**Fail next Git admission** makes the lock adapter reject one Git acquisition.
This is a controlled adapter failure before checkpoint admission. Files and
Git objects still use real OPFS; this does not simulate quota exhaustion or an
uncertain stream close.

## Task baseline: October 5, 2026

The source baseline is `cc4d6f770e` plus the existing working changes. The
coordinator captured HEAD, the working and staged patches, untracked paths,
and the transferred worker inputs under
`/tmp/epicenter-coalesced-20261005/`. The worker has a standalone clone and an
alternate baseline tree that includes transferred dirty tests. Unrelated edits
and staged work remain in the live checkout.

Codex reproduced these baseline checks:

| Check | Result |
| --- | --- |
| History-attempt and history-ordering suites | 35 passed, 0 failed |
| All TypeScript Git suites with `bun test --isolate` | 88 passed, 0 failed |
| Folder typecheck | 0 errors, 0 warnings |
| Native core tests | 102 passed, 0 failed |
| Full folder package test script | 745 core passed, 18 skipped; 14 Svelte passed; 0 failed |
| Native plugin tests | 20 passed, 1 ignored; 0 failed |

The baseline UI reproduced both dropped-request cases:

1. Hold Git protection, change the row source, inspect, release protection,
   and inspect again. The saved file contains the edit. The committed file
   remains the initial text, without another edit or explicit checkpoint.
2. Hold the next branch publication, save A, wait for the visible held state,
   save B, release publication, and inspect. The saved file contains B while
   the branch's commit contains A.

The screenshots retain the observed difference:

- [Busy-protection baseline](baseline-busy.jpg)
- [Save-during-commit baseline](baseline-during-commit.jpg)

## Design review decisions

Independent Codex and Claude reviewers traced browser/Bun publication and the
native owner before implementation. Both supported owner-level coalescing and
existing Git protection, with no editor text copies, timer, persistent queue,
or synchronization dependency.

The pending request is consumed when a whole-folder checkpoint starts under
protection, including an explicit checkpoint that fails. A save that completes
after that boundary remains eligible. Failure to acquire protection also needs
an explicit retirement rule; otherwise a still-pending request can retry forever.
Request generations distinguish a failed waiter from newer saves.

Native publication must authorize history while holding the file gate. A delayed
notification after releasing that gate can request another attempt after an
explicit checkpoint already captured the save. Worker retirement and request
insertion must share one scheduling critical section. In JavaScript the worker
must be registered before activity observers can reenter or close the handle.

A skipped automatic callback must recheck pending work after its await. A save
can arrive between the skip and continuation; exiting from the earlier skip
alone would strand that save.

The review also raised background-tab freezing. Chromium's
[freezing policy](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/performance_manager/freezing/freezing_policy.cc)
registers a held Web Lock as a reason not to freeze a page. This source check
is not a forced-freeze UI test or a guarantee across browser engines.

## Integrated acceptance

Codex repeated the gates against integrated production code:

- A character burst under held Git protection finished saving while history
  stayed active. Releasing protection created one content commit containing
  the final text, without another edit: [burst](integrated-burst.jpg).
- A checkpoint was held after capture A, then save B completed. Releasing
  publication produced the A commit followed by a checkpoint containing B:
  [save during commit](integrated-during-commit.jpg).
- One rejected Git admission reported `failed`, retained the saved file, and
  stayed idle on repeated inspection. A newer save committed successfully:
  [failure](integrated-failure.jpg).
- A second tab held the production Web Lock. An automatic request and an
  explicit checkpoint overlapped behind it. Release created one content
  commit; the explicit checkpoint returned `unchanged`, with no empty commit:
  [cross-tab overlap](integrated-cross-tab.jpg).
- Closing while a second tab held protection cancelled the waiting request.
  After release, the saved file was newer than the unchanged branch. Reopening
  preserved both states and requested no final or startup commit:
  [close](integrated-close.jpg).

The scheduler commit is `3eb15a01bc`. Its combined implementation passed 39
targeted history tests, folder
typechecking, 105 native core tests, 19 plugin tests (one ignored), and 18
desktop bridge tests. The first full folder run had one five-second timeout
in incoming attributes while native checks ran concurrently. Its focused
rerun passed all eight tests; the full rerun passed 757 core tests with 18
skipped, then 14 Svelte tests. This timeout is not attributed to the baseline.

A desktop bridge run during another task's protocol6-to-7 integration was
not a valid baseline comparison. The stable integrated protocol7 run passed.
Browser freeze/resume and a native graphical editor were not exercised here;
Rust and the real desktop command bridge cover the distinct native owner.

## Actual Honeycrisp baseline

Codex started the existing application from the repository root with
`bun dev:honeycrisp:ui --port 5198`. The origin `http://localhost:5198` has
its own disposable OPFS data. No application source was changed to install
instrumentation.

The same-origin helper at
`/@fs/Users/braden/Code/worktrees/epicenter/app-schema-derive-export-import/packages/folder/evidence/coalesced-history/honeycrisp-gate.html`
holds Honeycrisp's production Git Web Lock and reads saved notes and their
committed blobs. It does not open another folder owner or request commits.

Codex created one note through **New note**, selected **Source**, and typed
`Honeycrisp baseline while Git is held.` while the helper held protection.
After typing stopped and protection was released, Honeycrisp showed
**1 saved file is not committed**. The helper found that text in the saved
note; the committed blob still had an empty body. A second inspection after
the save completed confirmed the difference.

The actual-app screenshots are [Honeycrisp](honeycrisp-baseline.jpg) and
[the saved and committed blobs](honeycrisp-baseline-history.jpg).

## Actual Honeycrisp after integration

On the same disposable origin, Codex selected the baseline note, opened
**Source**, held the actual Git Web Lock through the helper, and typed
`Honeycrisp final text while Git is held.`. Before release, the app showed
**Saved to notes/01f2eb7816.md** and **Committing…**. The helper found the final
text in the saved file while HEAD still contained the baseline empty body.
After typing stopped, Codex released the lock without another edit or an
explicit checkpoint. The app changed to **Saved and committed**. The helper
read the final text from the actual committed blob, at
`4b54104b1a1c4dfe4e2a8e4978d0369b9cd4268f`. Reloading the app retained that
saved file and commit.

Screenshots: [Honeycrisp](honeycrisp-integrated.jpg) and
[the saved and committed blobs](honeycrisp-integrated-history.jpg).

## Cross-task ownership

The editor task owns the serial write and newest waiting document. This task
owns the folder's coalesced commit request. The Git testbed task owns explicit
transfer commands and durable unfinished merge state. An additional history
validation task contributes a separate failing-capture regression and dead
lock-option cleanup; its changes are kept in a follow-up commit.

The final targeted rerun, including the coordinated failing-capture regression,
passed 40 history tests. Folder typechecking again reported zero errors and
zero warnings.
