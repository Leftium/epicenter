# 0489. Account identity selects local folders and cloud transfers are explicit

- **Status:** Proposed
- **Date:** 2026-10-02
- **Implemented:** automatic commits stay local in the TypeScript history and shared Rust owner; TypeScript openers keep local `main` independent of the remote branch and refuse an unexpected browser `HEAD`; Whispering startup uses settings defaults without creating `kv.json`; the Local CLI acquires the native sibling ownership lock.
- **Unbuilt:** account-folder startup, origin-based account opening, staged first downloads, captured-account transport credentials, and browser history reconciliation.

## Context

Whispering currently opens a Local folder at `~/Epicenter/local/so.epicenter.whispering`, or the directory `WHISPERING_DATA_ROOT` names. It has no account startup. The folder engine initializes Git if absent. Settings defaults stay in memory until an explicit settings save, so launching Whispering alone creates no source file or commit.

An earlier `commitOnEdit` policy pushed after automatic commits. The revised engine records local history without implicit network work ([ADR-0468](0468-file-saves-succeed-independently-of-automatic-commits.md)). Native `RootLock` excludes a second owning process, but the Bun opener does not acquire it. Browser database and Web Lock names currently use the caller's folder ID; account-qualified names remain unbuilt.

## Decision

**Folder content transfers are explicit.** Sign-in and listing may retrieve metadata; neither downloads nor uploads folder content. Automatic local commits may remain enabled, but a configured remote never enables automatic pushing. No device enrollment, attachment registry, background retry service, or second synchronization baseline is introduced.

**Account locations follow ADR-0461.**

```text
~/Epicenter/local/<folderId>/
~/Epicenter/accounts/<account-key>/<folderId>/
```

The account key derives from the exact authority and principal. Independent native applications and the CLI compute the same path from their own sessions. Tokens stay in private session storage, with native credentials in the operating system's credential store. Account identity selects local storage; an origin is optional. Selecting an account folder may create it offline from the cached identity and start saving immediately. This does not establish whether that folder already exists in the cloud. With no current listing, report an unlinked folder and unknown cloud presence.

Browser account folders follow the same logical scope using account-qualified database, Web Lock, and notification names. Each browser origin has separate physical storage; it cannot open the laptop's home directory. A browser app owns its private session and must use a captured-account Git HTTP transport. Account startup, credentials, persisted-origin handling, and stable local `main` selection remain unbuilt on these paths.

A moved Epicenter root is selected explicitly in each app or with CLI `--root`. No shared daemon, location registry, or root discovery file is required. Arbitrary clones outside the managed layout remain explicit paths, not automatically registered account folders.

**Origin is the only repository destination metadata.** A normal clone stores the immutable URL of [ADR-0488](0488-cloud-folders-use-independent-git-histories.md) in `remote.origin.url`. Account credentials come from the session, never from that URL. Discovery compares the configured origin with the account listing and reports differences. It never changes origin, adopts an unrelated directory, or treats matching names and URLs as permission to publish. Explicit raw Git remote changes remain deliberate user operations.

Native account-folder openers read the configured origin; they never replace it with the listing's current URL. Rust offers opt-in `use_repository_origin`; Whispering leaves it off. The Bun opener currently accepts a caller-supplied remote instead. The browser backend currently writes a supplied origin at opening. Both TypeScript openers keep local `main` independent of the transfer destination branch. An existing browser repository with `HEAD` on another branch refuses commits and incoming adoption; opening never silently creates a replacement history. Account setup must preserve configured origin; that wiring remains unbuilt. Remotes are captured at opening. The native registry retains owners and their locks after page detachment and releases them only at shutdown. Changing the selected account, root, or captured remote uses the guarded close handshake, process exit, and whole-shell relaunch. A page reload does not replace the owner. Bun and browser handles can instead close and reopen. Use Git commands to edit Git configuration, never hand-edit its files while the owner is active.

**Download is an explicit alternative to creating local data.** A person restoring an existing cloud folder can get it before editing; applications do not require this before account-local opening.

1. Resolve the folder's repository URL through the authenticated listing. If the cloud is unavailable, report unknown and create nothing.
2. Refuse an existing destination. Report its presence and origin without overwriting or retargeting it.
3. Fetch the repository into a dot-prefixed staging directory on the same filesystem and establish local `HEAD` on `main` explicitly. A repository with no `main` is permitted only as an empty repository; initialize local `main` and set origin without manufacturing a commit. Do not use `clone --branch main` for an unborn branch or rely on the client's default branch. Require completed checkout without unrequested content conversions and the native folder layout check; do not load executable folder configuration or require an application schema to download it.
4. Install only if the destination remains absent, holding the cooperative reservation lock and using no-clobber publication. Never merge staging contents into an existing folder.
5. On failure, report retained staging work separately; leave no partial destination that looks ready.

