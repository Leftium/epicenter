# 0496. Native app runtime storage is independent of the shell

- **Status:** Proposed
- **Date:** 2026-10-03
- **Amends:** [ADR-0436](0436-stores-own-local-sqlite-namespaces.md), only its preserved physical namespace encoding and shell-specific storage root. Store-owned acquisition remains the implemented API.
- **Relates:** [ADR-0459](0459-sqlite-is-a-local-capability-for-derived-or-transactional-state.md) defines SQL retention; [ADR-0461](0461-portable-data-folders-live-under-local-and-derived-account-scopes.md) defines authored folder scopes.
- **Unbuilt:** shared native root resolution, cross-process runtime admission, shared provider credentials, migration, and a standalone native Local Mail shell. Current host SQL remains under its bundle-specific AppData root.

## Context

Standalone and hosted installations of the same native application should see
the same downloaded data and pending work. Today the host resolves
`app_local_data_dir()` from its shell bundle identifier, then stores SQL under
`apps/<app-id>/device/<owner>/sqlite/<name>.sqlite`. Another shell gets another
root. Current lifetime reservations do not exclude owners in another process.

Authored folders have a different lifetime. Selecting, moving, or copying
`~/Epicenter` must not select another Mail outbox. Putting executable pending
work in that tree would let two copies acquire different locks and deliver
stale assertions independently.

## Decision

**All participating native shells resolve one fixed local-data root per OS user and release channel.**
A shared Rust implementation resolves the OS local-data directory and appends
`so.epicenter` for release or `so.epicenter.dev` for development. It does not
append the running shell's bundle ID. Standalone applications can resolve the
root without installing or running the Epicenter host.

| Platform | Release root | Development root |
| --- | --- | --- |
| macOS | `~/Library/Application Support/so.epicenter` | `~/Library/Application Support/so.epicenter.dev` |
| Windows | `%LOCALAPPDATA%\so.epicenter` | `%LOCALAPPDATA%\so.epicenter.dev` |
| Linux | `$XDG_DATA_HOME/so.epicenter` | `$XDG_DATA_HOME/so.epicenter.dev` |

On Linux, an unset local-data base defaults to `~/.local/share`. Default authored
roots are exactly `~/Epicenter` for release and `~/Epicenter Dev` for development,
including capitalization and the space. These names match ADR-0497's OPFS roots.

These bases follow [Tauri's local-data resolver](https://docs.rs/tauri/latest/tauri/path/struct.PathResolver.html#method.local_data_dir).
Use the persistent local-data directory, not the cache directory or the OS
temporary runtime directory. Development cannot open production state through
an ordinary launch or authored-folder override. Tests use isolated roots.

**The root contains `<app-id>/<account-owner>/` directly.** No `runtime/`,
`apps/`, `device/`, or `sqlite/` prefix is needed for this application namespace.
App IDs use the existing lowercase reverse-DNS grammar. Other host resources
do not become application directories merely by moving this namespace.

The account owner is `local` for account-independent work, or the bounded
SHA-256 account key defined by ADR-0461. That key includes authority and
principal. Google subjects select mailbox names inside the captured Epicenter
account; they do not replace its owner.

```text
OS local-data directory/
  so.epicenter/
    so.epicenter.local-mail/
      <account-key>/
        local.sqlite3                 retained accounts and pending edits
        mail-<google-sub>.sqlite3      downloaded mailbox
  so.epicenter.dev/
    so.epicenter.local-mail/...

~/Epicenter/
  local/<folder-id>/...
  accounts/<account-key>/<folder-id>/...
```

New application databases use `.sqlite3`. This layout does not relocate or
rename existing databases automatically. Root selection, owner encoding, and
file suffix changes require explicit migration that preserves committed work.
Migration must exclude active owners of the old namespace as well as the new
one. A new lease key alone cannot fence an older build. Require a quiesced
cutover or a verified admission bridge before moving retained databases; preserve
uncheckpointed work through SQLite-aware migration rather than renaming only the
main file.

**One active runtime owns an app/account namespace across native processes.**
The native shell acquires an OS-held exclusive lease before exposing SQL or
starting provider delivery. A second acquisition refuses with the owning app
identified. The lease covers connections, reset, deletion, and provider work;
it remains held until admitted operations settle and connections close. A
sidecar restart cannot release it while the native shell still owns the
runtime. A crashed process releases the OS lock. Hiding a window is not proof
that its runtime closed.

Standalone and hosted Mail can use the same bytes sequentially. Simultaneous
independent executors are outside this decision; there is no broker or daemon.
A lease prevents competing local drainers, not at-least-once delivery after a
crash between provider success and local retirement. Mail retains idempotent
assertions and revision-checked retirement. Clearing a mailbox preserves
`local.sqlite3`; account removal refuses while work is owed.

**Provider credentials follow logical app/account identity, not the shell bundle ID.**
Use a shared credential service per release channel and app/account/label
addressing. Epicenter authentication sessions remain shell-owned. Credentials
stay in the OS credential facility, outside both roots. Cross-shell keychain
access must be verified for the supported signing and distribution setup;
matching service strings alone does not establish access.

**An authored-folder move never changes the runtime root.** Runtime backup and
restore are separate operations. Copying a database does not authorize another
executor. Raw restore of old pending work has no safe automatic activation
contract here. Sandboxed distributions must establish shared storage and
credential access rather than silently create a second private namespace.

## Consequences

Shell-independent discovery removes duplicate native mailbox downloads and
outboxes. One exclusive owner avoids executor election, cross-process cache
invalidation, and broker discovery. The cost is automatic refusal of a second
active native runtime, plus explicit closure before switching shells.

Shared storage makes version skew visible. A build refuses newer retained
schemas; downloaded-mail caches must also refuse newer schemas instead of
alternating destructive rebuilds between old and new installations.

Browser runtimes keep the same logical app/account ownership but remain private
to their origin and browser profile. They do not share native bytes.

## Considered alternatives

- Runtime under `~/Epicenter`: folder selection or copying can fork executable
  work. Preventing that requires a separate activation and root-selection owner.
- Bundle-specific AppData: retains duplicate outboxes and downloads when a
  person switches shells.
- `runtime/apps/<app>/<owner>`: repeats the role already established by the
  private root without a consumer needing those categories.
- Concurrent runtimes sharing SQLite: SQL locking protects transactions, not
  ordering of competing provider calls.
- Shared native daemon: enables simultaneous clients but adds service discovery,
  deployment, and lifecycle work before that behavior is required.
