# Auth Workspace Scope Clean Break

**Date**: 2026-05-01
**Status**: Draft
**Author**: AI-assisted
**Branch**: `codex/explicit-daemon-host-config`

## One Sentence

One auth client drives auth side effects for a set of browser workspaces, and each browser workspace exposes predictable runtime attachments instead of auth-specific lifecycle adapters.

## Overview

Replace the single-workspace lifecycle binding with an explicit auth workspace scope. `bindAuthWorkspaceScope(...)` binds one `AuthClient` to many browser workspaces, serializes auth snapshot application, applies auth sessions across the whole scope, and clears local browser data as one grouped operation when leaving an applied user.

This is a clean break. Do not keep `bindWorkspaceAuthLifecycle` as a compatibility alias. Do not preserve `getAuthSyncTargets()`. Do not add `workspace.authLifecycle` or `workspace.authBinding`. Browser workspaces that participate in auth lifecycle must expose the standard top-level `BrowserWorkspace` shape.

Most of the clean break is settled. The remaining design question is the child document lifecycle surface: Fuji, Honeycrisp, and Opensidian open per-row or per-file browser documents with their own IndexedDB and sync attachments. The spec must not pretend a raw `syncAttachments` set solves that whole problem. Close the child document collection design before implementing the auth binding.

## Motivation

The current binding is shaped around one workspace:

```ts
bindWorkspaceAuthLifecycle({
	auth,
	workspace: fuji,
	leavingUser: {
		afterCleanup: () => window.location.reload(),
		onCleanupError: reportCleanupError,
	},
});
```

That shape creates four problems:

1. One auth client represents one user session, but each workspace binding keeps its own `activeUserId` and `activeToken`.
2. Cleanup can split the app: workspace A clears while workspace B fails.
3. The binding reaches through whatever structural fields happen to exist today: `sync`, `idb`, `encryption`, and `getAuthSyncTargets()`.
4. Zhongwen has encrypted local persistence but no auth-backed sync target, so it has to duplicate auth cleanup logic manually.

The clean break should standardize browser workspace bundles instead of adding an auth-specific adapter field.

```txt
Before
  auth
    | bindWorkspaceAuthLifecycle({ workspace: fuji })
    | bindWorkspaceAuthLifecycle({ workspace: honeycrisp })
    | bindWorkspaceAuthLifecycle({ workspace: tabManager })
    v
  three independent lifecycle memories

After
  auth
    | bindAuthWorkspaceScope({ workspaces: [fuji, honeycrisp, tabManager] })
    v
  one scope memory, one cleanup result, one policy path
```

## Workspace Vocabulary

`Workspace` is the root Y.Doc domain bundle. It is not browser-specific and it is not auth-specific.

`BrowserWorkspace` is a `Workspace` with browser runtime attachments. It has required IndexedDB persistence, nullable root sync, and local data cleanup. It may also own browser document collections once the child document design is closed.

`FileBackedWorkspace` is a `Workspace` opened from a Bun, script, daemon, or other local file runtime. It should be returned from an async `open*()` function after local persistence is loaded. It is not part of this auth spec.

`BrowserDocument` is a non-root browser Y.Doc bundle such as a Fuji entry content doc, Honeycrisp note body doc, or Opensidian file content doc. It is not automatically a `Workspace`.

`BrowserDocumentCollection` is the likely missing concept: a workspace-owned collection of child browser documents with one standard surface for open, dispose, offline, reconnect, and local data clearing. The exact API is still open.

`Auth` means the `@epicenter/auth` session snapshot: loading, signed out, or signed in with user id, session token, and encryption key package.

`Auth lifecycle` means the transition processor that reacts to those snapshots. It applies encryption keys, moves sync resources offline or online, clears local browser data, and runs app policy callbacks.

The auth binding accepts browser workspaces only.

## Proposed Workspace Shape

The locked shape should live in `@epicenter/workspace`.

```ts
import type * as Y from 'yjs';

export type Workspace = {
	readonly ydoc: Y.Doc;
	readonly encryption: EncryptionAttachment;
	batch(fn: () => void): void;
	[Symbol.dispose](): void;
};

export type BrowserWorkspace = Workspace & {
	readonly idb: IndexedDbAttachment;
	readonly sync: SyncAttachment | null;
	clearLocalData(): Promise<unknown>;
};
```

This is the root browser workspace shape. It is intentionally missing the unresolved child document field. The final type may add `documentCollections`, a workspace-level resource controller, or another explicit browser document lifecycle surface.

