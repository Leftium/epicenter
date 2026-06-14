# Action-first daemon runtime

**Date**: 2026-06-13
**Status**: Implemented
**Owner**: Epicenter maintainers

## One Sentence

Daemon-served runtimes expose `actions` as the required local capability, and
expose `collaboration` only when the mount participates in Yjs sync, peer
presence, and peer dispatch.

## Product Shape

Epicenter should be able to serve local-only integrations, such as a Gmail or
QuickBooks mirror, without pretending that every mount owns a collaborative Yjs
workspace. The daemon can still be the long-lived process that runs actions,
keeps projections fresh, and talks over the local socket. Collaboration becomes
one optional capability on that process, not the thing that makes a runtime
servable.

This gives source mirrors a clean first home:

```ts
return defineMount({
  name: 'gmail',
  open: async () => ({
    actions,
    [Symbol.asyncDispose]: async () => {
      await closeMirror();
    },
  }),
});
```

Those mounts can support:

```sh
epicenter list
epicenter run gmail.sync '{}'
epicenter run quickbooks.pull_transactions '{}'
```

They do not support:

```sh
epicenter peers
epicenter run gmail.sync '{}' --peer laptop
```

The second class requires collaboration because it is about remote peers, device
presence, and inbound dispatch over the shared workspace transport.

## Terminology Decision

Keep the field name `collaboration`.

It is still the right term for the optional capability because the existing
object represents more than storage. It owns device presence, sync status, peer
addressing, and peer dispatch. Renaming it to `sync`, `peer`, or `workspace`
would each hide part of what the object does.

The mistake is not the word. The mistake is threading collaboration through
surfaces that only need local actions. The target rule is:

| Capability | Required | Used by | Meaning |
| --- | --- | --- | --- |
| `runtime.actions` | Yes | `list`, local `run`, daemon route suggestions | The actions this mount serves on this machine. |
| `runtime.collaboration` | No | `peers`, `run --peer`, sync status logging | Optional Yjs-backed peer and sync capability. |

Do not make a second daemon kind. The daemon is still one local process with a
set of mounted runtimes. Each runtime advertises capabilities by shape:

```ts
type DaemonRuntime<TActions extends ActionRegistry = ActionRegistry> = {
  readonly actions: TActions;
  readonly collaboration?: DaemonServedCollaboration;
  [Symbol.asyncDispose](): MaybePromise<void>;
};
```

`DaemonServedCollaboration` should no longer be the action registry owner. It
may continue to expose `actions` on the public browser/workspace object if that
is useful for app code, but daemon code should not read actions through
`runtime.collaboration.actions`.

For the daemon socket app, the served narrowing should make that rule
structural:

```ts
type DaemonServedCollaboration = {
  devices: {
    list(): PresenceDevice[];
  };
  status: SyncStatus;
  dispatch(req: DispatchRequest): Promise<Result<unknown, DispatchError>>;
};

type DaemonServedMount<TActions extends ActionRegistry = ActionRegistry> = {
  mount: string;
  runtime: {
    actions: TActions;
    collaboration?: DaemonServedCollaboration;
  };
};
```

## Before

The current daemon contract makes Yjs collaboration mandatory:

```ts
type DaemonRuntime<TActions extends ActionRegistry = ActionRegistry> = {
  readonly collaboration: Collaboration<TActions>;
  [Symbol.asyncDispose](): MaybePromise<void>;
};
```

That means a local-only mirror has to either create fake collaboration or avoid
the daemon route entirely. Both options blur the source-of-truth story.

## After

The daemon can serve actions with or without collaboration:

```txt
workspace-backed mount
  actions
  collaboration
    devices
    status
    dispatch

local-only mirror
  actions
  no collaboration
```

Route behavior becomes simple:

| Route | Local-only mount | Collaborative mount |
| --- | --- | --- |
| `/list` | List actions | List actions |
| `/run` local | Run local action | Run local action |
| `/run` with peer | Usage error | Dispatch to peer |
| `/peers` | Skip mount | List peer devices |
| daemon status logs | No sync row | Sync row |

## Implementation Plan

- [x] Update daemon runtime types so `actions` is required and
  `collaboration` is optional.
- [x] Drop `actions` from the daemon-served collaboration narrowing so daemon
  code has exactly one action registry source.
- [x] Move daemon list, run, and suggestion paths to `runtime.actions`.
- [x] Guard peer dispatch so `run --peer` on a local-only mount returns a
  usage error instead of dereferencing optional collaboration.
- [x] Make `/peers` skip mounts that do not expose collaboration.
- [x] Make `epicenter daemon up` peer and sync logging skip local-only mounts.
- [x] Keep `attachProjectInfrastructure` returning the same action registry it
  receives, so workspace-backed mounts can spread the infrastructure result and
  satisfy the new runtime contract.
- [x] Update daemon and CLI tests for mixed collaborative plus local-only
  mounts.
- [x] Update project loading fixtures that synthesize runtime code.
- [x] Run focused workspace and CLI verification.
- [x] Consult Claude Code again after the implementation and run a
  post-implementation review.

## Test Plan

Add or adjust tests for:

- `list` includes actions from a mount without collaboration.
- Local `run` can execute an action from a mount without collaboration.
- `run --peer` against a mount without collaboration returns a usage error.
- `/peers` excludes local-only mounts while preserving collaborative peer rows.
- daemon up logging/subscription helpers tolerate mixed runtimes.
- generated project-loading fixtures include top-level `actions`.

Type-level coverage is useful if it is cheap:

- A daemon-served mount with `actions` and no `collaboration` should compile
  and work through `/list` plus local `/run`.
- A daemon-served mount with `collaboration` and no `actions` should fail in
  the daemon contract if there is a cheap local type-test home.

## Explicit Non-goal

This spec does not remove `daemon up` auth-client construction. Today `runUp`
constructs machine auth before opening mounts. That is acceptable for this
runtime-contract pass because the change is about what an opened mount can
serve. A later local-only project pass should decide whether a project with no
collaborative mounts can start without persisted sync auth.

## Deferred Work

This spec does not build Gmail, QuickBooks, Every, Arc, or Rho integrations.
It only creates the runtime slot they need.

It also does not add a dedicated `epicenter mirror` command. `epicenter run`
remains the action entry point. Future integrations can decide whether they want
actions named `sync`, `pull`, `import`, or `materialize`, but that is namespace
design inside each mount, not a new daemon command family.

## Source Mirror Direction

For local-only source mirrors, prefer this storage split:

- SQLite for durable cursor state, raw provider IDs, normalized projection
  tables, dedupe keys, and audit metadata.
- Files or plain text exports only when they are useful review artifacts.
- Plain text accounting files, such as Ledger, Beancount, or hledger journals,
  as generated review surfaces for finances, not the only raw source cache.
- No Yjs layer unless the data is genuinely collaborative and user-authored
  inside an Epicenter workspace.

That keeps the source of truth honest. QuickBooks, Gmail, or a bank provider
remains the upstream system. Epicenter stores enough local state to review,
query, diff, and ask agents questions, while avoiding bidirectional sync until a
specific product workflow earns it.
