# Auth-optional daemon startup

**Date**: 2026-06-13
**Status**: Implemented
**Owner**: Epicenter maintainers
**Branch**: codex/auth-optional-daemon-startup-spec
**Builds on**: specs/20260613T100235-action-first-daemon-runtime.md

## One Sentence

A project daemon can start signed-out only when every configured mount declares
itself local-only and therefore receives no Epicenter sync, peer, or workspace
key capabilities.

## How To Read This Spec

Read first:

- One Sentence
- Current State
- Target Shape
- Implementation Plan
- Success Criteria

Read when changing the boundary:

- Design Decisions
- Architecture
- Edge Cases
- Refusals

## Overview

The action-first daemon runtime split the output side of a mount:
`runtime.actions` is required, and `runtime.collaboration` is optional. This
spec completes the matching input-side split. Local source mirrors can run
daemon actions without constructing Epicenter auth, while collaborative
workspace mounts still fail early when signed-out.

This is not a Gmail, QuickBooks, or bank integration spec. It creates the
startup contract those integrations need.

## Motivation

### Current State

`openEpicenterRoot` requires a `WorkspaceAuthClient` before it even inspects whether
the project contains a collaborative mount.

```ts
// packages/workspace/src/workspace-apps/open-project.ts:54
export async function openEpicenterRoot(
  options: OpenEpicenterRootOptions,
): Promise<Result<StartedMount[], EpicenterConfigError | WorkspaceAppError>> {
  const { auth } = options;
  const epicenterRoot = resolve(options.epicenterRoot) as EpicenterRoot;

  const { data: mounts, error: configError } =
    await loadEpicenterConfig(epicenterRoot);
  if (configError !== null) return Err(configError);

  if (auth.state.status === 'signed-out') {
    return WorkspaceAppError.WorkspaceAuthSignedOut();
  }
}
```

`runUp` constructs machine auth before calling `openEpicenterRoot`, so a missing saved
session fails before the project config is loaded.

```ts
// packages/cli/src/commands/up.ts:135
const createAuthClient = options.createAuthClient ?? createMachineAuthClient;
const authResult = await createAuthClient();
if (authResult.error) return authResult;
const auth = authResult.data;
stack.defer(() => auth[Symbol.dispose]());

const startResult = await openEpicenterRoot({ epicenterRoot, auth });
```

The mount context is also monolithic. Every mount receives auth-derived fields,
even a local mirror that should never call them.

```ts
// packages/workspace/src/daemon/define-mount.ts:53
export type MountContext = {
  epicenterRoot: EpicenterRoot;
  mount: string;
  yDocClientId: number;
  deviceId: DeviceId;
  ownerId: OwnerId;
  keyring: () => Keyring;
  openWebSocket: OpenWebSocketFn;
  onReconnectSignal: OnReconnectSignal;
  fetch: AuthedFetch;
};
```

This creates problems:

1. **Local-only runtime output is possible, but startup still requires auth**:
   PR #1955 lets a mount return `{ actions }` without collaboration, but
   `daemon up` still fails if machine auth has no saved session.
2. **The boundary lies to local mirrors**: a local source mirror receives
   keyring, owner, fetch, and socket capabilities it must not use.
3. **Pure lazy auth would make failures late and blurry**: if a collaborative
   mount can start signed-out and throw only when it first tries to sync, the
   daemon can appear online while the workspace is not actually syncing.

### Desired State

The mount declares whether it is `local` or `collaborative`.

```ts
export default defineMount({
  name: 'gmail',
  kind: 'local',
  open(ctx) {
    return {
      actions,
      async [Symbol.asyncDispose]() {
        await mirror.close();
      },
    };
  },
});
```

Existing workspace-backed mounts declare `kind: 'collaborative'` and receive the
current auth-derived context.

```ts
export function fuji(opts: FujiMountOptions = {}) {
  return defineMount({
    name: 'fuji',
    kind: 'collaborative',
    open(ctx) {
      const workspace = createFuji({ keyring: ctx.keyring });
      const infrastructure = attachProjectInfrastructure(workspace.ydoc, {
        epicenterRoot: ctx.epicenterRoot,
        ownerId: ctx.ownerId,
        deviceId: ctx.deviceId,
        openWebSocket: ctx.openWebSocket,
        onReconnectSignal: ctx.onReconnectSignal,
        actions,
        baseURL: EPICENTER_API_URL,
      });

      return defineWorkspace({ ...workspace, ...infrastructure, actions });
    },
  });
}
```