For get, the folder opener runs after installation. Explicit cloud creation instead allocates an empty repository and reports its URL; it need not download or replace an existing account-local folder. Origin can then be configured through explicit Git operations. Discovery never attaches it automatically.

Reserve a setup destination with the existing sibling `RootLock`: create and canonicalize the account parent, validate the folder ID, and lock the child path before staging and installation. Lock acquisition does not require the child directory to exist. No-clobber installation still protects against external filesystem writers; ordinary rename is not assumed to provide it on every platform. Listing ignores dot-prefixed staging and non-folder-ID names.

**An existing account folder connects in place.** A person who recorded before cloud setup keeps the same directory, `.git`, local history, and private device settings. Discover the canonical cloud repository URL, explicitly configure origin, then fetch. Connecting changes the destination; it does not download a replacement working directory or reconcile histories. No separate connect state or content-import workflow is stored.

The destination's actual state determines the next operation:

| Local destination | Explicit incoming operation |
| --- | --- |
| Absent | Staged get and no-clobber installation. |
| Exists, with no commits or source files | Configure origin, fetch, then guarded adoption into the existing folder. |
| Exists, with local files or history | Preserve outstanding files and use Git to reconcile in place. |

The engine initializes Git at opening and attempts automatic local commits after saves. An attempt can be skipped or fail, so saved files are not necessarily committed. Inspect outstanding changes before reconciliation. Stage authored files deliberately: ordinary Git staging does not inherit the engine's exclusions for generated `index.sqlite3` and operating-system scratch files.

On native systems, a person or coding agent reconciles with explicit Git while the shell is fully closed, using the cooperative folder lock. Fetch records incoming history before any working-file adoption. Choose the merge policy from the observed ancestry; independently started histories require explicit permission to join unrelated histories. A nonempty cloud repository does not become an empty one because the local directory was created offline. An empty cloud repository has no incoming head to merge. Push remains a separate explicit action.

Git preserves committed history, not every saved working file. An unrelated-history merge can conflict in `kv.json`, and a successful merge can replace ignored local files. A Git 2.50.1 probe reproduced ignored-file replacement both with and without `--no-overwrite-ignore`. That flag does not establish the engine's collision-refusal guarantee. A future managed reconciliation action must check incoming paths against local ignored and untracked files before adoption, including file/directory collisions, and provide a supported conflict path. It must not force ignored content into history or upload it automatically. The initial app controls retain clean fast-forward adoption; they do not add a generic merge action.

After native reconciliation, inspect the resolved files and their audio references before reopening and requesting publication. Git's successful text merge does not establish application validity. Standalone app controls can use the shared engine to save, commit, fetch, push, and fast-forward; resolving divergent or unrelated histories inside the app remains separate work. Native Git reconciliation currently requires a Git tool outside that app. Browser reconciliation remains an implementation gate.

**The CLI cooperates with native folder ownership.** Every `epicenter git` invocation acquires `RootLock`, including reads. This prevents a wrapped checkout or merge from racing the app's file publication and automatic commits without requiring a Git mutation classifier. It refuses while an application owns the folder; the person can close that app or use its controls. The lock lasts until Git exits, including time in pagers, editors, and hooks, so an app opened during that interval also reports Busy. Setup uses the same sibling lock. No daemon brokers a live app's ownership. Raw Git takes its own locks and remains outside this coordination promise.

**Keep Git behavior distinct from application behavior.** The current engine's built-in incoming adoption remains a clean fast-forward ([ADR-0474](0474-incoming-file-folder-sync-is-an-explicit-clean-fast-forward.md)). The CLI's Git passthrough may explicitly merge, rebase, or restore with ordinary Git semantics. It makes no automatic conflict-resolution or cross-file schema-validity promise. Wrapped operations coordinate with the app owner; arbitrary raw Git commands do not.

The existing controls are `folder.git.commit()`, `push()`, `commitAndPush()`, `fetch()`, and `pullFastForward()`. Fetch observes incoming history; fast-forward applies that observation without fetching again. No generic `pull()` or `sync()` is added. Apps choose when to call them and present their separate outcomes. A configured destination does not reconcile histories. Dirty files, divergent commits, and unrelated roots can all prevent incoming adoption. Native reconciliation uses explicit Git with the app closed; browser reconciliation needs a supported merge or export path before multi-device account editing can ship. Calling isomorphic-git's merge directly against the guarded browser worktree is not that implementation.

