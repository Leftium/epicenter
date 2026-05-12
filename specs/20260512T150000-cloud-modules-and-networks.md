# Composable Server, Cloud Apps, And Instances

**Date**: 2026-05-12
**Status**: Draft, clean-break revision
**Author**: AI assisted
**Depends on**: `specs/20260511T150000-final-oauth-auth-architecture.md`
**Supersedes in part**: `specs/20260413T120000-server-authoritative-apps-wager-social.md`

## One Sentence

Epicenter Server hosts private workspaces at one origin, plus any number of
Cloud Apps mounted at their own OAuth-protected hosts.

## One Sentence Summaries

```txt
Epicenter Platform:
  The codebase, packages, protocols, and deployable shapes.

Epicenter Server:
  The composable host with built-in private workspace core and optional Cloud Apps.

Server core:
  Built-in auth, /workspace-identity, workspace sync, and document sync.

Cloud App:
  A compile-time server module that owns routes, schema, migrations, scopes, and policy.

Instance:
  A configured mount of one Cloud App at one host, owning that host's OAuth audience, records, and operator policy.

Epicenter Cloud:
  Our hosted composition of Epicenter Server plus selected Cloud Apps and instances.

Third-party cloud:
  Another operator's composition of Epicenter Server plus the Cloud Apps and instances they choose.

Public record:
  Server-authoritative data owned by an instance, not by private workspace sync.

Integration:
  An explicit action that projects private workspace data into an instance.
```

## Overview

This spec defines the product boundary above the private workspace runtime. The
important revision is that `server` and `cloud` are capability families, not
necessarily separate deployables. Epicenter Server includes the private
workspace core by default. Operators may also register Cloud Apps such as Ark,
Betcha, billing, assets, and dashboard.

Physical deployment can split later, but the first model is consolidated:

```txt
One process:
  auth + workspace sync + cloud infra + Ark + Betcha

Deferred split:
  separate auth, sync, infra, or instance traffic only after the
  single-origin server model works

Same architecture:
  one composition model
  separate OAuth resource boundaries
  optional Cloud Apps
```

The product sentence survives either topology:

```txt
Epicenter is the platform.
Epicenter Server is the composable host.
Epicenter Cloud is our hosted composition.
Other operators can run their own compositions.
```

## Vocabulary

| Term | Meaning | Example |
| --- | --- | --- |
| Platform | The Epicenter codebase, protocols, packages, and deployable shapes. | `@epicenter/workspace`, `@epicenter/auth`, `@epicenter/sync` |
| Epicenter Server | A composable host with built-in private workspace core and optional Cloud Apps. | self-hosted server, Epicenter Cloud host |
| Server core | Always-available private workspace capability built into Epicenter Server. | auth, `/workspace-identity`, workspace sync, document sync |
| Cloud App | A compile-time server module. Owns routes, schema, migrations, scopes, policy, and optional client helpers or UI entrypoints. | Ark, Betcha, billing, assets |
| Instance | A configured mount of one Cloud App at one host. Owns that host's OAuth audience, records, and operator policy. Product docs may call this a network when the instance is public and social. | `ark.epicenter.so`, `billing.epicenter.so`, `ark.alice.com` |
| Record | A canonical public or shared object owned by one instance. | post, comment, reaction, wager, ledger entry |
| Integration | A user action that moves or projects private workspace data into an instance. | "Post this presentation to Ark" |

The important correction is this:

```txt
Epicenter Server includes the private workspace core.
Cloud Apps are optional registered capabilities.
Operators configure instances.
Instances own public records.
Instances are OAuth protected resources.
Cloud Apps are not.
```

Do not say "Cloud owns Ark" as if Cloud is one fixed product bundle. Ark is a
Cloud App. `ark.epicenter.so` is one instance. The OAuth resource boundary
(audience, scope, discovery) lives at the instance host, not at a generic
cloud deployable.

## Current State

The final OAuth architecture spec had the right resource contract but an overly
fixed deployable story:

```txt
Earlier wording:
  apps/server = self-hostable auth and sync runtime
  apps/cloud  = hosted control plane and Cloud Apps

Better wording:
  Epicenter Server = composable host
  server core      = built-in auth, identity, workspace sync, document sync
  Cloud Apps       = optional compile-time capabilities
  instances    = operator-configured mounts for each enabled Cloud App
```