### Why `encryption` Is On `Workspace`

The app workspace roots are encrypted domain documents. Fuji, Honeycrisp, Opensidian, Tab Manager, and Zhongwen all construct `encryption` alongside the root `ydoc` and use it to attach tables and KV.

If a future helper returns a raw unencrypted Y.Doc, it should not be called a `Workspace`. It should be a content doc or document bundle.

### Why `batch` Stays

Single table operations already transact internally, but product actions often write multiple tables, KVs, or rich text values together. `batch()` gives those actions one Yjs transaction, one observer flush, and one sync update burst without exposing `ydoc.transact(...)` everywhere.

Keep the current repo name `batch`. It is less literal than `transact`, but it is already the local convention and reads well in action code.

### Why `idb` Is Required On `BrowserWorkspace`

Browser workspaces are local-first. IndexedDB is the browser persistence attachment in this repo, and Yjs expects browser persistence providers to compose with network providers. A browser workspace without local persistence should not satisfy `BrowserWorkspace`.

`whenReady` should not be part of the shared type. Browser callers that need the local readiness gate should await the attachment directly:

```ts
await workspace.idb.whenLoaded;
```

That gate means local persisted state has loaded. It does not mean remote sync has converged.

### Why `sync` Is Nullable

Sync is a transport capability. A browser workspace can be encrypted and persisted locally without a network sync target. Zhongwen is the current example.

## Decisions Locked In

| Question | Decision | Rationale |
| --- | --- | --- |
| Auth binding name | `bindAuthWorkspaceScope` | One auth client owns a scope of workspaces. The name says the unit is the auth scope, not one workspace lifecycle. |
| Workspace input | `workspaces: Iterable<BrowserWorkspace>` | The binding controls one or many browser workspaces with the same lifecycle. A singular convenience API would recreate drift. |
| Adapter field | No `workspace.authLifecycle` or `workspace.authBinding` | The clean break standardizes the browser workspace shape instead of hiding runtime attachments behind an auth-specific adapter. |
| Compatibility | No alias for `bindWorkspaceAuthLifecycle` | Compatibility is not a product requirement for this break. Keeping both names would make the old shape look supported. |
| Root identity | `workspace.ydoc.guid` | The workspace guid names the document and sync room. Auth user id only decides session transitions. |
| Context field name | Use `workspaceGuid`, not `workspaceId` | `workspaceGuid` makes the Y.Doc source explicit and avoids confusing it with auth, organization, or product ids. |
| Policy callbacks | Required cleanup and apply callbacks | Call sites must acknowledge cleanup failure, successful clear, and signed-in apply. No-op policy is allowed but explicit. |
| Policy names | Cleanup and apply names | `leavingUser` and `signedIn` describe auth states. `onClearLocalDataError`, `afterClearLocalData`, and `afterApplyAuthSession` describe the lifecycle moments. |
| Readiness | No shared `whenReady` on `BrowserWorkspace` | Browser callers can await `workspace.idb.whenLoaded` directly. File-backed open functions can be async and resolve when persistence is ready. |
| User switch | Do not apply user B to old live browser workspaces | Clearing IndexedDB does not clear the in-memory Y.Doc. Browser apps should reload or reopen fresh workspace objects after cleanup. |

## Open Design: Child Document Collections

The auth binding needs four resource operations across the whole browser scope:

1. Apply encryption keys to every root workspace.
2. Take every live sync resource offline before cleanup or token replacement.
3. Reconnect every live sync resource after applying a signed-in session.
4. Clear every local browser persistence store that belongs to the workspace scope.

The root `sync` field only covers the root workspace room. It does not cover child documents:

```txt
Fuji BrowserWorkspace
  ydoc, encryption, idb, sync
  entryContentDocs
    entry A browser document: ydoc, idb, sync
    entry B browser document: ydoc, idb, sync

Honeycrisp BrowserWorkspace
  ydoc, encryption, idb, sync
  noteBodyDocs
    note A browser document: ydoc, idb, sync
    note B browser document: ydoc, idb, sync

Opensidian BrowserWorkspace
  ydoc, encryption, idb, sync
  fileContentDocs
    file A browser document: ydoc, idb, filesystem persistence
```

The old `getAuthSyncTargets()` solved only part of this. It inventoried auth-backed sync targets, but it did not name child documents as a runtime concept and did not solve local data cleanup for child IndexedDB stores. A raw `syncAttachments: ReadonlySet<SyncAttachment>` has the same smell. It answers "what should reconnect?" but not "what local data belongs to this browser workspace?" or "what gets disposed when the workspace closes?"

