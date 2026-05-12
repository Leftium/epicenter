# Composable Server, Cloud Apps, And App Instances

**Date**: 2026-05-12
**Status**: Draft, clean-break revision
**Author**: AI assisted
**Depends on**: `specs/20260511T150000-final-oauth-auth-architecture.md`
**Supersedes in part**: `specs/20260413T120000-server-authoritative-apps-wager-social.md`

## One Sentence

Epicenter Server is one batteries-included workspace host: auth, workspace
identity, sync, and document sync are the built-in core; Cloud Apps are
optional compile-time capabilities; App Instances are OAuth-protected hosted
islands of those Cloud Apps.

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

App Instance:
  A configured hosted instance of one Cloud App with its own host, OAuth audience, records, and operator policy.

Epicenter Cloud:
  Our hosted composition of Epicenter Server plus selected Cloud Apps and App Instances.

Third-party cloud:
  Another operator's composition of Epicenter Server plus the Cloud Apps and App Instances they choose.

Public record:
  Server-authoritative data owned by an App Instance, not by private workspace sync.

Integration:
  An explicit action that projects private workspace data into an App Instance.
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
  separate auth, sync, infra, or App Instance traffic only after the
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
| App Instance | A configured hosted instance of one Cloud App. Owns host, OAuth audience, records, and operator policy. Product docs may call this a network when the instance is public and social. | `ark.epicenter.so`, `ark.alice.com` |
| Record | A canonical public or shared object owned by one App Instance. | post, comment, reaction, wager, ledger entry |
| Integration | A user action that moves or projects private workspace data into an App Instance. | "Post this presentation to Ark" |

The important correction is this:

```txt
Epicenter Server includes the private workspace core.
Cloud Apps are optional registered capabilities.
Operators configure App Instances.
App Instances own public records.
App Instances are OAuth protected resources.
Cloud Apps are not.
```

Do not say "Cloud owns Ark" as if Cloud is one fixed product bundle. Ark is a
Cloud App. `ark.epicenter.so` is one App Instance. The OAuth resource boundary
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
  App Instances    = operator-configured resources for product Cloud Apps
```

The older server-authoritative apps spec has the right product instinct but the
wrong current boundary. It says Betcha and Ark are first-party apps with direct
schema access under `apps/api`. That predates the Cloud App and App Instance
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
    App Instances

Epicenter Cloud
  composes:
    Epicenter Server core
    ark, betcha, billing, assets, dashboard
  configures:
    ark.epicenter.so
    betcha.epicenter.so
  gets:
    canonical hosted ecosystem

Alice Cloud
  composes:
    Epicenter Server core
    ark
  configures:
    ark.alice.com
  gets:
    her own Ark App Instance

Company Cloud
  composes:
    Epicenter Server core
    betcha
  configures:
    betcha.company.com
  gets:
    private or public company Betcha App Instance
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
|   ark                                                        |
|   betcha                                                     |
|   billing                                                    |
|   assets                                                     |
|   dashboard                                                  |
|                                                              |
| operator App Instances:                                      |
|   ark.epicenter.so                                           |
|   betcha.epicenter.so                                        |
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
|   createEpicenterServer({ origin, apps, appInstances })      |
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
| optional infrastructure Cloud Apps:                          |
|   billing, assets, dashboard                                 |
|                                                              |
| optional product Cloud Apps:                                 |
|   ark, betcha                                                |
+--------------------------------------------------------------+
                       |
                       | operator configures instances for
                       | enabled product Cloud Apps
                       v
+--------------------------------------------------------------+
| App Instances                                                 |
|                                                              |
|   ark.epicenter.so       app: ark,    operator: Epicenter     |
|   betcha.epicenter.so    app: betcha, operator: Epicenter     |
|   ark.alice.com          app: ark,    operator: Alice         |
|                                                              |
| each instance publishes:                                     |
|   /.well-known/oauth-protected-resource                      |
|   token audience = instance host                             |
|   scopes scoped to the Cloud App                             |
+--------------------------------------------------------------+
```

### Server Origin And App Instance Origins

Default origin:

```txt
epicenter.so
  /auth/*
  /workspace-identity
  /workspaces/*
  /documents/*
  /cloud/billing/*
```

App Instance origin:

```txt
ark.epicenter.so
  /api/ark/*
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

api.epicenter.so
  /cloud/billing/*
  /cloud/assets/*
  /dashboard/*

ark.epicenter.so
  /api/ark/*
```

The first implementation should support one Epicenter Server origin plus App
Instance origins. Splitting auth, sync, and API traffic across separate origins
is deferred. It is not the conceptual model and should not appear as config
until operations prove it is needed.

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
   Audience: selected App Instance resource
   Scope: ark:publish

4. Presenter sends a post input.
   POST {instance}/api/ark/posts

5. Ark App Instance stores the public record.
   Owner: selected App Instance
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
  moderated by App Instance policy
  served by the Cloud App instance
```

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Keep the server core built in | 2 coherence | `createEpicenterServer` always includes auth, workspace identity, workspace sync, and document sync | These capabilities are the substrate, not optional peers of Ark or Betcha. |
| Unify the composition primitive | 2 coherence | One `createEpicenterServer` shape registers optional Cloud Apps and App Instances | Operators should not need a second architecture concept to add public app capabilities. |
| Keep capability boundaries sharp | 2 coherence | Server core does not own public records | Social feeds, public records, moderation, and shared relational state are not workspace sync. |
| Prefer one origin by default | 3 taste | Auth, sync, and host infrastructure live at the server origin unless overridden | A small install should be one origin; hosted Epicenter can split by domain, worker, or service for scaling and blast radius. |
| Make Cloud app-based | 2 coherence | Cloud Apps are compile-time modules registered by the host | Operators should not be forced to run Ark, Betcha, billing, assets, and dashboard as one bundle. |
| Make App Instance first-class | 2 coherence | App Instance owns public records | A public URL needs one authoritative host for moderation, deletion, feeds, and policy. |
| Treat Epicenter Cloud as a composition | 2 coherence | Canonical hosted ecosystem, not the platform itself | Other operators can host their own ecosystems without becoming Epicenter-the-company. |
| Copy Better Auth's composition shape, not runtime installation | 2 coherence | Cloud Apps are package imports registered at build time | Package imports give developers extension points without a runtime marketplace, dynamic schema mutation, or unknown code loading. |
| Islands by design | 2 coherence | App Instances do not federate | Federation is a large protocol and moderation commitment for zero shipped users. Self-hostable islands give operators full control without an instance-to-instance protocol. If federation ever ships, it gets its own architecture spec. |
| Keep integrations explicit | 2 coherence | Publish actions move private drafts into selected App Instances | Private workspace data should not become public by ambient sync. |
| License server-hosted Cloud Apps with network-copyleft intent | Deferred | Legal review required | The current AGPL pattern likely fits hosted server software, but final license wording is outside this architecture spec. |

## Boundary Rules

Use these rules before adding a route, table, or Cloud App.

```txt
If it is private workspace boot, workspace sync, or document sync:
  server core

If it is a public or shared social object:
  product Cloud App served through an App Instance

If it needs moderation, feed ranking, public URLs, counters, or abuse controls:
  product Cloud App served through an App Instance

If it is host infrastructure that operators run but users do not publish
records to:
  infrastructure Cloud App

If it is a private draft or artifact before publishing:
  workspace document

If it is the canonical public version after publishing:
  App Instance record
```

Two flavors of Cloud App, one composition rule:

```txt
Product app:
  owns public routes, schema, migrations, scopes, policy
  optional typed clients and UI entrypoints
  examples: ark, betcha
  resource origin: per-instance host
  scope namespace: <app>:*