The older server-authoritative apps spec has the right product instinct but the
wrong current boundary. It says Betcha and Ark are first-party apps with direct
schema access under `apps/api`. That predates the Cloud App and instance
vocabulary, and it predates the cleaner OAuth resource boundary.

## Desired State

Operators choose one composition model, then choose their physical deployment.

```txt
Bob
  composes:
    Epicenter Server core only
  gets:
    private workspace auth and sync
  does not configure:
    instances

Epicenter Cloud
  composes:
    Epicenter Server core
    ark, betcha, billing, assets, dashboard
  configures:
    ark.epicenter.so
    betcha.epicenter.so
    billing.epicenter.so
    assets.epicenter.so
    dashboard.epicenter.so
  gets:
    canonical hosted ecosystem

Alice Cloud
  composes:
    Epicenter Server core
    ark
  configures:
    ark.alice.com
  gets:
    her own Ark instance

Company Cloud
  composes:
    Epicenter Server core
    betcha
  configures:
    betcha.company.com
  gets:
    private or public company Betcha instance
```

One host can do all of this:

```txt
+--------------------------------------------------------------+
| createEpicenterServer({ ... })                               |
|                                                              |
| built-in core:                                               |
|   auth                                                       |
|   workspaceIdentity                                          |
|   workspaceSync                                              |
|   documentSync                                               |
|                                                              |
| optional Cloud Apps:                                         |
|   ark, betcha, billing, assets, dashboard                    |
|                                                              |
| operator instances:                                          |
|   ark.epicenter.so                                           |
|   betcha.epicenter.so                                        |
|   billing.epicenter.so                                       |
|   assets.epicenter.so                                        |
|   dashboard.epicenter.so                                     |
+--------------------------------------------------------------+
```

## Architecture

The capability graph is stable even when the process graph changes.

```txt
+--------------------------------------------------------------+
| Epicenter Platform                                            |
|                                                              |
| packages                                                     |
|   workspace, auth, sync, ui                                  |
|                                                              |
| host primitive                                               |
|   createEpicenterServer({ origin, apps, instances })         |
+--------------------------------------------------------------+
                       |
                       v
+--------------------------------------------------------------+
| Epicenter Server composition                                  |
|                                                              |
| built-in core:                                               |
|   sign-in, OAuth, /workspace-identity                        |
|   workspace sync, document sync                              |
|                                                              |
| optional Cloud Apps:                                         |
|   ark, betcha, billing, assets, dashboard                    |
+--------------------------------------------------------------+
                       |
                       | operator mounts one or more instances
                       | for each enabled Cloud App
                       v
+--------------------------------------------------------------+
| Instances                                                     |
|                                                              |
|   ark.epicenter.so       app: ark,      operator: Epicenter   |
|   betcha.epicenter.so    app: betcha,   operator: Epicenter   |
|   billing.epicenter.so   app: billing,  operator: Epicenter   |
|   ark.alice.com          app: ark,      operator: Alice       |
|                                                              |
| each instance publishes:                                     |
|   /.well-known/oauth-protected-resource                      |
|   token audience = instance host                             |
|   scopes scoped to the Cloud App                             |
+--------------------------------------------------------------+
```

### Server Origin And Instance Origins

Default origin:

```txt
epicenter.so
  /auth/*
  /workspace-identity
  /workspaces/*
  /documents/*
```

Instance origin:

```txt
ark.epicenter.so
  /api/ark/*
  /.well-known/oauth-protected-resource

billing.epicenter.so
  /api/billing/*
  /.well-known/oauth-protected-resource
```

Deferred split origins:

```txt
accounts.epicenter.so
  /auth/*

sync.epicenter.so
  /workspace-identity
  /workspaces/*
  /documents/*

ark.epicenter.so
  /api/ark/*

billing.epicenter.so
  /api/billing/*

assets.epicenter.so
  /api/assets/*

dashboard.epicenter.so
  /api/dashboard/*
```

The first implementation should support one Epicenter Server origin plus
instance origins. Splitting auth and sync across separate origins is deferred.
It is not the conceptual model and should not appear as config until operations
prove it is needed.