### What `createDisposableCache` Actually Buys

One sentence: `createDisposableCache` shares one live disposable resource per id, refcounts handles, and disposes the underlying resource after a grace period or cache disposal.

That primitive should stay generic. It should not learn auth, sync, IndexedDB prefixes, or workspace semantics. Those are higher-level browser workspace concerns.

### Likely Direction

Add a browser document collection layer that wraps or composes `createDisposableCache` inside each browser workspace open function.

Candidate shape:

```ts
export type BrowserDocument = {
	readonly ydoc: Y.Doc;
	readonly idb: IndexedDbAttachment | null;
	readonly sync: SyncAttachment | null;
	[Symbol.dispose](): void;
};

export type BrowserDocumentCollection<
	Id extends string | number = string,
	TDocument extends BrowserDocument = BrowserDocument,
> = Disposable & {
	readonly name: string;
	open(id: Id): TDocument & Disposable;
	has(id: Id): boolean;
	goOffline(): void;
	reconnect(): void;
	clearLocalData(): Promise<unknown>;
};

export type BrowserWorkspace = Workspace & {
	readonly idb: IndexedDbAttachment;
	readonly sync: SyncAttachment | null;
	readonly documentCollections: readonly BrowserDocumentCollection[];
	clearLocalData(): Promise<unknown>;
};
```

This shape is not final. It is the current best candidate because it moves the dependency in the right direction:

```txt
auth-workspace
  asks BrowserWorkspace to apply browser lifecycle operations

BrowserWorkspace
  owns root ydoc, idb, sync, child document collections

BrowserDocumentCollection
  owns child document cache, active child syncs, child local cleanup

createDisposableCache
  owns one live disposable value per id
```

This preserves the current explicit child document builders. It does not revive `.withDocument()`. The table row can still store the child document guid, and the app can still choose when to open a child document. The new layer only names the browser runtime collection so auth and workspace disposal have something predictable to operate on.

### Questions Still Open

1. Should `BrowserWorkspace` expose `documentCollections`, or should it expose higher-level methods such as `goOffline()`, `reconnect()`, and `clearLocalData()` that include root and child resources?
2. Should `BrowserDocument.idb` be nullable, or should browser document collections be split by persistence kind?
3. How should a collection clear child IndexedDB data for documents that are not currently open?
4. Should collections discover clearable child ids from root tables, from an IndexedDB prefix, or from explicit collection metadata?
5. Should `BrowserWorkspace[Symbol.dispose]()` always dispose every document collection before destroying the root Y.Doc?
6. Does Opensidian's file content case fit `BrowserDocumentCollection`, or does it need a sibling `BrowserFileDocumentCollection`?
7. Is `syncAttachments` still needed internally as an implementation detail, or should it disappear entirely from public types?

The recommendation is to close these questions before implementing `bindAuthWorkspaceScope`. The auth binding can be correct only if it has a complete browser resource surface, not just root workspaces.

## Proposed Auth API

`@epicenter/auth-workspace` should depend on the `BrowserWorkspace` type from `@epicenter/workspace`.

```ts
import type { AuthClient } from '@epicenter/auth';
import type { BrowserWorkspace } from '@epicenter/workspace';

export type AuthWorkspaceClearFailure = {
	workspaceGuid: string;
	error: unknown;
};

export type LeavingUserDestination =
	| { status: 'signedOut' }
	| { status: 'signedIn'; userId: string };

export type LeavingUserContext = {
	fromUserId: string;
	to: LeavingUserDestination;
	workspaceGuids: readonly string[];
};

export type LocalDataClearErrorContext = LeavingUserContext & {
	failures: readonly AuthWorkspaceClearFailure[];
};

export type SignedInWorkspacesAppliedContext = {
	userId: string;
	tokenChanged: boolean;
	workspaceGuids: readonly string[];
};

export type AuthWorkspaceScopeOptions = {
	auth: AuthClient;
	workspaces: Iterable<BrowserWorkspace>;
	onClearLocalDataError(context: LocalDataClearErrorContext): void;
	afterClearLocalData(context: LeavingUserContext): void;
	afterApplyAuthSession(context: SignedInWorkspacesAppliedContext): void;
};

export function bindAuthWorkspaceScope(
	options: AuthWorkspaceScopeOptions,
): () => void;
```

All three policy callbacks are required. A caller with no signed-in policy can pass a no-op, but the call site should still acknowledge the lifecycle moment.