Startup behavior becomes:

| Project shape | Signed-out startup | Signed-in startup |
| --- | --- | --- |
| All mounts `local` | Starts | Starts |
| Any mount `collaborative` | Refuses the whole project | Starts |

## Research Findings

### Runtime Output Already Split

The action-first daemon runtime spec made local actions the required capability
and collaboration optional. It explicitly deferred auth-client construction:

> A later local-only project pass should decide whether a project with no
> collaborative mounts can start without persisted sync auth.

Implication: this spec should not invent a second daemon kind or a mirror
command. The daemon still serves actions. The question is which capabilities a
mount receives at `open(ctx)`.

### Auth Is Currently Both Startup Gate And Context Source

`openEpicenterRoot` checks `auth.state.status` before it validates mount names or
opens anything. It also snapshots `ownerId` and builds `keyring`,
`openWebSocket`, `fetch`, and `onReconnectSignal` into one `MountContext`.

Implication: auth cannot stay as an eager `runUp` step. `openEpicenterRoot` must load
the config first, inspect declared mount kinds, and ask for auth only if a
collaborative mount is present.

### Storage Is Two Different Stories

`createWorkspace` has an encrypted branch and a plaintext branch. Its module doc
states that the plaintext branch is intended for in-memory importers, tests, and
benchmarks, and that real user workspaces never take it
(`packages/workspace/src/document/workspace.ts:178`).

The SQLite and Markdown materializers are ordinary projections. The SQLite
materializer opens a raw `bun:sqlite` file and exposes that file for direct SQL
reads (`packages/workspace/src/document/materializer/sqlite/bun-sqlite.ts:84`).
The Markdown export writes readable `.md` files by design.

Implication: `kind: 'local'` must not mean "use a plaintext Yjs workspace for
real user data." It means "this mount does not use Epicenter workspace auth."
Source mirrors can choose their own SQLite or file storage, but existing
workspace-backed apps stay collaborative because they need encrypted stores,
sync, peers, or owner-scoped cloud reads.

`kind: 'local'` is not a storage-security guarantee. It only controls the
capabilities Epicenter hands to the mount. A Gmail or finance mirror still owes
its own explicit local-cache and token-security design.

### Existing Mounts Are Few Enough For A Clean Break

The in-repo production mounts are Fuji, Honeycrisp, Opensidian, Zhongwen, and
Tab Manager, plus examples and fixtures. They already call `defineMount`, and
the workspace-backed mounts all consume `ctx.keyring` or
`attachProjectInfrastructure`.

Implication: adding a required `kind` is a finite migration. Do not keep a
fallback "missing kind means collaborative" parser unless external compatibility
becomes the explicit release goal.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Startup product state | 2 coherence | Sanction signed-out daemon startup only for all-local projects | This follows the action-first runtime thesis without weakening collaborative startup guarantees. |
| Mount declaration | 2 coherence | Add a required static `kind` discriminant | `openEpicenterRoot` needs to decide before calling `open(ctx)`, and TypeScript can prevent local mounts from reaching auth fields. |
| Auth loading | 2 coherence | Replace eager `auth` with a lazy auth loader at the `openEpicenterRoot` boundary | Config import and mount-kind inspection must happen before auth construction. |
| Mixed projects | 2 coherence | Refuse the entire daemon when signed-out and any mount is collaborative | One daemon serves one project. Partial startup creates a new half-online state. |
| Local storage posture | 3 taste | Do not solve source-mirror encryption in this spec | Local mirrors are not Yjs workspaces. Future Gmail or finance specs can choose provider-token and local-cache security explicitly. |
| Compatibility | 2 coherence | No missing-kind fallback | The codebase is still in a clean-break phase, and a fallback would preserve two mount shapes forever. |
| Command surface | 2 coherence | Keep `epicenter run`, no `epicenter mirror` command | Source mirrors are actions served by daemon mounts. A new verb would create a second product sentence. |