## Publish Flow

Example: Presenter posts to Ark.

```txt
1. User edits a presentation locally.
   Owner: workspace document
   Resource: sync host or self-hosted server resource

2. User clicks "Post to Ark."
   Owner: Presenter integration
   Resource choice: ark.epicenter.so, ark.alice.com, or another Ark instance

3. Auth gets an instance-scoped grant.
   Audience: selected instance resource
   Scope: ark:publish

4. Presenter sends a post input.
   POST {instance}/api/ark/posts

5. Ark instance stores the public record.
   Owner: selected instance
   Result: canonical public URL
```

The draft and the post are different objects.

```txt
Draft:
  private
  local-first
  editable in workspace
  synced by server core

Post:
  public or instance-visible
  server-authoritative
  moderated by instance policy
  served by the Cloud App instance
```

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Keep the server core built in | 2 coherence | `createEpicenterServer` always includes auth, workspace identity, workspace sync, and document sync | These capabilities are the substrate, not optional peers of Ark or Betcha. |
| Unify the composition primitive | 2 coherence | One `createEpicenterServer` shape registers optional Cloud Apps and instances | Operators should not need a second architecture concept to add public app capabilities. |
| Keep capability boundaries sharp | 2 coherence | Server core does not own public records | Social feeds, public records, moderation, and shared relational state are not workspace sync. |
| One kind of Cloud App | 2 coherence | Every Cloud App, whether public-record (ark, betcha) or operator-facing (billing, assets, dashboard), mounts at its own instance host with `<app-id>:*` scopes | A second flavor with `cloud:*` scopes and a shared-origin shortcut produced two scope namespaces, two mount stories, and a hybrid API. The asymmetric win: refusing the shortcut collapses both flavors into one uniform model with no user-visible loss except a DNS record per enabled operator app. |
| Server origin is sync-only | 3 taste | Auth, workspace identity, workspace sync, and document sync live at the server origin; no Cloud App mounts there | Origin sharing was the only thing that made "infrastructure Cloud App" a separate concept. Removing it removes the special case. |
| Make Cloud app-based | 2 coherence | Cloud Apps are compile-time modules registered by the host | Operators should not be forced to run Ark, Betcha, billing, assets, and dashboard as one bundle. |
| Make instances first-class | 2 coherence | Each instance owns its host, audience, and records | A public URL needs one authoritative host for moderation, deletion, feeds, and policy. |
| Derive instance type from registered apps | 2 coherence | `instances[].app` is typed as `apps[number]['id']` | A registered-but-missing-app reference becomes a compile-time error, not a startup-time check. Removes a class of runtime validation. |
| Object config only | 2 coherence | No fluent `.withApp().withInstance()` builder | A builder cannot deliver the same compile-time cross-check between `apps` and `instances[].app`, and a hybrid object+builder API forces every reader to ask which path is canonical. |
| Treat Epicenter Cloud as a composition | 2 coherence | Canonical hosted ecosystem, not the platform itself | Other operators can host their own ecosystems without becoming Epicenter-the-company. |
| Copy Better Auth's composition shape, not runtime installation | 2 coherence | Cloud Apps are package imports registered at build time | Package imports give developers extension points without a runtime marketplace, dynamic schema mutation, or unknown code loading. |
| Islands by design | 2 coherence | Instances do not federate | Federation is a large protocol and moderation commitment for zero shipped users. Self-hostable islands give operators full control without an instance-to-instance protocol. If federation ever ships, it gets its own architecture spec. |
| Keep integrations explicit | 2 coherence | Publish actions move private drafts into selected instances | Private workspace data should not become public by ambient sync. |
| License server-hosted Cloud Apps with network-copyleft intent | Deferred | Legal review required | The current AGPL pattern likely fits hosted server software, but final license wording is outside this architecture spec. |

## Boundary Rules

Use these rules before adding a route, table, or Cloud App.

```txt
If it is private workspace boot, workspace sync, or document sync:
  server core

If it is a public, shared, social, or operator-facing object served over HTTP:
  Cloud App mounted at its own instance host

If it needs moderation, feed ranking, public URLs, counters, or abuse controls:
  Cloud App mounted at its own instance host

If it is a private draft or artifact before publishing:
  workspace document

If it is the canonical public version after publishing:
  instance record
```