```ts
bindAuthWorkspaceScope({
	auth,
	workspaces: [fuji],
	onClearLocalDataError: ({ failures }) => {
		toast.error('Could not clear local data', {
			description: failures.map(formatClearFailure).join('\n'),
		});
	},
	afterClearLocalData: () => window.location.reload(),
	afterApplyAuthSession: () => {},
});
```

Tab Manager uses the signed-in policy:

```ts
bindAuthWorkspaceScope({
	auth,
	workspaces: [tabManager],
	onClearLocalDataError: ({ failures }) => {
		toast.error('Could not clear local data', {
			description: failures.map(formatClearFailure).join('\n'),
		});
	},
	afterClearLocalData: () => window.location.reload(),
	afterApplyAuthSession: () => {
		void registerDevice();
	},
});
```

## Identity

Workspace identity is `workspace.ydoc.guid`. It is not auth identity.

The auth binding uses `workspace.ydoc.guid` for duplicate detection, cleanup failure reporting, and callback context. Callback fields should say `workspaceGuid`, not `workspaceId`, so the source is explicit. Auth user identity is only used to decide whether the scope is staying on the same user or leaving an applied user.

## State Machine

The binding owns only two auth lifecycle facts:

```ts
let activeUserId: string | null = null;
let activeToken: string | null = null;
```

It also owns execution bookkeeping for serialized async processing:

```ts
let latestSnapshot = auth.snapshot;
let revision = 0;
let processing = false;
let disposed = false;
```

Snapshots must be processed through one latest-snapshot drain loop. Cleanup and apply operations must not overlap.

The important rule is this: after any awaited cleanup, check whether a newer snapshot arrived before applying a signed-in snapshot. A stale signed-in snapshot must not apply after cleanup if auth has already moved on.

### Loading

```txt
loading
  no side effects
```

### Cold Signed-Out Boot

```txt
activeUserId is null
snapshot is signedOut

all browser sync resources go offline
activeToken becomes null
local data is not cleared
policy does not run
```

### Cold Signed-In Boot

```txt
activeUserId is null
snapshot is signedIn user A

apply user A encryption keys to every workspace
reconnect every deduped browser sync resource
activeUserId becomes A
activeToken becomes token A
afterApplyAuthSession runs once
```

### Same User Token Change

```txt
activeUserId is A
activeToken is token 1
snapshot is signedIn user A with token 2

apply encryption keys to every workspace
reconnect every deduped browser sync resource
activeToken becomes token 2
afterApplyAuthSession runs once
```

### Same User Key Change Without Token Change

```txt
activeUserId is A
activeToken is token 1
snapshot is signedIn user A with token 1 and new keys

apply encryption keys to every workspace
do not reconnect sync
afterApplyAuthSession runs once
```

### Signed-In To Signed-Out

```txt
activeUserId is A
snapshot is signedOut

all browser sync resources go offline
activeToken becomes null
clear local data for every workspace

if every clear succeeds:
  activeUserId becomes null
  afterClearLocalData runs once

if any clear fails:
  activeUserId remains A
  onClearLocalDataError runs once with all failures
  afterClearLocalData does not run
```

### Signed-In User A To Signed-In User B

```txt
activeUserId is A
snapshot is signedIn user B

all browser sync resources go offline
activeToken becomes null
clear local data for every workspace

if every clear succeeds:
  activeUserId becomes null
  afterClearLocalData runs once
  B is not applied to the existing live workspace objects

if any clear fails:
  activeUserId remains A
  onClearLocalDataError runs once with all failures
  B is not applied
```

The current browser apps should reload in `afterClearLocalData`. Applying user B to the same live Y.Doc objects after clearing IndexedDB is unsafe because the old user's CRDT state is still in memory.

## Implementation Plan

### Phase 0: Close Browser Child Document Design

Implementation should not start until this phase is complete.

- [ ] **0.1** Decide whether the public browser workspace surface is `documentCollections` or higher-level workspace methods.
- [ ] **0.2** Decide whether `BrowserDocument.idb` is nullable or whether different collection types are needed for IndexedDB-backed and file-backed child documents.
- [ ] **0.3** Decide how child document local data clears when the child document is not currently open.
- [ ] **0.4** Prove the design against Fuji entry content docs, Honeycrisp note body docs, and Opensidian file content docs.
- [ ] **0.5** Keep `createDisposableCache` generic. Add a browser document collection wrapper only if it owns real browser lifecycle semantics.
- [ ] **0.6** Update this spec with the final child document API and remove the candidate wording.