## Architecture

### Type Shape

```ts
type BaseMountContext = {
  epicenterRoot: EpicenterRoot;
  mount: string;
};

type CollaborativeMountContext = BaseMountContext & {
  yDocClientId: number;
  deviceId: DeviceId;
  ownerId: OwnerId;
  keyring: () => Keyring;
  openWebSocket: OpenWebSocketFn;
  onReconnectSignal: OnReconnectSignal;
  fetch: AuthedFetch;
};

type LocalDaemonRuntime<TActions extends ActionRegistry = ActionRegistry> = {
  readonly actions: TActions;
  readonly collaboration?: never;
  [Symbol.asyncDispose](): MaybePromise<void>;
};

type CollaborativeDaemonRuntime<
  TActions extends ActionRegistry = ActionRegistry,
> = DaemonRuntime<TActions> & {
  readonly collaboration: DaemonServedCollaboration;
};

type LocalMount<TRuntime extends LocalDaemonRuntime = LocalDaemonRuntime> = {
  name: string;
  kind: 'local';
  open(ctx: BaseMountContext): MaybePromise<TRuntime>;
};

type CollaborativeMount<
  TRuntime extends CollaborativeDaemonRuntime = CollaborativeDaemonRuntime,
> = {
  name: string;
  kind: 'collaborative';
  open(ctx: CollaborativeMountContext): MaybePromise<TRuntime>;
};

type Mount = LocalMount | CollaborativeMount;
```

The exact exported names can change during implementation, but the split should
stay structural:

```txt
BaseMountContext
  epicenterRoot
  mount

CollaborativeMountContext
  BaseMountContext
  yDocClientId
  deviceId
  ownerId
  keyring
  openWebSocket
  onReconnectSignal
  fetch
```

`DaemonServedCollaboration` should remain the narrowed daemon-side peer and
sync surface from the action-first runtime work. A full `Collaboration<TActions>`
can still flow through structurally when a workspace mount returns it, but the
daemon contract should not make `collaboration.actions` the action source again.

### Startup Flow

```txt
runUp
  -> claim daemon lease
  -> openEpicenterRoot({ epicenterRoot, loadAuth })
       -> load epicenter.config.ts
       -> validate mount names
       -> split mounts by kind
       -> if collaborative mounts exist:
            load auth
            if null or signed-out:
              return MountAuthRequired(collaborative mount names)
       -> open every mount with the matching context
       -> dispose opened runtimes if any sibling fails
  -> start daemon server
  -> write metadata
```

### Auth Loader Shape

`@epicenter/workspace` should stay independent from `@epicenter/auth`, so the
auth loader must be generic over the host error type.

```ts
type LoadWorkspaceAuth<TAuthError> = () => Promise<
  Result<WorkspaceAuthClient | null, TAuthError>
>;

type OpenEpicenterRootOptions<TAuthError = never> = {
  epicenterRoot: EpicenterRoot | string;
  loadAuth?: LoadWorkspaceAuth<TAuthError>;
};
```

`null` means "no saved Epicenter auth." `runUp` maps
`MachineAuthStorageError.NoSavedSession` to `Ok(null)` and lets every other auth
storage error propagate. `NoSavedSession` is the canonical
`MachineAuthStorageError` variant name in
`packages/auth/src/node/machine-auth.ts`.

If `loadAuth` is omitted, `openEpicenterRoot` treats it as
`async () => Ok(null)`. This collapses "no loader" and "no saved session" into
one path instead of making a third startup branch.

After a non-null auth client is returned, `openEpicenterRoot` must still inspect
`auth.state.status`. A constructed client whose state is `signed-out` takes the
same `MountAuthRequired` path as `null`.

`SyncAuthClient` is structurally assignable to `WorkspaceAuthClient`: it carries
`state`, `openWebSocket`, `fetch`, and `onStateChange` plus extra methods the
workspace package does not read.

### Per-kind Open Branch

The main type-system risk is not the discriminant itself. It is the `open`
call. A union of mounts cannot be opened with one context object. `openEpicenterRoot`
needs an explicit `kind` branch so TypeScript narrows both the mount and the
context.