One kind of Cloud App, one composition rule:

```txt
Every Cloud App:
  owns routes, schema, migrations, scopes, policy
  optional typed clients and UI entrypoints
  mounts at one instance host
  resource origin: instance host
  scope namespace: <app-id>:*

Public-record apps (ark, betcha) and operator capabilities (billing,
assets, dashboard) follow the same composition rule. What differs is the
policy each Cloud App enforces on its records, not where it lives or how
it is named.
```

## Suggested File Shape

This is a target shape, not an immediate implementation command. The exact app
folder can be `apps/server` or a renamed host package. The important thing is
that the composition root is singular.

```txt
apps/server/src/
|-- app.ts
|-- create-epicenter-server.ts
|-- core/
|   |-- auth/
|   |-- workspace-identity/
|   |-- workspace-sync/
|   `-- document-sync/
|-- cloud-apps/
|   |-- ark/
|   |   |-- index.ts               (exports arkApp)
|   |   |-- routes.ts
|   |   |-- schema.ts
|   |   |-- migrations/
|   |   |-- scopes.ts
|   |   |-- policy.ts
|   |   `-- client.ts              (optional typed client helper)
|   |-- betcha/
|   |-- billing/
|   |-- assets/
|   `-- dashboard/
|-- instances/
|   |-- instance.ts
|   |-- instance-registry.ts
|   `-- host-dispatch.ts
|-- oauth-resource.ts
`-- db/
    `-- schema.ts                  (re-exports enabled Cloud App schemas)
```

The private workspace core lives under `core/` because it is part of the
Epicenter Server contract. Cloud Apps live under `cloud-apps/` because they are
compile-time server capabilities. They contribute routes, schemas, migrations,
scopes, policies, and optional typed client helpers. Instances live under
`instances/` because operators configure them per deployment. The code
primitive is instance; product docs may call public social instances
"networks."

App registration should avoid repeating the same app in two places. The host
registers Cloud Apps once. Instances refer to the registered app by stable ID.

```ts
export default createEpicenterServer({
	origin: 'https://epicenter.so',
	apps: [arkApp, billingApp, dashboardApp],
	instances: [
		{ app: 'ark',       host: 'ark.epicenter.so',       name: 'Ark' },
		{ app: 'billing',   host: 'billing.epicenter.so' },
		{ app: 'dashboard', host: 'dashboard.epicenter.so' },
	],
});
```

`audience` is derived as `https://<host>`. `issuer` is derived from the server
`origin`. Do not add override fields until a real deployment needs them.

The instance object uses `app: 'ark'` (string) instead of `arkApp.instance(...)`
because the host should register each Cloud App once. Repeating the value
object in both `apps: [arkApp]` and a fluent call would give TypeScript two
paths for the same ownership relationship. TypeScript can derive the valid app
IDs from the `apps` array so the string form is still type-checked:

```ts
function createEpicenterServer<const TApps extends readonly CloudApp[]>(config: {
	origin: `https://${string}`;
	apps: TApps;
	instances: ReadonlyArray<{
		app: TApps[number]['id'];   // literal union of registered IDs
		host: string;
		name?: string;
	}>;
}): EpicenterServer;
```

With this signature, "instance references an unregistered app" is a
compile-time error at the call site, not just a startup-time check.

```ts
export const arkApp = defineCloudApp({
	id: 'ark',
	routes: arkRoutes,
	schema: arkSchema,
	migrations: arkMigrations,
	scopes: ['ark:read', 'ark:publish'],
});