### Phase 1: Standardize Workspace Types

- [ ] **1.1** Export `Workspace` and `BrowserWorkspace` from `@epicenter/workspace`.
- [ ] **1.2** Keep `Workspace.ydoc` required.
- [ ] **1.3** Keep `Workspace.encryption` required.
- [ ] **1.4** Keep `Workspace.batch(fn)` required.
- [ ] **1.5** Keep `Workspace[Symbol.dispose]()` required.
- [ ] **1.6** Keep `BrowserWorkspace.idb` required.
- [ ] **1.7** Keep `BrowserWorkspace.sync` nullable.
- [ ] **1.8** Add the final child document lifecycle surface from Phase 0.
- [ ] **1.9** Keep `BrowserWorkspace.clearLocalData()` or replace it with the final higher-level cleanup method from Phase 0.
- [ ] **1.10** Do not add `whenReady` to the shared `BrowserWorkspace` type.

### Phase 2: Replace The Public Auth Binding API

- [ ] **2.1** Rename `bindWorkspaceAuthLifecycle` to `bindAuthWorkspaceScope`.
- [ ] **2.2** Replace `WorkspaceAuthTarget` with `BrowserWorkspace`.
- [ ] **2.3** Replace the `workspace` option with `workspaces`.
- [ ] **2.4** Remove support for `getAuthSyncTargets()`.
- [ ] **2.5** Remove support for `workspace.authLifecycle` or `workspace.authBinding`.
- [ ] **2.6** Rename callback context fields from `workspaceIds` to `workspaceGuids`.
- [ ] **2.7** Do not export compatibility aliases.

### Phase 3: Implement Scope State Machine

- [ ] **3.1** Snapshot the `workspaces` iterable once at bind time and throw if it is empty.
- [ ] **3.2** Throw if `workspace.ydoc.guid` values are duplicated.
- [ ] **3.3** Apply encryption keys to every workspace before reconnecting sync resources.
- [ ] **3.4** Move every root and child sync resource offline before cleanup or token replacement.
- [ ] **3.5** Deduplicate sync resources across all workspaces for every offline or reconnect operation.
- [ ] **3.6** Process auth snapshots through a serialized latest-snapshot drain loop.
- [ ] **3.7** Keep `activeUserId` until all local data clears succeed.
- [ ] **3.8** Set `activeToken` to null whenever sync resources are taken offline.
- [ ] **3.9** After awaited cleanup, skip applying stale signed-in snapshots if a newer snapshot arrived.
- [ ] **3.10** Do not apply a different signed-in user to the same live browser workspaces after cleanup.
- [ ] **3.11** Report all workspace clear failures in one structured callback.

### Phase 4: Update Browser Workspace Construction

- [ ] **4.1** Update Fuji browser workspace to satisfy `BrowserWorkspace`.
- [ ] **4.2** Update Honeycrisp browser workspace to satisfy `BrowserWorkspace`.
- [ ] **4.3** Update Opensidian browser workspace to satisfy `BrowserWorkspace`.
- [ ] **4.4** Update Tab Manager browser workspace to satisfy `BrowserWorkspace`.
- [ ] **4.5** Update Zhongwen browser workspace to satisfy `BrowserWorkspace` with `sync: null`.
- [ ] **4.6** Replace `getAuthSyncTargets()` with the final Phase 0 child document lifecycle surface.
- [ ] **4.7** Keep token sourcing in sync resources through `auth.whenLoaded` and `auth.snapshot`.
- [ ] **4.8** Ensure `BrowserWorkspace[Symbol.dispose]()` disposes child document collections before destroying the root Y.Doc, if Phase 0 chooses collections.

### Phase 5: Update App Bindings

- [ ] **5.1** Update Fuji to call `bindAuthWorkspaceScope({ auth, workspaces: [fuji], ... })`.
- [ ] **5.2** Update Honeycrisp to call `bindAuthWorkspaceScope({ auth, workspaces: [honeycrisp], ... })`.
- [ ] **5.3** Update Opensidian to call `bindAuthWorkspaceScope({ auth, workspaces: [opensidian], ... })`.
- [ ] **5.4** Update Tab Manager to call `bindAuthWorkspaceScope({ auth, workspaces: [tabManager], ... })` and move device registration to `afterApplyAuthSession`.
- [ ] **5.5** Replace Zhongwen manual auth listener with `bindAuthWorkspaceScope`.
- [ ] **5.6** Keep app-owned toast and reload policy inline at call sites.