**Local stays Local.** Account discovery never uploads or relocates a Local folder. A person may explicitly copy selected current files into a new account folder, preserving the Local original and excluding its history and private credentials. No dedicated publish orchestration is required by this decision.

## Implementation gates

Keep account startup and hosted transfers conditional on end-to-end evidence. First preserve local history when attaching an explicit destination, then exercise push, fetch, and fast-forward against an ordinary Git server. Hosted repository allocation, listing, credentials, deletion fencing, and audio history costs still need implementation and measurement. A browser also needs a supported way to reconcile divergent or unrelated histories before multi-device editing ships. Do not add an unused account-address helper or transport option ahead of those consumers.

Before shipping account opening, prove that configuring origin enables explicit app transfers after the supported reopen. Whispering currently leaves `use_repository_origin` off, so relaunch alone is insufficient. A transfer captures the selected account and trusted destination before releasing credentials. Exercise existing directories with unborn history and partial incoming adoption; a failed setup must not be presented as complete or silently committed as a new local root.

Whispering stores its transcription key and microphone preference under `.git`. Git transfers exclude them, but a recursive directory copy carries them. Moving that file outside the portable directory requires a migration and concurrency owner: two shells using different roots can run together, so a shared JSON file with an in-process queue and fixed `.next` filename is insufficient. Keep this as a prerequisite for claiming portable folders exclude credentials.

The real Git regression also exposes an isomorphic-git 1.38.5 limitation: after the first push to a non-default branch, an explicit fetch fails if the server advertises no resolvable `HEAD`. Local history remains intact. The cloud contract uses `main`; do not claim support for this alternate-branch bootstrap state or rewrite the server default branch to hide the failure.

## Consequences

- An unpushed commit stays on its device. Matching origin is setup information, not a claim that data is backed up or synchronized.
- An offline-created folder whose name already exists in the cloud can have independent history. Get refuses its existing directory. Linking requires explicit origin configuration followed by history reconciliation. Setup and fetch leave working files in place; explicit Git reconciliation retains ordinary Git risks for uncommitted and ignored files.
- Missing settings use current app or environment defaults until saved. A later launch can show different defaults without changing a file. Lazy defaults remove artificial first-launch roots, not histories created by real edits.
- Directory scans and Git configuration replace local installation and attachment databases. Git refs replace custom transfer baselines.
- A stale origin remains usable for local work but cannot address a recreated cloud repository. Offline, current cloud existence and origin agreement are unknown.
- Copying or restoring a folder is ordinary file handling. Restoring old bytes over a live working copy can look like edits; no identity mechanism detects every restore.
- Standalone apps need no Epicenter CLI or desktop service. They share transport and setup code while owning their own sessions and user controls.
- Several apps may use one dataset sequentially; the native owner lock gives a concurrent opener Busy. Account switching settles or explicitly discards the old runtime's unsaved work before opening another scope.
- Locking every passthrough invocation means wrapped `status` and `log` also refuse while an app owns the folder. Raw Git remains available with its own concurrency guarantees.
- After same-name recreation, move the old directory aside before get downloads the replacement. Existing bytes are retained; a deliberate history import remains a Git task.

## Considered alternatives

- **Automatic upload and a private enrollment registry.** They reduce forgotten pushes but add admission, restored-copy, cancellation, and retry policy. Explicit transfers remove that family of work.
- **Require download before every first account opening.** It avoids an independent initial history on a pristine device but makes cloud availability a local editing prerequisite. Local editing takes priority; explicit reconciliation owns the cost.
- **Store account, folder, and Git root bindings beside origin.** They duplicate the path, session, listing, and immutable destination without adding authority.
- **Lock only mutating Git commands.** It permits wrapped reads while an app is open, but requires classifying commands, aliases, flags, and hooks. Locking every invocation is the smaller contract.
- **A shared root preference or access daemon.** A preference avoids repeated selection after moving the root; a daemon could broker live access. Neither is needed for the default derived paths.

- **Clone cloud history elsewhere and import existing account files.** It adds content-copy, directory replacement, and recovery policy while discarding or separately reconstructing local history. Existing account folders reconcile through Git in place; staged cloning remains for absent destinations.
