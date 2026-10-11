# GitHub folder pairing

**Date**: 2026-10-05
**Status**: Draft
**Owner**: Braden, with Codex owning verification and integration

## One sentence

One GitHub connection lets an Epicenter account discover several folders, each backed by its own private repository and explicit Git transfers.

## Current and target shape

Current: `@epicenter/folder` stores ordinary files and Git history, including in browser OPFS. `folder.git` exposes explicit commit, push, fetch, fast-forward adoption, and browser merge operations. It has no production GitHub authorization path. Whispering opens its Local default, has no account-folder startup, and does not enable configured-origin adoption. Source CLI account login exists, but its folder commands are Local-only.

Target: connect GitHub independently of Epicenter sign-in, create or select a private repository, pair it with an account folder, and discover that pairing from a second application session. Each checkout retains `remote.origin.url`. Discovery does not rewrite existing origins, move Local files, or trigger content transfer.

The first wave ends with one small text folder transferred between two isolated native checkouts using a designated personal test account. Browser transport is a separate deciding probe, not a property inferred from native success. Dashboard polish and standalone-app integration follow the transport proof.

## Durable direction

[ADR-0488](../docs/adr/0488-cloud-folders-use-independent-git-histories.md) records GitHub-first remote ownership and independent repositories. [ADR-0489](../docs/adr/0489-cloud-folder-transfers-are-explicit-and-bootstrap-before-opening.md) records local account selection and explicit adoption. [ADR-0490](../docs/adr/0490-the-cli-discovers-folders-and-delegates-history-to-git.md) retains ordinary Git operations.

```text
dashboard or standalone app
  -> independent Epicenter session
    -> account connection and folder pairing in Postgres
      -> authorization and narrowly scoped GitHub credential
        -> private GitHub repository

checkout A                         checkout B
  ordinary files + .git             ordinary files + .git
  origin for the paired repo        origin for the same paired repo
```

There is no encrypted Git representation, client folder-key lifecycle, or first-party Git storage in this wave. The GitHub App private key belongs in existing server secret storage. Installation and repository IDs are metadata. Persistent user refresh tokens are introduced only if a concrete authorization flow needs them.

## Folder and history behavior

One connection can pair `so.epicenter.notes` and `so.epicenter.todos` with two repositories. These repositories can have unrelated root commits. No merge between them is needed, and a conflict in Notes does not block Todos. One app can use more than one dataset; app identity is not the pairing key.

For two devices using the same dataset:

- Device A starts the folder and uploads. Device B downloads that history before editing. Both have common ancestry; later concurrent edits may still diverge or conflict.
- Devices A and B each start offline and commit before downloading. Their roots may be unrelated. Linking the same repository does not join them. Once explicitly paired with the same dataset, the app's Sync action can combine clean unrelated histories with a merge commit retaining both roots. Show conflicts when combination needs a choice. Never automatically force-push or discard either history.
- An empty newly created GitHub repository introduces no README or seed commit. Its first explicit push publishes the existing folder history.

The native passthrough can use deliberate ordinary Git reconciliation. Browser `mergeIncoming()` currently refuses unrelated roots and cannot be presented as the completed Sync journey. The transport proof reports unsupported/conflicting histories without writing; step 6 implements the settled application policy after that proof.

## Ordered work

### 1. Live authorization and creation proof

Use a designated development GitHub App and personal test account. Keep its private key out of the repository, Postgres, arguments, and logs. Authorize access to selected repositories. Demonstrate creation with explicit private visibility and no initialization, then confirm the newly created repository is accessible to the installation. Exercise linking an existing private repository too.

Determine whether installation authentication suffices for the operations and user-access checks, or whether this concrete flow needs user authorization and refresh-token storage. Knowing an installation ID is not proof that an Epicenter user may use it.

The current repository API lists user and installation tokens for personal creation with Administration write or Repository creation write. Contents write alone does not authorize creation, and private visibility must be requested explicitly. Verify the narrow creation permission and selected-installation access on the live App before choosing a broader permission.

Stop before live operations until the test owner and App are designated. Current GitHub social-login client secrets are not the repository App's private key or authorization.

### 2. Account connection and pairing

Add only the records required to associate the verified Epicenter principal, GitHub identity, installation, and folder-to-repository ID. Require one live pairing per account folder. Repository names and URLs are discovered properties, not lifetime identity.

Bind authorization callbacks to the initiating account. A caller cannot substitute another installation or repository ID. Check the requesting person's access before issuing credentials. Exercise cancellation, account replacement, expired authorization, and disconnect.

Define uncertain creation and retry behavior before calling GitHub from a database transaction. A lost API response must not cause an automatic second repository creation or adoption based on a matching name alone.

### 3. Captured-account native transfer

Mint short-lived GitHub tokens restricted to the chosen repository ID and needed Contents permission. Keep Epicenter bearers restricted to Epicenter. Deliver Git credentials through a per-invocation mechanism that scopes the actual destination after rewrites and redirects and does not expose tokens to configured helpers or hooks.