### Phase 6: Tests

- [ ] **6.1** Cover empty workspace list rejection.
- [ ] **6.2** Cover duplicate `ydoc.guid` rejection.
- [ ] **6.3** Cover duplicate sync resource dedupe across workspaces.
- [ ] **6.4** Cover root and child sync resources both going offline before cleanup.
- [ ] **6.5** Cover root and child local data clearing in one grouped operation.
- [ ] **6.6** Cover child local data clearing for a document that is not currently open, once Phase 0 defines how that works.
- [ ] **6.7** Cover cold signed-out boot across multiple workspaces.
- [ ] **6.8** Cover cold signed-in boot across multiple workspaces.
- [ ] **6.9** Cover same-user token change.
- [ ] **6.10** Cover same-user key change without token change.
- [ ] **6.11** Cover signed-in to signed-out with all clears succeeding.
- [ ] **6.12** Cover signed-in to signed-out with one workspace clear failing.
- [ ] **6.13** Cover signed-in user A to signed-in user B with all clears succeeding and no B apply.
- [ ] **6.14** Cover signed-in user A to signed-in user B with one workspace clear failing and no B apply.
- [ ] **6.15** Cover retry after failed cleanup preserves old active user memory.
- [ ] **6.16** Cover same-user sign-in after failed sign-out cleanup reconnects because `activeToken` is null.
- [ ] **6.17** Cover snapshots emitted while cleanup is in flight are serialized and latest snapshot wins.
- [ ] **6.18** Cover stale signed-in snapshot skipped after cleanup when a newer snapshot arrived.
- [ ] **6.19** Cover non-sync encrypted workspace with `sync: null`.
- [ ] **6.20** Cover unsubscribe stops future queued work from new auth emissions.
- [ ] **6.21** Cover `clearLocalData()` failure aggregation with multiple failed workspaces.

### Phase 7: Docs And Skills

- [ ] **7.1** Update `docs/guides/consuming-epicenter-api.md`.
- [ ] **7.2** Update `docs/encryption.md`.
- [ ] **7.3** Update `.agents/skills/auth/SKILL.md`.
- [ ] **7.4** Update `.agents/skills/cohesive-clean-breaks/SKILL.md`.
- [ ] **7.5** Update `apps/fuji/README.md`.
- [ ] **7.6** Update the previous lifecycle spec with a superseded note.
- [ ] **7.7** Grep for old public names and old target fields in auth lifecycle docs.

### Phase 8: Verification

- [ ] **8.1** `bun test` in `packages/auth-workspace`.
- [ ] **8.2** `bun run typecheck` in `packages/auth-workspace`.
- [ ] **8.3** `bun run typecheck` in `packages/workspace`.
- [ ] **8.4** `bun run typecheck` in `packages/auth-svelte`.
- [ ] **8.5** Run one affected app typecheck and record unrelated baseline failures separately.
- [ ] **8.6** Run targeted grep:

```sh
rg -n "bindWorkspaceAuthLifecycle|WorkspaceAuthTarget|WorkspaceAuthSyncTarget|getAuthSyncTargets|authLifecycle|authBinding|onCleanupError|afterCleanup|onSnapshot" apps packages docs .agents/skills
```

Expected result: no live references to the old workspace auth binding API. Historical specs may mention old names only while describing prior behavior.

## Non Goals

- Do not redesign file-backed workspace runtime shapes in this spec.
- Do not move encryption key package ownership.
- Do not make workspace core import `AuthClient`.
- Do not extract app toast or reload policy into `@epicenter/auth-workspace`.
- Do not add compatibility aliases for old names.
- Do not introduce durable pending-cleanup retry state. That should be a separate product decision.

## Success Criteria

- [ ] One auth lifecycle binding controls one or many browser workspaces.
- [ ] Browser workspaces expose standard top-level runtime fields consumed by `@epicenter/auth-workspace`.
- [ ] The final browser child document lifecycle surface covers active child syncs, child persistence cleanup, and workspace disposal.
- [ ] No app owns manual auth transition cleanup logic for encrypted browser workspaces.
- [ ] Failed cleanup cannot make a later signed-in snapshot look like cold boot.
- [ ] A different signed-in user is not applied to old live Y.Doc objects after cleanup.
- [ ] Multiple workspace cleanup failures are reported together with workspace guids.
- [ ] Sync reconnect decisions still depend only on `activeToken`.
- [ ] User switch, sign-out, token refresh, and key refresh tests pass for multi-workspace scopes.
