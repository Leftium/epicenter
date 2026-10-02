# 0488. Cloud folders use independent Git histories

- **Status:** Proposed
- **Date:** 2026-10-02
- **Unbuilt:** hosted folder Git repositories, their lifecycle and listing API, shared initial commits, portable folder-name admission, and native credentialed transport. Hosting, credentials, and audio history size remain feasibility gates.

## Context

A file-authoritative data folder already stores ordinary files with Git history beside them. The current engine fetches, pushes, and adopts clean fast-forwards against a loopback Git HTTP service in tests ([ADR-0474](0474-incoming-file-folder-sync-is-an-explicit-clean-fast-forward.md)). Epicenter Cloud instead synchronizes opaque Yjs update logs. It has no folder Git hosting or repository listing API.

A folder is a dataset, not an installed application. Several applications can open the same folder, and one application can open several folders. Local ownership locks, scans, and incoming adoption already operate on one directory. Account-wide Git would couple otherwise independent folders.

A folder name cannot also identify a reusable repository lifetime. In an isolated Git experiment, an old clone successfully pushed into an empty replacement repository at the old address. A specially seeded initial commit rejected that push, but permanently distinct repository addresses prevent the old clone from addressing the replacement at all.

## Decision

**Each account folder has one cloud Git repository.** Its committed `main` tree is the cloud counterpart of `accounts/<account-key>/<folderId>/` in [ADR-0461](0461-portable-data-folders-live-under-local-and-derived-account-scopes.md). This is a logical mirror; the host's physical object storage need not resemble the local directory tree. Local folders have no cloud repository.

**A folder ID names a dataset; its Git URL identifies a repository lifetime.** Folder IDs are unique within an account. A reverse-DNS name such as `so.epicenter.whispering` is the normal application default, not a globally unique repository identity. The same name can exist in Local and in several accounts. The host allocates an immutable opaque repository ID on explicit creation and embeds it in the Git URL:

```text
account A
  so.epicenter.notes       https://cloud.example/repos/abc123.git
  so.epicenter.whispering  https://cloud.example/repos/def456.git
```

Deleting a repository permanently retires its URL. Recreating `so.epicenter.notes` allocates a new repository ID and URL. An old URL never redirects to, resolves to, or creates a replacement repository. Push cannot create or revive a repository. Deletion fences pending writes so an operation started before retirement cannot make the repository live again. Storage removal and historical-byte retention are separate hosting policies.

Managed folder IDs use two or more dot-separated lowercase ASCII labels, each beginning and ending with a letter or digit and containing only letters, digits, and interior hyphens. The complete name is at most 128 bytes. Exclude platform-reserved directory names, including Windows device basenames before the first dot: `con`, `prn`, `aux`, `nul`, `com1` through `com9`, and `lpt1` through `lpt9`. Creation and native setup enforce the same rule; no escaping, case folding, aliases, or silent renaming are introduced. Existing arbitrary paths and browser IDs are not automatically migrated into this managed namespace.

The repository ID needs no tracked file, special identity commit, pinned ancestry root, or separate field in the client listing. Standard `remote.origin.url` records the destination. Matching URLs establish configuration agreement, not provenance, ancestry, or integrity.

**Creation publishes one ordinary empty-tree commit on `main` before listing the repository as live.** It supplies shared initial history for every download, not repository identity. It carries no required nonce, and clients neither pin it nor constrain all future commits against it. Nothing depends on initial commits being unique or identical across different repositories. Concurrent devices can then initialize application files as descendants of a common commit. Get refuses a repository without its initial `main` rather than installing an unborn clone. Importing unrelated existing history is a deliberate Git operation or a copy of current files, not an automatic first-push bootstrap.

