# 0461. Portable data folders live under Local and derived account scopes

- **Status:** Proposed
- **Date:** 2026-09-29
- **Implementation:** Whispering's desktop shell opens `~/Epicenter/local/so.epicenter.whispering` by default, or the directory `WHISPERING_DATA_ROOT` names.
- **Unbuilt:** account-key derivation and golden-vector tests, managed folder-name admission, account-folder discovery and bootstrap, explicit cloud transfers, credential separation for portable copies, scope-bounded opening, copying, and link resolution, and migration from Yjs-backed stores and working copies.

## Context

A portable file root needs separate places for Local and account-linked data. The older Yjs store addresses put a definition before its Local or account owner. The current checkout is a working copy of a Yjs document. Neither layout decides the root of a file-authoritative folder. Whispering's desktop shell already uses a Local file-authoritative folder.

One person can retain Local data and data for several accounts. An account's identity is the pair of authority ID and principal ID, not an email, display name, or principal alone. Principal IDs can repeat across authorities. Independent native applications must find the same account scope after sign-in, including when Epicenter desktop is not installed. A chosen folder name such as `braden-cloud` would require every application to ask for the folder or consult a shared device registry.

Private storage already uses `deviceOwnerPath` to encode each identity component as UTF-8 hex. That reversible address is appropriate for app-private storage, but a self-hosted authority ID already contains the hex of its origin. Encoding it again can make a portable path component too long. A lossy slug can merge distinct identities on case-insensitive filesystems.

## Decision

**The portable root groups data folders by scope.** `~/Epicenter/local/` is the Local scope. `~/Epicenter/accounts/` contains one directory for each account identity. A data folder has a stable folder ID within its scope, normally the application's reverse-DNS definition ID. Its name is not a globally unique repository identity.

```text
~/Epicenter/
  local/
    so.epicenter.notes/
      kv.json
      notes/n7.md
    so.epicenter.files/
      files/f2.md
      files/f2.jpg
  accounts/
    b7efec8b3e072ff278fe2e331ce495dee36882be0ad2981c4e0196aeecbc1fc7/
      so.epicenter.notes/
        kv.json
        notes/n8.md
      so.epicenter.files/
        files/f3.md
        files/f3.jpg
```

The account directory in this example derives from `{ authorityId: "epicenter-api", principalId: "user-123" }`. The same definition can have a separate data folder in Local and in each account scope. Copying an account directory copies its contained data folders together.

**Every application derives the account directory from the exact account identity.** Let `A` be the UTF-8 bytes of `authorityId` and `P` be the UTF-8 bytes of `principalId`. The directory name is:

```text
lowercase_hex(SHA-256(U32BE(byte_length(A)) || A || P))
```

`U32BE` is the four-byte unsigned big-endian length of `A`. The remaining bytes are `P`, so no second length or separator is needed. Both IDs must be nonempty, well-formed Unicode strings without control characters; reject an `A` longer than `2^32 - 1` bytes. Hash their exact UTF-8 bytes without trimming, case folding, or Unicode normalization. The auth server supplies the normalized authority ID; the principal ID remains exactly what that authority issued. SHA-256 emits all 32 digest bytes, encoded as 64 lowercase ASCII hex characters. No salt, domain tag, or version prefix participates in the address.

These examples pin the byte contract:

```text
("epicenter-api", "user-123")
  -> b7efec8b3e072ff278fe2e331ce495dee36882be0ad2981c4e0196aeecbc1fc7
("instance-68747470733a2f2f6578616d706c652e74657374", "instance")
  -> 478bb60d9394294f671f2c4a5afe2819848e57243d4d319e14f5e8d1fe269653
("A", "é")
  -> 1f9770442aa6f99e1fe926643b4ba2cc764e63abaee38dcc6bb158a62c3d4720
```

Each implementation must pass the same golden vectors. The derivation is a permanent path contract. An incompatible change requires an explicit migration from the old path. A missing account directory is not evidence of an empty account. An application creates one only through an explicit online create or download, never because sign-in computed a path that does not exist yet. An external rename breaks automatic discovery until the derived name is restored. Applications show a human account name in their UI and can reveal the directory, but that name does not participate in the path.

**Finding a directory does not authorize a transfer.** Sign-in lets an application calculate a path and open saved files for inspection. It transfers no folder content. Each standalone application owns its Epicenter authentication session; none keeps a private record that enrolls a folder for automatic publication. Directory names and configured origins can be compared with the cloud listing without a local installation database. Standard Git origin records the repository destination; it grants no permission. Git owns history comparison and reconciliation, while Epicenter captures the account and supplies trusted-service credentials ([ADR-0489](0489-cloud-folder-transfers-are-explicit-and-bootstrap-before-opening.md)).