export default createEpicenterServer({
	origin: 'https://epicenter.so',
	apps: [arkApp],
	instances: [{ app: 'ark', host: 'ark.epicenter.so' }],
});
```

Object form only. A fluent `.withApp().withInstance()` builder is refused: it
cannot give the same compile-time cross-check that an instance's `app` field
references one of the registered `apps`, and a hybrid object+builder API
forces every reader to ask which path is canonical.

Start with normal Drizzle migration ownership. Each Cloud App exports schema
and migrations; the host imports enabled app schemas into one schema entrypoint
and runs the ordinary migration pipeline. A future `cloud generate` command can
scan `createEpicenterServer({ apps })` only after manual schema
composition becomes painful.

## OAuth And Scopes

### Resource Discovery Per Instance

Each instance is its own OAuth protected resource. This closes the loop with
the auth north star: tokens are audience-bound, and the audience is the
instance host, not the generic server host.

```txt
Per-instance requirements:

  https://<instance-host>/.well-known/oauth-protected-resource
    served by the host deployment for that instance
    declares the issuer this instance trusts
    declares the scopes this instance enforces

  token audience:
    aud = https://<instance-host>
    must not be substitutable for another instance's audience

  token scope:
    drawn from the owning Cloud App's scope namespace

  CORS:
    allowed origins are configured per instance, not per server composition
```

Every Cloud App publishes per-instance metadata. There is no shared-origin
shortcut: operator capabilities like billing and dashboard mount at their own
hosts and declare their own protected-resource metadata.

```txt
Resource summary:

  epicenter.so               server core             scope: workspaces:open
  ark.epicenter.so           Cloud App ark           scope: ark:read, ark:publish
  betcha.epicenter.so        Cloud App betcha        scope: betcha:read, betcha:write
  billing.epicenter.so       Cloud App billing       scope: billing:read, billing:admin
  dashboard.epicenter.so     Cloud App dashboard     scope: dashboard:read
  ark.alice.com              Cloud App ark           scope: ark:read, ark:publish
```

### Cloud App Scopes

Sync scopes and instance scopes are separate.

```txt
workspaces:open
  resource: sync resource (server origin)
  permits: workspace identity and sync

ark:read
  resource: Ark instance
  permits: read user-visible posts and profiles

ark:publish
  resource: Ark instance
  permits: create public records

betcha:read
  resource: Betcha instance
  permits: read visible challenges and ledgers

betcha:write
  resource: Betcha instance
  permits: create and update challenges

billing:read
  resource: Billing instance
  permits: read the operator's own subscription and usage state

billing:admin
  resource: Billing instance
  permits: change subscription, payment method, and plan
```

If one user-facing action needs both private sync and instance publishing, it
requests separate resource grants.

```txt
Presenter:
  sync grant:
    audience = epicenter.so
    scope = workspaces:open

  Ark grant:
    audience = ark.epicenter.so
    scope = ark:publish
```

Do not put hosts, tenant names, record IDs, or policy decisions in scope
strings. The instance belongs in `aud`. The coarse app capability belongs in
`scope`. Exact authorization belongs in route policy.

```txt
Good:
  aud = https://ark.alice.com
  scope = ark:publish

Bad:
  scope = ark.alice.com:publish
  scope = ark:alice:post:create
  scope = cloud:publish-anywhere