```ts
async function openOneMount({
  mount,
  epicenterRoot,
  auth,
}: {
  mount: Mount;
  epicenterRoot: EpicenterRoot;
  auth: WorkspaceAuthClient | null;
}): Promise<Result<StartedMount, WorkspaceAppError>> {
  const base = {
    epicenterRoot,
    mount: mount.name,
  } satisfies BaseMountContext;

  try {
    if (mount.kind === 'local') {
      const runtime = await mount.open(base);
      return Ok({ mount: mount.name, runtime });
    }

    const signedIn = requireMountAuth({
      auth,
      mounts: [mount.name],
    });
    if (signedIn.error) return signedIn;

    const runtime = await mount.open({
      ...base,
      yDocClientId: hashYDocClientId(epicenterRoot),
      deviceId: asDeviceId(`${mount.name}-daemon`),
      ownerId: signedIn.data.state.ownerId,
      keyring: createMountKeyringReader({ auth: signedIn.data, mount: mount.name }),
      openWebSocket: signedIn.data.openWebSocket,
      fetch: signedIn.data.fetch,
      onReconnectSignal: signedIn.data.onStateChange,
    });
    return Ok({ mount: mount.name, runtime });
  } catch (cause) {
    return WorkspaceAppError.MountOpenFailed({ mount: mount.name, cause });
  }
}
```

The helper names are illustrative. The implementation should keep
`auth.state.status` narrowed to signed-in before reading `ownerId` or
`keyring`.

`StartedMount` already tolerates local runtimes because `DaemonRuntime` now has
optional `collaboration`.

## Call Sites: Before And After

### Fuji Project Mount

Before (`apps/fuji/src/lib/workspace/project.ts:48`):

```ts
return defineMount({
  name: 'fuji',
  open(ctx) {
    const {
      epicenterRoot,
      mount,
      yDocClientId,
      deviceId,
      ownerId,
      keyring,
      openWebSocket,
      onReconnectSignal,
      fetch,
    } = ctx;
  },
});
```

After:

```ts
return defineMount({
  name: 'fuji',
  kind: 'collaborative',
  open(ctx) {
    const {
      epicenterRoot,
      mount,
      yDocClientId,
      deviceId,
      ownerId,
      keyring,
      openWebSocket,
      onReconnectSignal,
      fetch,
    } = ctx;
  },
});
```

Semantic shift: Fuji remains auth-required. The change is declaration, not
behavior.

### Local Source Mirror

Before:

```ts
export default defineMount({
  name: 'mirror',
  open() {
    return {
      actions,
      async [Symbol.asyncDispose]() {},
    };
  },
});
```

After:

```ts
export default defineMount({
  name: 'mirror',
  kind: 'local',
  open(ctx) {
    const dbPath = join(ctx.epicenterRoot, '.epicenter', 'mirrors', ctx.mount);
    return {
      actions,
      async [Symbol.asyncDispose]() {},
    };
  },
});
```

Semantic shift: `ctx.keyring`, `ctx.ownerId`, `ctx.openWebSocket`, `ctx.fetch`,
`ctx.onReconnectSignal`, `ctx.yDocClientId`, and `ctx.deviceId` do not exist in
a local mount.

### Daemon Startup

Before (`packages/cli/src/commands/up.ts:135`):

```ts
const createAuthClient = options.createAuthClient ?? createMachineAuthClient;
const authResult = await createAuthClient();
if (authResult.error) return authResult;
const auth = authResult.data;
stack.defer(() => auth[Symbol.dispose]());

const startResult = await openEpicenterRoot({ epicenterRoot, auth });
```

After:

```ts
const createAuthClient = options.createAuthClient ?? createMachineAuthClient;
let auth: SyncAuthClient | null = null;

const startResult = await openEpicenterRoot({
  epicenterRoot,
  loadAuth: async () => {
    const authResult = await createAuthClient();
    if (authResult.error) {
      if (authResult.error.name === 'NoSavedSession') return Ok(null);
      return authResult;
    }
    auth = authResult.data;
    stack.defer(() => auth?.[Symbol.dispose]());
    return Ok(auth);
  },
});
```