Exercise push, fetch, and guarded fast-forward between two disposable checkouts. Use an absent destination for download and preserve existing files/origins when linking. Verify token expiration, revoked installation, another Epicenter account, and changed repository identity.

### 4. Browser transport probe

Run an actual OPFS browser folder against the private GitHub repository. Determine whether direct Git HTTP works or an authenticated bounded proxy is needed. Never use a public CORS proxy with private credentials. If a proxy is needed, document that Epicenter handles repository content in transit and verify streaming, limits, destination restrictions, and credential handling before product integration.

### 5. Dashboard and application journey

After the preceding proof, add Connect GitHub, create/select private repository, pairing discovery, and disconnect controls. Signing in never grants repository access by itself. Disconnect stops new authorization without deleting local files or GitHub repositories; verify treatment of already issued credentials.

A text application obtains its own Epicenter session, lists pairings, and offers explicit Download or Link. It uses the current folder owner's supported close/reopen flow rather than mutating a live captured remote. Present saved, committed, and uploaded outcomes separately. Local files enter account storage only through an explicit reviewed copy under the existing Local policy.

### 6. Explicit application Sync and refresh

Implement ADR-0489's user-triggered save, commit, fetch, merge, and push journey. Pause new edits while finishing current saves and adopting incoming files. Stop before adoption if save or recording fails. Merge clean unrelated roots of the explicitly paired dataset as well as ordinary divergence. Retain both conflicting versions and provide a supported resolution view without blocking transfers in another folder.

Reload only when incoming changes require refreshed views. Upload alone keeps the editor as-is. An affected editor or list can refresh selectively; reloading the folder or app after any incoming file changes is an acceptable first implementation. Cursor, selection, and undo preservation are unnecessary. A UI reload must respect the existing native owner's lifetime and cannot silently change its captured destination.

If incoming adoption succeeds but upload fails, refresh the changed files and report the retained local commit and failed upload separately. If another device wins the push race, retain local history and report that another explicit sync is needed. Do not add an indefinite background retry loop.

## Acceptance evidence

Use a permitted personal test account and disposable data. Retain outcomes and redacted identifiers, never credentials.

- Create a private empty repository and verify visibility and repository ID before pairing.
- Pair two different text folders through one GitHub connection. Upload each independently and prove that one folder's divergence does not prevent the other transfer.
- Restore one folder into a second checkout, edit and commit there, and fetch/adopt it in the first checkout. Compare exact files and history.
- Create independent roots for the same dataset and report the required reconciliation without overwriting either copy.
- For the application Sync wave, combine independent roots with distinct item files and retain both histories. Show both versions of a conflicting shared file and allow deliberate resolution without force push.
- Demonstrate save-before-adoption, paused edits during sync, no reload on upload-only success, and an allowed reload after incoming changes. Include successful adoption followed by failed upload. Saved content survives; cursor, selection, and undo may reset.
- Reject unauthorized account/install/repository combinations, expired or revoked access, and forbidden credential destinations.
- Rename, delete, and recreate a test repository name. Demonstrate that the saved repository ID prevents silent adoption of the replacement. A preflight lookup alone is not a race proof.
- Preserve existing origins, ignored/untracked files, Local folders, and unsaved app input through refusal and failed setup.
- Establish browser transport with actual OPFS, or keep browser GitHub transfers explicitly unavailable until that proof exists.

## Deferred work

Organization pairing needs its own membership and policy acceptance. Automatic background synchronization needs an explicit commit, upload, retry, and conflict policy. Whispering recording transfers need measured file sizes, clone time, and stored history. GitHub LFS is not currently supported by the folder engine. First-party Git hosting and operator-blind encryption are not prerequisites for this wave.

## Evidence and starting points

- [Runnable local pairing prototype](../apps/api/evidence/github-pairing-prototype/README.md): eight completed scenarios using real scratch Git histories and simulated authorization. Demonstrates independent transfers, divergence, unrelated roots, uncommitted omissions, and raw Git accepting an old history at a recreated origin. Does not establish live GitHub or folder-engine integration.
- [Folder README](../packages/folder/README.md): implemented file and history contract.
- [Auth README](../packages/auth/README.md): independent sessions and captured-account transport.
- [Whispering README](../apps/whispering/README.md): current Local startup and shell ownership.
- [Account-folder backlog](../BACKLOG.md#complete-the-account-folder-journey-from-sign-in-to-explicit-cloud-transfer): retained offline and transfer outcomes.
- [Earlier native hosting experiment](../apps/api/evidence/folder-git-host/README.md): alternative hosting evidence, not proof of GitHub pairing.
- [GitHub repository APIs](https://docs.github.com/en/rest/repos/repos): private creation, accepted authentication, and permissions.
- [GitHub installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation): token lifetime, repository scope, and Git HTTP access.
- [GitHub App installation](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party): selected repositories and organization authorization.
- [GitHub file limits](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github): media limits to measure before Whispering acceptance.