```

Do not let a workspace sync token publish to Ark. Do not let an Ark token open
private workspaces.

## Composition Tests

The first implementation should prove the graph with plain `Request` objects
before involving Cloudflare, DNS, or a browser. Host matching is exact. Unknown
hosts return 404. Instances cannot exist for apps that were not registered.

```ts
const server = createEpicenterServer({
	origin: 'https://epicenter.test',
	apps: [arkApp, billingApp],
	instances: [
		{ app: 'ark',     host: 'ark.epicenter.test' },
		{ app: 'billing', host: 'billing.epicenter.test' },
	],
});
```

Construction tests:

```txt
boots with core and zero apps
rejects duplicate apps[].id
rejects apps[].id that does not match /^[a-z][a-z0-9-]*$/
rejects any scope in apps[].scopes that does not start with <id>:
rejects overlapping scopes across registered apps
rejects instances[].app not present in apps
rejects duplicate instances[].host
rejects instances[].host equal to URL.host(origin)
rejects a registered app with no instance mount
rejects origin that is not https:// in production builds
```

Host dispatch tests:

```txt
epicenter.test + /auth/*                 routes to core auth
epicenter.test + /workspace-identity     routes to core identity
epicenter.test + /workspaces/*           routes to workspace sync
epicenter.test + /documents/*            routes to document sync
epicenter.test + /api/*                  returns 404 (no Cloud App at origin)
ark.epicenter.test + /api/ark/*          routes to Ark instance
billing.epicenter.test + /api/billing/*  routes to Billing instance
ark.epicenter.test + /.well-known/oauth-protected-resource returns 200
ark.epicenter.test + /workspaces/*       returns 404 (sync is not at instance hosts)
unknown.epicenter.test                   returns 404
```

OAuth boundary tests:

```txt
audience(sync grant) = URL.host(origin)
audience(app grant)  = URL.host(instance)
sync token cannot publish to any instance
Ark token cannot open private workspaces
Ark token for ark.alice.test cannot call ark.epicenter.test (same Cloud App, different instance)
billing token cannot call ark.epicenter.test
protected-resource metadata at instance host names issuer derived from server origin
```

## Licensing And Host Control

This is not legal advice. It is the product intent the license should support.

```txt
Open source code:
  people can inspect, modify, and host the software

Network copyleft intent:
  if someone modifies and hosts the server-side Cloud App software,
  their hosted users should be able to receive the source for those changes

Trademark and canonical host:
  the code can be open while the Epicenter name and official hosted networks
  remain controlled by Epicenter
```

The clean product distinction:

```txt
Epicenter Platform:
  open source software

Epicenter Cloud:
  official hosted composition and canonical ecosystem

Third-party Cloud:
  another operator's hosted composition or ecosystem
```

## Implementation Plan

This spec is not asking for code movement yet. It sets the vocabulary for a
later clean break.

### Phase 1: Spec Alignment

- [x] **1.1** Mark the older Betcha/Ark server-authoritative spec as historical where it conflicts with Cloud Apps and instances.
- [x] **1.2** Update the final OAuth architecture so deployable split is physical topology, not the core product model.
- [x] **1.3** Update the auth stack map so the Cloud product north star is the composable server model.
- [ ] **1.4** Update README or positioning only after the vocabulary survives one implementation pass.

### Phase 2: Composition Skeleton

- [ ] **2.1** Define `createEpicenterServer({ origin, apps, instances })` with built-in auth, workspace identity, workspace sync, and document sync.
- [ ] **2.2** Define a `CloudApp` shape with route mounting, schema, migrations, scopes, policy, and optional typed clients.
- [ ] **2.3** Define an `Instance` shape with `app`, `host`, and optional `name`.
- [ ] **2.4** Derive `audience` from `host` and `issuer` from `origin`.
- [ ] **2.5** Type `instances[].app` as `apps[number]['id']` so unregistered app references fail at compile time.
- [ ] **2.6** Add exact host dispatch for the server origin and instance hosts.
- [ ] **2.7** Add tests proving every registered Cloud App has at least one instance mount.
- [ ] **2.8** Add tests proving an instance cannot reference an unregistered app and cannot share the server origin host.
- [ ] **2.9** Re-export enabled Cloud App schemas through the host Drizzle schema entrypoint.

### Phase 3: First Cloud App (Ark)

- [ ] **3.1** Pick one Cloud App, likely Ark, as the first implementation.
- [ ] **3.2** Create minimal `post` and `profile` tables inside the Cloud App.
- [ ] **3.3** Add `ark:read` and `ark:publish` scope checks.
- [ ] **3.4** Add `POST /api/ark/posts` and `GET /api/ark/posts/:id`.
- [ ] **3.5** Add a typed client helper only after the route shape is proven.
- [ ] **3.6** Add a small publish integration from a workspace artifact only after the instance API is proven.

### Phase 4: Deferred Physical Split

Do not split deployables until composition works in one host. If operational
needs appear, split by mounting the same modules into more than one process or
Worker.

```txt
Reasons to split:
  different scaling profile
  separate secret set
  smaller blast radius
  domain-specific caching
  deployment cadence

Reasons not to split:
  self-hosted install complexity
  duplicated middleware
  two composition roots
  unclear ownership
```

- [ ] **4.1** Keep module registration independent of process topology.
- [ ] **4.2** Keep token audiences and protected-resource metadata stable across same-host and split-host deployments.
- [ ] **4.3** Add process-split adapters only after the single-host composition passes tests.

### Phase 5: Islands By Design

Instances are islands. `ark.alice.com` and `ark.epicenter.so` do not talk
to each other. Users on one instance do not follow users on another instance.
Posts, follows, reactions, and ledgers stay inside the instance where they were
published.

```txt
What islands give us:
  one less protocol to design and ship
  no inter-instance key trust to maintain
  no inter-instance moderation handshake
  no identity mapping problem
  each operator owns their instance policy completely

What islands cost users:
  cross-instance follow does not exist
  posting to N instances means N publish actions
  identity is per-instance
```

If federation ever becomes a product requirement, it gets its own architecture
spec. It is not a deferred phase of this one. The surfaces this spec leaves
(stable per-instance public APIs, audience-bound OAuth, canonical URLs per
record) keep that future spec possible without forcing this one to design for
it.

- [ ] **5.1** Keep public read APIs stable per instance.
- [ ] **5.2** Keep handles unique within an instance host only.
- [ ] **5.3** Do not add cross-instance link, follow, or identity primitives.

## Open Questions

1. Should the first implementation directory be `apps/server`, `apps/epicenter-server`, or a package consumed by a thin app wrapper?
2. Does a third-party cloud need its own OAuth issuer, or can it trust a separate issuer controlled by the same operator?

### Deferred

These are intentionally not open questions for this spec. They are listed so
future readers know they were considered and refused:

```txt
Federation API design:
  Status: deferred until real second-instance demand exists.
  Reason: islands by design.

License wording for Cloud Apps:
  Status: deferred to a separate licensing decision.
  Reason: product intent is recorded; legal review belongs outside this
  architecture spec.

Mandatory split between server and cloud deployables:
  Status: refused as the default architecture.
  Reason: topology is operational. Composition is the product model.

Two flavors of Cloud App (product vs infrastructure):
  Status: refused. Every Cloud App mounts at its own instance host with
  <app-id>:* scopes.
  Reason: two flavors produced two scope namespaces, two mount stories, and
  a hybrid API. Refusing the shared-origin shortcut for billing, assets, and
  dashboard collapses everything into one uniform model. Self-hosters who
  do not enable those apps pay nothing. Hosted operators who do enable them
  already wanted audience separation per subdomain.

Fluent builder API for createEpicenterServer:
  Status: refused. Object form only.
  Reason: a builder cannot deliver the same compile-time check that
  `instances[].app` references a registered `apps[].id`, and a hybrid
  object+builder API forces every reader to ask which path is canonical.

Multiple instances of the same Cloud App on one server:
  Status: deferred. v1 accepts one mount per app.
  Reason: no shipped use case. Add only when a real second mount appears,
  and document the policy boundary at that time.

The `id` and `visibility` fields on an instance object:
  Status: refused for v1.
  Reason: `host` already uniquely identifies an instance. A second
  identifier invites drift. `visibility` was ambiguous (does it change
  routes, indexability, OAuth, or just operator-dashboard chrome?) so it
  is owned by the Cloud App's policy until a real product reason forces
  it back into mount config.
```

## Clean Break Rules

1. Do not make `apps/server` and `apps/cloud` separate conceptual platforms.
2. Do not put social feeds, public posts, or wager ledgers in base sync modules.
3. Do not let private workspace sync imply public publishing.
4. Do not make Epicenter Cloud synonymous with the Epicenter Platform.
5. Do not force every operator to run every Cloud App.
6. Do not design federation. Instances are islands. If federation ever ships, it gets its own architecture spec.
7. Do not make first-party Cloud Apps bypass the same OAuth resource boundary that third-party integrations use.
8. Do not runtime-install unknown Cloud Apps. Package imports plus compile-time registration are the extension model.
9. Do not put instance hostnames, tenant IDs, or record IDs into scope names. Use audience for the instance and policy for record-level authorization.
10. Do not let a sync token publish to an instance. Do not let an instance token open private workspaces. Do not let one instance's token act on another instance.
11. Do not create two flavors of Cloud App. There is one Cloud App shape and one mount story. Operator-facing capabilities like billing and dashboard mount at their own instance hosts, just like product apps.
12. Do not mount a Cloud App at the server origin. The server origin serves core sync only; every Cloud App lives at its own instance host.