Implementation can tighten this shape. The invariant is what matters:
`createAuthClient` is not called for all-local projects.

## Refusals

Product sentence:

```txt
A project daemon can start signed-out only when every configured mount declares
itself local-only and therefore receives no Epicenter sync, peer, or workspace
key capabilities.
```

Candidate refusal:

```txt
Partial startup for mixed projects.
```

Code family it deletes:

```txt
degraded daemon state
per-route mounted vs skipped checks
operator status language for half-online projects
metadata describing partial startup
tests for partial action listing and peer behavior
```

User loss:

```txt
A user cannot keep a local mirror in the same signed-out project as Fuji.
They can sign in, or move the local mirror to its own project.
```

Decision:

```txt
Refuse partial startup. One daemon serves one project, and resource isolation
between mounts is expressed by projects, not flags.
```

Also refuse:

- Pure lazy auth as the startup mechanism. Lazy keyring remains useful for late
  sign-out inside collaborative mounts, but startup must fail before the daemon
  claims it is online.
- Inferring local vs collaborative from the returned runtime. The decision must
  happen before `open(ctx)`.
- `epicenter mirror`. Source mirrors are actions under `epicenter run`.
- A local Yjs workspace workaround for Gmail or finance mirrors. If data is
  user-authored and collaborative, use a collaborative mount. If data is a
  provider mirror, choose explicit local storage in that integration spec.
- Dynamic upgrade or downgrade of a running daemon's mount kind on sign-in or
  sign-out. Mount kind is read at startup and changes only after restart.

## Implementation Plan

### Phase 1: Mount Contract

- [x] **1.1** Replace the single `MountContext` with base and collaborative
  contexts.
- [x] **1.2** Add required `kind: 'local' | 'collaborative'` to `Mount`.
- [x] **1.3** Make `defineMount` preserve the discriminated mount type.
- [x] **1.4** Add type coverage showing a local mount cannot read
  `ctx.keyring`, `ctx.ownerId`, `ctx.openWebSocket`, `ctx.fetch`,
  `ctx.onReconnectSignal`, `ctx.yDocClientId`, or `ctx.deviceId`.
- [x] **1.5** Update runtime config validation errors so a mount without `kind`
  is rejected with the new contract.

### Phase 2: Lazy Auth At openEpicenterRoot

- [x] **2.1** Change `openEpicenterRoot` to accept a lazy `loadAuth` callback instead
  of an eager auth client.
- [x] **2.2** Load config and validate mount names before calling `loadAuth`.
- [x] **2.3** Skip `loadAuth` entirely when every mount is local.
- [x] **2.4** When any mount is collaborative, call `loadAuth` once and build
  the collaborative context from the returned signed-in auth client.
- [x] **2.5** Return a structured project-auth-required error when auth is
  missing or signed-out, naming every collaborative mount.
- [x] **2.6** Preserve the existing late-sign-out keyring guard for
  collaborative mounts.

### Phase 3: CLI Startup

- [x] **3.1** Move auth construction behind the lazy `loadAuth` callback passed
  to `openEpicenterRoot`.
- [x] **3.2** Convert `MachineAuthStorageError.NoSavedSession` to `Ok(null)`
  inside the CLI callback.
- [x] **3.3** Preserve all other auth storage errors as real failures.
- [x] **3.4** Dispose the auth client only when it was actually constructed.

### Phase 4: Migrate Mounts And Fixtures

- [x] **4.1** Mark Fuji, Honeycrisp, Opensidian, Zhongwen, Tab Manager, and the
  cross-peer examples as `kind: 'collaborative'`.
- [x] **4.2** Mark local-only test fixtures as `kind: 'local'`.
- [x] **4.3** Update generated config examples to include `kind`.
- [x] **4.4** Grep for raw mount literals in tests and specs that should be
  updated or intentionally left historical.

### Phase 5: Verification

- [x] **5.1** `openEpicenterRoot` all-local project opens without calling
  `loadAuth`.
- [x] **5.2** `runUp` all-local project opens without calling
  `createAuthClient`; use a stub that throws if invoked.