Infrastructure app:
  serves the operator's host directly
  no public App Instance
  examples: billing, assets, dashboard
  resource origin: server host or configured infra host
  scope namespace: cloud:*
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
|   |-- ark/                       (product Cloud App)
|   |   |-- index.ts               (exports arkApp)
|   |   |-- routes.ts
|   |   |-- schema.ts
|   |   |-- migrations/
|   |   |-- scopes.ts
|   |   |-- policy.ts
|   |   `-- client.ts              (optional typed client helper)
|   |-- betcha/                    (product Cloud App)
|   |-- billing/                   (infrastructure Cloud App)
|   |-- assets/                    (infrastructure Cloud App)
|   `-- dashboard/                 (infrastructure Cloud App)
|-- app-instances/
|   |-- app-instance.ts
|   |-- instance-registry.ts
|   `-- host-dispatch.ts
|-- oauth-resource.ts
`-- db/
    `-- schema.ts                  (re-exports enabled Cloud App schemas)
```

The private workspace core lives under `core/` because it is part of the
Epicenter Server contract. Cloud Apps live under `cloud-apps/` because they are
compile-time server capabilities. They contribute routes, schemas, migrations,
scopes, policies, and optional typed client helpers. App Instances live under
`app-instances/` because operators configure them per deployment. The code
primitive is App Instance; product docs may call public social instances
"networks."

App registration should avoid repeating the same app in two places. The host
registers Cloud Apps once. App Instances refer to the registered app by stable
ID.

```ts
export default createEpicenterServer({
	origin: 'https://epicenter.so',
	apps: [
		arkApp,
		billingApp,
		dashboardApp,
	],
	appInstances: [
		{
			id: 'epicenter-ark',
			host: 'ark.epicenter.so',
			app: 'ark',
			name: 'Ark',
			visibility: 'public',
		},
	],
});
```

`audience` is derived as `https://<host>`. `issuer` is derived from the server
`origin`. Do not add override fields until a real deployment needs them.

The instance object uses `app: 'ark'` instead of `arkApp.instance(...)` because
the host should register each Cloud App once. Repeating the value object in both
`apps: [arkApp]` and `arkApp.instance(...)` makes the call site look fluent, but
it gives TypeScript two paths for the same ownership relationship. The stable
ID is the boundary:

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
	appInstances: [
		{
			app: 'ark',
			host: 'ark.epicenter.so',
		},
	],
});
```

A fluent builder remains possible, but it should be a convenience over the same
data model, not the model itself.

```ts
export default createEpicenterServer({ origin: 'https://epicenter.so' })
	.withApp(arkApp)
	.withAppInstance({
		app: 'ark',
		host: 'ark.epicenter.so',
	});
```

Prefer the object form first. It serializes cleanly, is easier to diff, and
lets construction tests validate the whole graph at once.

Start with normal Drizzle migration ownership. Each Cloud App exports schema
and migrations; the host imports enabled app schemas into one schema entrypoint
and runs the ordinary migration pipeline. A future `cloud generate` command can
scan `createEpicenterServer({ apps })` only after manual schema
composition becomes painful.

## OAuth And Scopes

### Resource Discovery Per App Instance

Each App Instance is its own OAuth protected resource. This closes the loop
with the auth north star: tokens are audience-bound, and the audience is the
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

Infrastructure Cloud Apps (billing, assets, dashboard) share the operator's
server or infra host as their resource and use the `cloud:*` scope namespace.
They do not publish per-app protected-resource metadata unless they later need
their own host-level resource boundary.

```txt
Resource summary:

  epicenter.so               server core             scope: workspaces:open
  epicenter.so               infrastructure apps     scope: cloud:billing, cloud:storage
  ark.epicenter.so           Cloud App ark           scope: ark:read, ark:publish
  betcha.epicenter.so        Cloud App betcha        scope: betcha:read, betcha:write
  ark.alice.com              Cloud App ark           scope: ark:read, ark:publish
```

### Cloud App Scopes

Sync scopes and App Instance scopes are separate.

```txt
workspaces:open
  resource: sync resource
  permits: workspace identity and sync

ark:read
  resource: Ark App Instance
  permits: read user-visible posts and profiles

ark:publish
  resource: Ark App Instance
  permits: create public records

betcha:read
  resource: Betcha App Instance
  permits: read visible challenges and ledgers

betcha:write
  resource: Betcha App Instance
  permits: create and update challenges
