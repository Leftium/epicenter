# 0489. Cloud folder transfers are explicit and bootstrap before opening

- **Status:** Proposed
- **Date:** 2026-10-02
- **Unbuilt:** native account-folder bootstrap, separate automatic local commits and outgoing pushes, origin-based account-folder opening, staged first downloads, native CLI lock cooperation, and account transport credentials.

## Context

Whispering currently opens a Local folder at `~/Epicenter/local/so.epicenter.whispering`, or the directory `WHISPERING_DATA_ROOT` names. It has no account bootstrap. The Bun opener initializes Git if it is absent, and Whispering creates `kv.json` on first start. Opening a missing account folder before discovery could therefore manufacture a history unrelated to its cloud repository.

The current `commitOnEdit` policy also attempts a push when a remote is configured ([ADR-0468](0468-file-saves-succeed-independently-of-automatic-commits.md)). Merely supplying an account remote would enable uploads on save. Native `RootLock` excludes a second owning process, but the Bun opener does not acquire it. Browser database and Web Lock names currently use the folder ID alone.

## Decision

**Folder content transfers are explicit.** Sign-in and listing may retrieve metadata; neither downloads nor uploads folder content. Automatic local commits may remain enabled, but a configured remote does not enable automatic pushing. Separate those behaviors before exposing account remotes. No device enrollment, attachment registry, background retry service, or second synchronization baseline is introduced.

**Account locations follow ADR-0461.**

```text
~/Epicenter/local/<folderId>/
~/Epicenter/accounts/<account-key>/<folderId>/
```

The account key derives from the exact authority and principal. Independent native applications and the CLI compute the same path from their own sessions. Tokens stay in private session storage, with native credentials in the operating system's credential store. A cached identity permits existing folders to open offline; it does not establish what currently exists in the cloud. Browser folders stay Local in this slice; enabling account storage requires a separate decision and account-qualified database and lock names.

A moved Epicenter root is selected explicitly in each app or with CLI `--root`. No shared daemon, location registry, or root discovery file is required. Arbitrary clones outside the managed layout remain explicit paths, not automatically registered account folders.

**Origin is the only repository destination metadata.** A normal clone stores the immutable URL of [ADR-0488](0488-cloud-folders-use-independent-git-histories.md) in `remote.origin.url`. Account credentials come from the session, never from that URL. Discovery compares the configured origin with the account listing and reports differences. It never changes origin, adopts an unrelated directory, or treats matching names and URLs as permission to publish. Explicit raw Git remote changes remain deliberate user operations.

Native account-folder openers read the configured origin; they never replace it with the listing's current URL. Rust offers opt-in `use_repository_origin`; the Bun opener currently accepts a caller-supplied remote instead. Wiring both account paths to origin is unbuilt. The cloud listing chooses a destination for initial setup, not a replacement remote for an existing clone.

**Download precedes opening a missing account folder.**

1. Resolve the folder's repository URL through the authenticated listing. If the cloud is unavailable, report unknown and create nothing.
2. Refuse an existing destination. Report its presence and origin without overwriting or retargeting it.
3. Clone `main` into a dot-prefixed staging directory on the same filesystem. Refuse a missing initial `main`. Require completed checkout without unrequested content conversions and the native folder layout check; do not load executable folder configuration or require an application schema to download it.
4. Install only if the destination remains absent, holding the cooperative reservation lock and using no-clobber publication. Never merge staging contents into an existing folder.
5. On failure, report retained staging work separately; leave no partial destination that looks ready.

The folder opener runs only after setup. Explicit creation publishes the shared initial commit and uses the same download path; a later download failure does not undo successful cloud creation. During an explicit online create or download, create the account parent if absent. Reserve the destination with the existing sibling `RootLock`: canonicalize that parent, validate the folder ID, and lock the child path before staging and installation. Lock acquisition does not require the child directory to exist. No-clobber installation still protects against external filesystem writers; ordinary rename is not assumed to provide it on every platform. Listing ignores dot-prefixed staging and non-folder-ID names.

**The CLI cooperates with native folder ownership.** Every `epicenter git` invocation acquires `RootLock`, including reads. This prevents a wrapped checkout or merge from racing the app's file publication and automatic commits without requiring a Git mutation classifier. It refuses while an application owns the folder; the person can close that app or use its controls. The lock lasts until Git exits, including time in pagers, editors, and hooks, so an app opened during that interval also reports Busy. Setup uses the same sibling lock. No daemon brokers a live app's ownership. Raw Git takes its own locks and remains outside this coordination promise.

**Keep Git behavior distinct from application behavior.** The current engine's built-in incoming adoption remains a clean fast-forward ([ADR-0474](0474-incoming-file-folder-sync-is-an-explicit-clean-fast-forward.md)). The CLI's Git passthrough may explicitly merge, rebase, or restore with ordinary Git semantics. It makes no automatic conflict-resolution or cross-file schema-validity promise. Wrapped operations coordinate with the app owner; arbitrary raw Git commands do not.

**Local stays Local.** Account discovery never uploads or relocates a Local folder. A person may explicitly copy selected current files into a new account folder, preserving the Local original and excluding its history and private credentials. No dedicated publish orchestration is required by this decision.

## Consequences

- An unpushed commit stays on its device. Matching origin is setup information, not a claim that data is backed up or synchronized.
- Directory scans and Git configuration replace local installation and attachment databases. Git refs replace custom transfer baselines.
- A stale origin remains usable for local work but cannot address a recreated cloud repository. Offline, current cloud existence and origin agreement are unknown.
- Copying or restoring a folder is ordinary file handling. Restoring old bytes over a live working copy can look like edits; no identity mechanism detects every restore.
- Standalone apps need no Epicenter CLI or desktop service. They share transport and setup code while owning their own sessions and user controls.
- Locking every passthrough invocation means wrapped `status` and `log` also refuse while an app owns the folder. Raw Git remains available with its own concurrency guarantees.
- After same-name recreation, move the old directory aside before get downloads the replacement. Existing bytes are retained; a deliberate history import remains a Git task.

## Considered alternatives

- **Automatic upload and a private enrollment registry.** They reduce forgotten pushes but add admission, restored-copy, cancellation, and retry policy. Explicit transfers remove that family of work.
- **Open first and discover later.** It risks creating an unrelated account history before discovering an existing cloud folder.
- **Store account, folder, and Git root bindings beside origin.** They duplicate the path, session, listing, and immutable destination without adding authority.
- **Lock only mutating Git commands.** It permits wrapped reads while an app is open, but requires classifying commands, aliases, flags, and hooks. Locking every invocation is the smaller contract.
- **A shared root preference or access daemon.** A preference avoids repeated selection after moving the root; a daemon could broker live access. Neither is needed for the default derived paths.