- [x] **5.3** Collaborative signed-out startup returns
  `MountAuthRequired`, names every collaborative mount, opens no mount, and
  leaves no daemon socket or metadata.
- [x] **5.4** Saved-but-signed-out auth client takes the same
  `MountAuthRequired` path as missing auth.
- [x] **5.5** Mixed signed-out startup refuses the whole daemon before opening
  the local sibling.
- [x] **5.6** Signed-in mixed startup opens both local and collaborative mounts.
- [x] **5.7** Type coverage proves a local mount cannot read `ctx.keyring`,
  `ctx.ownerId`, `ctx.openWebSocket`, `ctx.fetch`, `ctx.onReconnectSignal`,
  `ctx.yDocClientId`, or `ctx.deviceId`.
- [x] **5.8** Runtime config validation rejects mount objects with no `kind`.
- [x] **5.9** Run `bun run --cwd packages/workspace typecheck`.
- [x] **5.10** Run `bun run --cwd packages/cli typecheck`.
- [x] **5.11** Run app typechecks for migrated mount packages where they are
  already green enough to be meaningful.

## Edge Cases

### All-local project with no saved session

1. Project config contains only `kind: 'local'` mounts.
2. `runUp` passes a `loadAuth` callback, but `openEpicenterRoot` never calls it.
3. Daemon starts, `list` and local `run` work, `peers` returns no peers.

### Collaborative project with no saved session

1. Project config contains at least one `kind: 'collaborative'` mount.
2. `openEpicenterRoot` calls `loadAuth`.
3. The CLI maps `NoSavedSession` to `Ok(null)`.
4. `openEpicenterRoot` returns `MountAuthRequired({ mounts })`.
5. `runUp` releases the lease and leaves no socket or metadata.

### Collaborative project with a constructed signed-out auth client

1. Project config contains at least one `kind: 'collaborative'` mount.
2. `loadAuth` returns a non-null auth client whose `state.status` is
   `signed-out`.
3. `openEpicenterRoot` treats it the same as missing auth and returns
   `MountAuthRequired({ mounts })`.
4. No mount opens.

### Mixed project while signed-out

1. Project config contains local and collaborative mounts.
2. `openEpicenterRoot` refuses the entire daemon.
3. No local sibling is left running.

This is intentional. If a user wants local mirrors while signed-out, those
mirrors belong in a local-only project.

### Late sign-out after collaborative startup

1. A collaborative daemon starts signed-in.
2. The user signs out while it is running.
3. The existing keyring closure still throws at the next encrypted write or
   registration site.

This spec does not make collaboration dynamically downgrade to local.

### Sign-in after a local-only daemon is running

The daemon does not dynamically upgrade local mounts. A local mount stays local
until the daemon restarts with a different config or a different mount kind.

## Open Questions

1. **Should the discriminant be named `kind` or `mode`?**
   Recommendation: use `kind`. It describes the mount's static shape. `mode`
   sounds runtime-switchable.

2. **Should local source mirrors provide their own encryption layer?**
   Recommendation: defer to each integration spec. Gmail and finance mirrors
   are sensitive, but forcing them through Epicenter workspace auth would
   confuse source-of-truth ownership. The right future primitive may be
   provider-token storage plus an optional local cache key, not Yjs.

3. **Should `createWorkspace` expose an explicit "plaintext user workspace"
   option?**
   Recommendation: no for this spec. Its current plaintext branch is documented
   for in-memory importers, tests, and benchmarks. A real user plaintext
   workspace would need its own product sentence.

## Adjacent Work

- Browser and app surfaces that still expose `collaboration.actions`: deferred.
  This spec is daemon startup and mount context only.
- Gmail, QuickBooks, Every, Arc, Rho: deferred. They should be local mounts
  with explicit source mirror storage choices.
- Provider OAuth and token storage for source mirrors: deferred. Do not smuggle
  it into workspace sync auth.
- `epicenter mirror`: refused for now. Use action names such as
  `gmail.sync`, `quickbooks.pull_transactions`, or `ledger.export`.

## Decisions Log

- Keep the `createWorkspace` plaintext branch as an internal/testing path.
  Constraint: removing it is outside this spec and it still serves importers,
  tests, and benchmarks.
  Revisit when: a product spec proposes real user plaintext Yjs workspaces.