The portable-folder contract keeps credentials outside copied content. Whispering's current Local development host stores its transcription API key privately under `.git`; a filesystem copy can carry that key, so this separation is not implemented there yet. Managed account operations resolve the selected account's derived path and leave mismatching origins unchanged. They do not create an empty replacement and treat missing files as deletions. Restoring old contents in place over a folder that kept operating looks like an edit; the directory name cannot distinguish the two, and no stored identity detects it in every case. Raw Git at an arbitrary path remains outside Epicenter's scope selection.

**Local data stays Local.** No operation moves a `local/` folder into an account, binds it to one, or uploads it in place. A person may explicitly copy selected current files from a Local folder into an account folder after reviewing them. The copy creates new files at the destination; they carry no history, pending work, or credentials from their source, and the Local folder is unchanged.

**A selected scope bounds opening, copying, and links between data folders.** A Local view opens `local/`; an account view opens one derived `accounts/<account-key>/`. A parent `Epicenter/` directory containing other scopes is not an implicit grant to them. A link leaving the selected scope remains unresolved even if its target exists elsewhere under `Epicenter/`.

Copying one complete scope's authored content preserves its saved current files and relative links between its data folders, provided the copy includes all file attachment bytes. Copying one data folder's authored content preserves its owned files but may leave links to siblings unresolved. Credentials, authentication sessions, and app/account SQL remain outside authored folders. File-first consumers reserve each folder's `.epicenter/` for optional rebuildable folder-derived caches under [ADR-0494](0494-file-folders-reserve-epicenter-for-rebuildable-caches.md). Authored-folder copies omit that subtree; caches carried by raw copies require validation before reuse. Pending-work databases require a separate backup and activation contract. The agreed default root is `~/Epicenter`; moving the root requires each independent app to select the new location or a separately specified root-discovery mechanism. Deriving an account child does not locate a moved root.

[ADR-0496](0496-native-app-runtime-storage-is-independent-of-the-shell.md) proposes shared native provider credentials and a fixed app/account runtime root outside the authored tree. Moving this portable root does not move that runtime. [ADR-0497](0497-browser-folders-use-indexeddb-and-private-sqlite-uses-opfs.md) maps these logical authored scopes to one IndexedDB database per captured folder address; private live SQL remains in OPFS. Browser storage remains origin-private. These targets do not relocate existing stores.

This address applies only to folders deliberately migrated to file authority. It does not relocate current IndexedDB databases, native Yjs/SQLite/blob paths, claims, or Markdown checkouts. Shared-owner addressing and permissions require a separate decision before Shared file folders exist.

## Consequences

- Independent native applications calculate the same account directory from the same authenticated identity without Epicenter desktop, a chosen alias, or a shared device registry.
- A person can copy one scope's saved files and relative links as a subtree. Its opaque name is stable but does not identify the person at a glance.
- The derivation removes folder-name allocation, collision handling for human names, and rename tracking. It does not remove per-transfer validation or reconciliation of a restored folder.
- The shared account path does not coordinate two processes writing the same data folder. A data definition needs its own writer and file-change contract before multiple applications open it concurrently.
- Filesystem traversal and link resolution must stay inside the selected scope, including through native symlinks. A writer must not follow a link into another scope and then treat those bytes as owned or synchronizable data.

## Considered alternatives

- Put the definition ID first, with `local/` and `accounts/` below it. This scatters one account's data and makes account-wide copying and file access grants require enumeration across definitions.
- Use a human-chosen account directory name such as `braden-cloud`. Independent applications cannot derive that name after sign-in; a shared registry or repeated folder selection would become part of account discovery.
- Slugify `authorityId` and `principalId`. Slugging can collapse distinct identifiers through case folding, punctuation replacement, or truncation. A reversible escape still leaves unbounded names. Cloud principals are opaque, while self-hosted authority IDs already contain an encoded origin, so the result is seldom readable.
- Use `deviceOwnerPath` under `accounts/`. Its second hex encoding of a self-hosted origin can exceed a filesystem component limit.
- Put an `account.json` binding inside each directory. It would add creation and mismatch recovery rules while neither locating the directory from account identity nor authorizing a transfer. A descriptive file can be added without becoming part of the address.
- Prefix the hash input with a fixed string or the directory name with a version. Neither is needed to distinguish accounts inside `accounts/`. An incompatible derivation change still requires explicit migration.
- Keep a private per-application attachment that admits a folder for synchronization. It separates finding a directory from permission to publish, but that permission is only needed when publication is automatic. It adds stored state that can drift from the directory, and recovery rules for an attachment whose directory is missing.
- Use one `account/` directory that changes with sign-in. Retaining several accounts would require another location and switching could expose one account's files under another's path.
