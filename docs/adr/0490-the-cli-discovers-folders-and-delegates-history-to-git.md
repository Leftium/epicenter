# 0490. The CLI discovers folders and delegates history to Git

- **Status:** Proposed
- **Date:** 2026-10-02
- **Unbuilt:** every account command below. The existing `epicenter` script exposes `validate`; these examples do not run today.

## Context

A fresh laptop needs to discover account folders and clone one into its expected directory. Once that directory is a Git repository, Git already supplies status, staging, commits, transfers, history inspection, integrity checks, and reconciliation. Separate Epicenter versions of those commands would introduce another semantic surface for the same repository.

Standalone applications such as Whispering still need their own download and upload controls. They cannot depend on the CLI being installed.

## Decision

**Epicenter handles account setup and folder selection; Git handles repository operations.** The proposed account command surface is:

| Command | Effect |
| --- | --- |
| `epicenter login`, `epicenter logout` | Start or end this tool's session; transfer no folder content. |
| `epicenter folders` | Compare the account's live repository listing with local directories and their origins. |
| `epicenter get <folder-id>` | Clone the selected repository into its expected absent directory. |
| `epicenter create <folder-id>` | Explicitly allocate a new repository, then use the get setup path. |
| `epicenter git <folder-id> <git-arguments...>` | Resolve and lock the directory, then invoke Git there. |

`--account` selects the session and is required when more than one account is signed in. `--root` selects a root other than `~/Epicenter`. Epicenter options precede `git`; the explicit folder ID precedes all Git arguments. Account folders follow [ADR-0461](0461-portable-data-folders-live-under-local-and-derived-account-scopes.md). An arbitrary or moved clone can be operated on through raw Git at its explicit path; it is not silently registered.

**`folders` derives presence rather than storing installations.** The cloud listing comes from [ADR-0488](0488-cloud-folders-use-independent-git-histories.md). Local entries come from immediate child directories of the selected account root. Local scope entries are shown separately and have no expected account remote. For an account folder, report cloud presence, local directory presence, and configured origin agreement as separate facts:

```text
Proposed output.

Folder                    Cloud    Device       Origin
so.epicenter.whispering    present  directory    matches
so.epicenter.notes         present  absent       none
so.epicenter.todos         present  directory    differs
so.epicenter.archive       absent   directory    configured
```

A directory without a usable Git repository is still a found directory, not an installed app or a healthy clone. Offline, cloud presence and current origin agreement are unknown; any cached observation is labeled with its age. A matching origin proves neither ancestry nor integrity. Listing verifies the native layout before reading configuration, executes no repository hooks, contacts no configured origins, and performs no repair. It ignores dot-prefixed staging and non-folder-ID names. Matching compares the configured origin URL against the canonical service URL, not its spelling after Git rewrite rules; configured push URLs are reported separately because they may send pushes elsewhere.

**`get` and `create` report setup phases.** Get uses staged clone and no-clobber publication from [ADR-0489](0489-cloud-folder-transfers-are-explicit-and-bootstrap-before-opening.md). An existing directory is reported and never overwritten or retargeted. Create requires a new cloud folder name; if cloud creation succeeds but download fails, it reports that the repository exists and that get can finish setup. Retrying must not silently allocate a second repository for the same folder.

**The Git command is a passthrough with an initial selected directory.** Forward arguments as a process argument vector, not shell text. Inherit interactive standard input and output and preserve Git's exit code. Bind the initial Git directory and worktree explicitly to the selected canonical paths, scrub inherited repository-location variables, and acquire the folder ownership lock. Reject direct global selection flags `-C`, `--git-dir`, and `--work-tree`; leave remaining command semantics to Git. Explicit worktree selection overrides `core.worktree` configuration ([Git options](https://git-scm.com/docs/git)). Aliases, hooks, submodules, and subprocesses are ordinary executable Git behavior outside the initial-target coordination guarantee. The CLI does not claim to sandbox them or lock every path they touch. The current engine runner pipes output and disables prompts, so it cannot be reused unchanged for this interactive command.

An invocation-scoped credential mechanism supplies the captured account's credential only to trusted service requests, without leaving a persistent helper in the repository or globally installing one. Isolate it from repository-configured helpers and scope it to the actual request destination after rewrites. A mismatching origin is reported by discovery; Git passthrough does not automatically retarget it. The server still decides whether the account may access the addressed repository. The credential implementation must satisfy ADR-0488's feasibility gate before these commands ship. Raw Git network commands need separately configured authentication; the Epicenter session does not automatically authenticate them.

There are no separate Epicenter commit, push, pull, status, doctor, publish, sync, or connect commands. Git's command distinctions remain intact: commit records local history, push transfers commits, and fetch updates the remote observation. Integrity inspection can use `git fsck`; it is not a prerequisite for every folder listing. A person or coding agent can explicitly merge diverged histories with Git. Epicenter neither hides these operations nor implements another conflict workflow.

**A fresh laptop uses this path.**

```sh
# Proposed commands, not implemented.
epicenter login
epicenter folders
epicenter get so.epicenter.notes
epicenter git so.epicenter.notes status

# Edit a file, then record and upload it.
epicenter git so.epicenter.notes add notes/n8.md
epicenter git so.epicenter.notes commit -m "Update note"
epicenter git so.epicenter.notes push

# Observe and adopt incoming history using Git's chosen policy.
epicenter git so.epicenter.notes fetch
epicenter git so.epicenter.notes merge --ff-only origin/main
```

Applications can instead present Download folder, Upload changes, and Get updates through shared setup and transport code. A deliberate Upload changes action may combine commit and push while reporting each outcome. Automatic local history remains separate from explicit outgoing publication. The current engine needs that policy separation before account remotes are enabled.

## Consequences

- The CLI adds discovery, directory selection, authentication, and ownership coordination. Git retains its own operations and failures.
- Folder setup stays human-oriented; advanced operations use the vocabulary already available to coding agents and Git tools.
- Every passthrough call refuses while an application owns the folder, including status and log. Close the application, use its controls, or run raw Git with Git's own concurrency guarantees.
- Git status reports local files and refs, not current cloud state. Fetch refreshes remote refs. Neither a clean working tree nor matching origin means all current saved data is in the cloud.
- Git commands can explicitly merge, rebase, restore, or change a remote. Their consequences are ordinary Git behavior, not Epicenter repair or adoption policy.

## Considered alternatives

- **Separate Epicenter wrappers for each Git operation.** They can provide tailored messages, but require maintaining another operation and outcome model. Apps can own friendly controls without duplicating the CLI surface.
- **Only raw Git.** It works once a repository is set up, but leaves account discovery, directory placement, and hosted credentials to each person or tool.
- **Automatic get for every folder on login.** It downloads unwanted history, including audio, and makes authentication trigger content transfer.
- **One sync command.** It must choose staging, commit, merge, and upload policy that the explicit Git arguments already express.