**The host's repository records are the account's folder namespace.** An authenticated, paginated listing returns `{ folderId, gitUrl }` for each live repository. Create and delete update the same records; no second catalog mirrors them. Concurrent creation of the same account folder ID admits at most one live repository. A stale listing cannot authorize access: the Git endpoint checks the captured account's access to that repository on every request. Object-store prefix enumeration alone does not establish these lifecycle guarantees.

**Git owns history exchange.** Hosted `main` rejects non-fast-forward updates and branch deletion by default. This is a history protection policy, not repository identity. Other refs and privileged history removal require a separate hosting policy. The service must not accidentally expose arbitrary writable refs merely because the CLI forwards Git arguments.

Cloud content is the committed `main` tree. Saved but uncommitted files, ignored files, and files absent from the selected commit are not cloud data. A complete current-folder backup must include saved files and materialized media beyond committed history. A separate server-side editing API is outside this decision.

**Authentication stays outside the folder.** The runtime captures the account independently of the folder's origin. It supplies that account's credential only to the trusted service, and the host checks repository ownership. A copied origin grants nothing. Tokens never appear in URLs, repository configuration, command arguments, or logs. The credential channel must scope requests after URL rewriting and redirects and prevent repository-configured helpers from receiving the account token. Hooks and aliases are user-executed code, not sandboxed by this design; do not expose the token to their environment or arguments. A blanket authentication header is not an established solution.

## Feasibility gates

- Choose and exercise a runtime and storage layout that serve Git clone, fetch, and push. A Cloudflare Worker running the Git executable is not assumed.
- Verify atomic ref updates under concurrent pushes, unique live folder names, permanently retired endpoints, and deletion fencing. Rejected writes must not leave a published partial tree. Ordinary Git receive validation remains necessary; no bespoke quarantine rule is required to distinguish repository lifetimes.
- Establish a per-invocation native credential channel for the CLI and each standalone app, including hostile helper configuration and account replacement. None exists for hosted folders today. These records do not enable browser account folders; their transport and account-qualified storage require a separate decision.
- Measure stored bytes and clone time with real Whispering audio history. No measurement exists. Shallow clones, partial clones, LFS, encryption, and history purge are not assumed.

## Consequences

- Folder names match across local and cloud views; transport URLs stay stable for the lifetime of each repository.
- An old clone cannot silently upload into a replacement repository. A person can deliberately change its remote and import its history, subject to the new repository's Git rules.
- A local folder whose origin differs from the current listing requires an explicit human decision. Discovery never rewrites it.
- Git computes ahead, behind, and divergence after fetch. Humans or coding agents resolve histories using Git; file meaning and schema validity still need checking after a merge.
- One folder's divergence does not block another folder. No commit spans folders, so cross-folder links can point into a sibling at an older revision.
- Full clones include committed audio history. A permanently unique URL removes identity machinery, not Git hosting or history costs.
- The initial commit avoids unrelated roots on fresh devices. It does not eliminate ordinary concurrent-edit divergence. An isolated local Git check confirmed two independently edited clones retain that shared root and start on `main`; hosted creation atomicity remains unbuilt.

## Considered alternatives

- **Use the folder name as a permanently non-reusable repository URL.** This removes the opaque ID but permanently consumes the dataset name after deletion. Supporting recreation would require another generation or alias mechanism.
- **Reuse name-derived URLs and seed unique identity commits.** This makes stale pushes meet unrelated history, but requires root uniqueness and ancestry constraints on write paths. Immutable URLs remove the stale destination before history exchange starts; the adopted ordinary initial commit serves bootstrap only.
- **A per-path version service with optional local Git.** It permits independent paths to transfer during another path's conflict, but introduces version baselines, deletion tombstones, and related-file transfer bookkeeping. Reconsider it if Git hosting or audio history costs fail the feasibility gates.
- **One account-wide repository or one repository per application.** Both couple datasets beyond the directory ownership boundary. Applications and datasets do not map one-to-one.
- **A separate catalog or push-created repositories.** The first duplicates repository lifecycle state; the second permits stale clients to recreate deleted repositories.