```

If one app needs both private sync and instance publishing, it requests separate
resource grants.

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
hosts return 404. App Instances cannot exist for apps that were not registered.

```ts
const server = createEpicenterServer({
	origin: 'https://epicenter.test',
	apps: [arkApp],
	appInstances: [
		{
			app: 'ark',
			host: 'ark.epicenter.test',
		},
	],
});
```

Construction tests:

```txt
server boots with built-in core
duplicate app IDs are rejected
duplicate hosts are rejected
duplicate audiences are rejected
App Instance for missing app is rejected
App Instance for disabled app is rejected
```

Host dispatch tests:

```txt
epicenter.test + /auth/* routes to auth
epicenter.test + /workspaces/* routes to workspace sync
epicenter.test + /cloud/billing/* routes to billing when billing is enabled
ark.epicenter.test + /api/ark/* routes to Ark instance
unknown.epicenter.test returns 404
ark.epicenter.test + /workspaces/* returns 404
```

OAuth boundary tests:

```txt
sync token cannot publish to Ark
Ark token cannot open private workspaces
Ark token for ark.alice.test cannot call ark.epicenter.test
disabled Cloud App exposes no routes
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

- [x] **1.1** Mark the older Betcha/Ark server-authoritative spec as historical where it conflicts with Cloud Apps and App Instances.
- [x] **1.2** Update the final OAuth architecture so deployable split is physical topology, not the core product model.
- [x] **1.3** Update the auth stack map so the Cloud product north star is the composable server model.
- [ ] **1.4** Update README or positioning only after the vocabulary survives one implementation pass.

### Phase 2: Composition Skeleton

- [ ] **2.1** Define `createEpicenterServer({ origin, apps, appInstances })` with built-in auth, workspace identity, workspace sync, and document sync.
- [ ] **2.2** Define a `CloudApp` shape with route mounting, schema, migrations, scopes, policy, and optional typed clients.
- [ ] **2.3** Define an `AppInstance` shape with `id`, `host`, `app`, `name`, and visibility.
- [ ] **2.4** Derive `audience` from `host` and `issuer` from `origin`.
- [ ] **2.5** Add exact host dispatch for the server origin and App Instance hosts.
- [ ] **2.6** Add tests proving disabled Cloud Apps expose no routes.
- [ ] **2.7** Add tests proving an App Instance cannot reference a missing or disabled Cloud App.
- [ ] **2.8** Re-export enabled Cloud App schemas through the host Drizzle schema entrypoint.

### Phase 3: First Product Cloud App

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

App Instances are islands. `ark.alice.com` and `ark.epicenter.so` do not talk
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

- [ ] **5.1** Keep public read APIs stable per App Instance.
- [ ] **5.2** Keep handles unique within an App Instance host only.
- [ ] **5.3** Do not add cross-instance link, follow, or identity primitives.

## Open Questions

1. Should the first implementation directory be `apps/server`, `apps/epicenter-server`, or a package consumed by a thin app wrapper?
2. Does a third-party cloud need its own OAuth issuer, or can it trust a separate issuer controlled by the same operator?
3. Should one server host many App Instances for the same Cloud App at first, or should that wait until one App Instance works end to end?

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
```

## Clean Break Rules

1. Do not make `apps/server` and `apps/cloud` separate conceptual platforms.
2. Do not put social feeds, public posts, or wager ledgers in base sync modules.
3. Do not let private workspace sync imply public publishing.
4. Do not make Epicenter Cloud synonymous with the Epicenter Platform.
5. Do not force every operator to run every Cloud App.
6. Do not design federation. App Instances are islands. If federation ever ships, it gets its own architecture spec.
7. Do not make first-party Cloud Apps bypass the same OAuth resource boundary that third-party integrations use.
8. Do not runtime-install unknown Cloud Apps. Package imports plus compile-time registration are the extension model.
9. Do not put instance hostnames, tenant IDs, or record IDs into scope names. Use audience for the instance and policy for record-level authorization.
10. Do not let a sync token publish to an App Instance. Do not let an instance token open private workspaces. Do not let one App Instance's token act on another App Instance.
