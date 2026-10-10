# 0521. A data folder syncs with its Git origin through a provider

- **Status:** Proposed
- **Date:** 2026-10-11
- **Relates:** [ADR-0517](0517-a-data-folder-can-live-inside-any-repository.md) (only a repository-root data folder syncs through apps), [ADR-0488](0488-cloud-folders-use-independent-git-histories.md) (GitHub pairing), [ADR-0490](0490-the-cli-discovers-folders-and-delegates-history-to-git.md) (the withdrawn CLI cloud commands), [ADR-0509](0509-folder-remotes-and-http-fetch-have-separate-contracts.md) (remote and transport)
- **Unbuilt:** the provider interface in the hosted API, repository-addressed GitHub transfers in place of folder-ID pairings, listing data folders by `epicenter.json`, and the Cloudflare Artifacts provider.

## Context

ADR-0488 pairs each folder ID with one GitHub repository, and the deployed
GitHub connector (`apps/api/worker/git-connector`) stores that pairing per
principal as `pairing:<folderId>`. Git transfers are addressed by folder ID and
pairing revision. ADR-0490 gives the CLI its own account commands for listing,
getting, and creating cloud folders.

After ADR-0517, a data folder is defined by its `epicenter.json`, can be renamed
or moved, and syncs only at a repository root. Git already records each
checkout's destination in `.git/config`. A second record of the same fact,
keyed by a folder ID, can disagree with it. Epicenter should also be able to
host repositories later through Cloudflare Artifacts, which issues
repository-scoped tokens from Epicenter's own Cloudflare account.

## Decision

**A data folder syncs with its Git `origin`.** `remote.origin.url` in the
checkout's `.git/config` is the only record of where it syncs. Neither
`epicenter.json` nor a server-side table names a folder's remote. Renaming or
moving the directory changes nothing, because `.git` moves with it.

**A provider adds what Git cannot do for every host.** The hosted API selects a
provider from the remote URL's host. Each provider implements four operations:

```ts
// Sketch: names are settled at implementation.
type GitProvider = {
	listDataFolders(principal): Promise<Result<RemoteDataFolder[], ProviderError>>; // repositories with epicenter.json at the root
	create(principal, name): Promise<Result<RemoteDataFolder, ProviderError>>;      // an empty private repository
	identify(principal, remoteUrl): Promise<Result<RepositoryId, ProviderError>>;   // the repository behind a URL, if the principal may sync it
	transfer(principal, repositoryId, request): Promise<Response>;                  // proxy one Git HTTP request with the provider's credential
};
```

Clients never hold a provider credential. Apps send Git requests through
`httpFetch` (ADR-0509) to the hosted API, which proxies them with the
provider's credential. The proxy also serves browsers, which cannot reach Git
hosts directly. The hosted API therefore sees content in transit.

**A checkout records its expected repository ID beside its origin.** When an
app first syncs, it stores the provider's repository ID in the checkout's
`.git/config`, beside `remote.origin.url`. Every transfer names that ID, and the
provider refuses when the URL now resolves to another repository. This keeps
ADR-0488's protection against a deleted and recreated repository without a
pairing table.

**Each provider's own listing is its registry.** GitHub's list is the private
repositories the Epicenter GitHub App can reach for the principal that have
`epicenter.json` at their root. Epicenter keeps no table of which folder
belongs to which repository. A principal may sync a repository when the
provider says it may, checked on each request.

**GitHub is the first provider; Cloudflare Artifacts is the planned second.**
Artifacts hosts repositories in Epicenter's account for people without a
GitHub account, which makes Epicenter the custodian of their data, its storage
cost, and its retention. Another host has no provider and no app sync in the
first version; people use it through plain Git.

**The CLI has no Epicenter account system.** CLI users already have Git and
the host's own tools. A later `epicenter list` or `epicenter get` uses the
GitHub CLI's existing sign-in. The CLI's uncommitted `login`, `accounts`, and
`logout` commands and their operating-system credential store were removed
without landing, and apps keep their own Epicenter sign-in.

## Consequences

- The GitHub connector's `pairing:<folderId>` records and its
  `/git/<folderId>/<revision>` routes give way to repository-addressed
  transfers checked against the principal's current access. Existing pairings
  supply the repository IDs for current checkouts during migration.
- ADR-0488's pairing table and ADR-0490's cloud command list are withdrawn by
  this decision. Both records carry uncommitted work and are edited to match
  once that work lands.
- A data folder with an origin on an unsupported host syncs only through
  plain Git, outside apps.
- Adding a provider adds its own consent flow and listing; it changes no data
  folder, checkout, or client transfer code.
- Moving a data folder between hosts is a change of `origin` and repository ID,
  with history pushed to the new remote.

## Considered alternatives

- **A remote or sync ID in `epicenter.json`.** It is committed, travels with
  every copy, and mixes one checkout's destination into the data's
  declaration.
- **A server-side pairing table keyed by folder ID.** It duplicates
  `.git/config`, breaks when a folder is renamed, and is specific to one host.
- **Issuing provider tokens to clients.** Browsers still could not reach Git
  hosts, and every client would have to store host credentials.
- **Supporting any host in apps with a pasted token.** Each host's
  authentication and limits become support work before anyone needs them.
- **Epicenter account commands in the CLI.** They duplicate the host's own
  tools for the developers and agents who use the CLI.