## Success Criteria

- [x] All-local project startup does not construct machine auth.
- [x] All-local project startup works with no saved Epicenter session.
- [x] Collaborative signed-out startup refuses before any mount opens.
- [x] A constructed auth client whose state is `signed-out` takes the same
  refusal path as no saved Epicenter session.
- [x] Mixed signed-out startup refuses the whole project and disposes anything
  already opened if an implementation accident opens early.
- [x] Error text names the collaborative mounts that require auth.
- [x] Local mount `open(ctx)` has no auth-derived context fields at the type
  level.
- [x] Existing workspace-backed mounts remain signed-in-only and continue to
  expose collaboration.
- [x] No dedicated mirror command exists.

## References

- `specs/20260613T100235-action-first-daemon-runtime.md` - prior runtime output
  split and source mirror storage direction.
- `packages/workspace/src/daemon/define-mount.ts` - mount contract and context
  types.
- `packages/workspace/src/workspace-apps/open-project.ts` - config loading,
  auth gate, mount opening, and cleanup.
- `packages/cli/src/commands/up.ts` - daemon lifecycle and machine auth
  construction.
- `packages/workspace/src/workspace-apps/open-project.test.ts` - startup
  behavior and mount cleanup coverage.
- `packages/cli/src/commands/up.test.ts` - daemon startup lifecycle and auth
  construction seam.
- `docs/encryption.md` - current signed-in workspace encryption boundary.
- `packages/workspace/src/document/workspace.ts` - encrypted and plaintext
  workspace branches.
- `packages/workspace/src/document/materializer/sqlite/bun-sqlite.ts` - raw
  SQLite projection surface.
- `packages/workspace/src/document/materializer/markdown/export.ts` - readable
  Markdown projection surface.

## Review

**Completed**: 2026-06-14
**Branch**: codex/auth-optional-daemon-startup-spec

### What Landed

Mounts now declare `kind: 'local' | 'collaborative'`. Local mounts receive only
`epicenterRoot` and `mount`, while collaborative mounts receive the auth-derived
context and must return hosted collaboration.

`openEpicenterRoot` now loads project config first, validates mount names, then calls
the lazy auth loader only if at least one collaborative mount is configured.
`runUp` maps `MachineAuthStorageError.NoSavedSession` to `Ok(null)` and
preserves other machine-auth storage errors.

### Deviations and Discoveries

- The implementation names the base context `LocalMountContext` rather than
  `BaseMountContext`, because that is the public type local mount authors use.
- `CollaborativeDaemonRuntime` requires the full `Collaboration<TActions>` a
  workspace mount already returns. The daemon server still consumes the
  narrowed served shape through `DaemonServedMount`.
- Review found that typed local mounts were protected, but raw config files could
  still return `runtime.collaboration` from a local mount. The implementation now
  rejects that runtime shape and disposes it before startup succeeds.
- Review also called out two worthwhile test gaps, so the implementation added
  coverage for invalid collaborative mount names before auth loading and for
  collaborative mounts with no auth loader.
- The inline-actions CLI e2e fixture stays collaborative because it exposes peer
  fields and the e2e harness seeds machine auth.

### Verification

- `bun test packages/workspace/src/config/load-project-config.test.ts packages/workspace/src/workspace-apps/open-project.test.ts`
- `bun test packages/cli/src/commands/up.test.ts`
- `bun test packages/cli/test/e2e-up-cross-peer.test.ts`
- `bun run --cwd packages/workspace typecheck`
- `bun run --cwd packages/cli typecheck`
- `bun run --cwd apps/fuji typecheck`
- `bun run --cwd apps/honeycrisp typecheck`
- `bun run --cwd apps/opensidian typecheck`
- `bun run --cwd apps/tab-manager typecheck`
- `bun run --cwd apps/zhongwen typecheck`

### Follow-up Work

- Gmail, QuickBooks, Every, Arc, and Rho source mirrors still need their own
  specs for provider OAuth, local cache storage, and export format choices.
- Partial startup for mixed projects remains intentionally refused. Revisit only
  if a future product spec wants half-online daemons and accepts the extra
  operator state.
