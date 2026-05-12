# Cloud Apps And App Instances

**Date**: 2026-05-12
**Status**: Draft
**Author**: AI assisted
**Depends on**: `specs/20260511T150000-final-oauth-auth-architecture.md`
**Supersedes in part**: `specs/20260413T120000-server-authoritative-apps-wager-social.md`

## One Sentence

Epicenter Cloud is a compile-time host for Cloud Apps; each App Instance is
one OAuth-protected island of one Cloud App.

## Overview

This spec defines the product boundary above `apps/cloud`. `apps/server` stays
the private workspace auth and sync runtime. `apps/cloud` becomes a compile-time
host for server-authoritative Cloud Apps such as Ark and Betcha. Epicenter can
run the canonical hosted ecosystem, while other operators can host their own
ecosystems with the Cloud Apps they choose.

## Vocabulary

| Term | Meaning | Example |
| --- | --- | --- |
| Platform | The Epicenter codebase, protocols, packages, and deployable shapes. | `@epicenter/workspace`, `apps/server`, `apps/cloud` |
| Deployable | A built runtime an operator can host. | `apps/server`, `apps/cloud` |
| Cloud App | A compile-time server plugin inside Cloud. Owns routes, schema, migrations, scopes, policy, and optional client helpers or UI entrypoints. | Ark, Betcha, billing, assets |
| App Instance | A configured hosted instance of one Cloud App. Owns host, OAuth audience, records, and operator policy. Product-facing docs may call this a network when the instance is public and social. | `ark.epicenter.so`, `ark.alice.com` |
| Record | A canonical public object owned by one App Instance. | post, comment, reaction, wager, ledger entry |
| Integration | A user action that moves or projects private workspace data into an App Instance. | "Post this presentation to Ark" |

The important correction is this:

```txt
Cloud hosts Cloud Apps.
Operators configure App Instances.
App Instances own public records.
App Instances ARE OAuth protected resources.
Cloud Apps are not.
```

Do not say "Cloud owns Ark" as if Cloud is one fixed product bundle. Cloud is
the host. Ark is a Cloud App. `ark.epicenter.so` is one App Instance. The
OAuth resource boundary (audience, scope, discovery) lives at the instance
host, not at `apps/cloud` as a whole.

## Current State

The final OAuth architecture spec has the right deployable boundary:

```txt
apps/server
  self-hostable auth and sync runtime
  /workspace-identity
  /workspaces/*
  /documents/*
  no Postgres requirement

apps/cloud
  hosted control plane
  Drizzle and Postgres allowed
  billing
  assets
  dashboard
```

The older server-authoritative apps spec has the right instinct but the wrong
current boundary. It says Betcha and Ark are first-party apps with direct schema
access under `apps/api`. That predates the clearer `apps/server` and
`apps/cloud` split, and it predates the Cloud App and App Instance vocabulary.

## Desired State

Operators can choose how much Epicenter they host.

```txt
Bob
  runs:
    apps/server
  gets:
    private workspace auth and sync
  does not run:
    public App Instances

Epicenter Cloud
  runs:
    apps/server
    apps/cloud with ark, betcha, billing, assets, dashboard
  gets:
    canonical hosted ecosystem

Alice Cloud
  runs:
    apps/server
    apps/cloud with ark only
  gets:
    her own Ark App Instance at ark.alice.com

Company Cloud
  runs:
    apps/server
    apps/cloud with betcha only
  gets:
    private or public company Betcha App Instance
```

This preserves symmetry:

```txt
Epicenter is the platform.
Epicenter Cloud is our hosted instance.
Other people can run their own clouds and App Instances.
```

## Architecture

```txt
+--------------------------------------------------------------+
| Epicenter Platform                                            |
|                                                              |
| packages                                                     |
|   workspace, auth, sync, ui                                  |
|                                                              |
| deployables                                                  |
|   apps/server      private auth and sync                     |
|   apps/cloud       public Cloud Apps and hosted control plane |
+--------------------------------------------------------------+
                       |
                       v
+--------------------------------------------------------------+
| apps/server                                                  |
|                                                              |
| owns:                                                        |
|   sign-in, OAuth, /workspace-identity                        |
|   workspace sync, document sync                              |
|                                                              |
| records:                                                     |
|   private workspace data stays local-first                   |
+--------------------------------------------------------------+
                       |
                       | explicit publish or Cloud API call
                       v
+--------------------------------------------------------------+
| apps/cloud (one built deployable)                            |
|                                                              |
| product Cloud Apps (server-side app packages):               |
|   ark                                                        |
|   betcha                                                     |
|                                                              |
| infrastructure Cloud Apps (serve cloud host directly):        |
|   billing                                                    |
|   assets                                                     |
|   dashboard                                                  |
+--------------------------------------------------------------+
                       |
                       | operator picks which Cloud Apps ship
                       | and configures their App Instances
                       v
+--------------------------------------------------------------+
| App Instances (operator-configured OAuth resources)           |
|                                                              |
|   ark.epicenter.so       (app: ark,    host: cloud A)        |
|   betcha.epicenter.so    (app: betcha, host: cloud A)        |
|   ark.alice.com          (app: ark,    host: cloud B)        |
|                                                              |
| each instance publishes:                                     |
|   /.well-known/oauth-protected-resource                      |
|   token audience = instance host                             |
|   scopes scoped to the Cloud App (ark:*, betcha:*)           |
+--------------------------------------------------------------+
```

### Publish Flow

Example: Presenter posts to Ark.

```txt
1. User edits a presentation locally.
   Owner: workspace document
   Resource: sync.epicenter.so or self-hosted server

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
  synced by apps/server

Post:
  public or instance-visible
  server-authoritative
  moderated by App Instance policy
  served by apps/cloud
```

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Keep `apps/server` private-sync focused | 2 coherence | No Ark or Betcha in Server | Social feeds, public records, moderation, and shared relational state are not workspace sync. |
| Make Cloud app-based | 2 coherence | Cloud hosts compile-time Cloud Apps | Operators should not be forced to run Ark, Betcha, billing, and assets as one bundle. |
| Make App Instance first-class | 2 coherence | App Instance owns public records | A public URL needs one authoritative host for moderation, deletion, feeds, and policy. |
| Treat Epicenter Cloud as an instance | 2 coherence | Canonical hosted ecosystem, not the platform itself | Other operators can host their own ecosystems without becoming Epicenter-the-company. |
| Copy Better Auth's composition shape, not runtime installation | 2 coherence | Cloud Apps are server plugins registered at build time | Package imports give developers extension points without a runtime marketplace, dynamic schema mutation, or unknown code loading. |
| Islands by design | 2 coherence | App Instances do not federate | Federation is a large protocol and moderation commitment for zero shipped users. Self-hostable islands give operators full control without an instance-to-instance protocol. If federation ever ships, it gets its own architecture spec. |
| Keep integrations explicit | 2 coherence | Publish actions move private drafts into selected App Instances | Private workspace data should not become public by ambient sync. |
| License server-hosted Cloud Apps with network-copyleft intent | Deferred | Legal review required | The current AGPL pattern likely fits hosted server software, but final license wording is outside this architecture spec. |

## Boundary Rules

Use these rules before adding a route, table, or Cloud App.

```txt
If it is private workspace boot, workspace sync, or document sync:
  apps/server

If it is a public or shared social object:
  apps/cloud product Cloud App (served through App Instances)

If it needs moderation, feed ranking, public URLs, counters, or abuse controls:
  apps/cloud product Cloud App (served through App Instances)

If it is cloud-host infrastructure (billing, asset uploads, dashboard UI)
that operators run but users do not publish records to:
  apps/cloud infrastructure Cloud App (no public App Instance; serves the cloud host)

If it is a private draft or artifact before publishing:
  workspace document

If it is the canonical public version after publishing:
  App Instance record (lives on the configured instance host)
```

Two flavors of Cloud App, one rule:

```txt
Product app        owns public routes, schema, migrations, scopes, policy,
                   optional typed clients, and optional UI entrypoints
                   examples: ark, betcha
                   resource origin: per-instance host
                   scope namespace: <app>:* (ark:read, betcha:write, etc.)

Infrastructure     no public App Instance, serves the cloud host directly
app                examples: billing, assets, dashboard
                   resource origin: api.epicenter.so
                   scope namespace: cloud:* (cloud:billing, cloud:storage)
```

## Suggested File Shape

This is a target shape, not an immediate implementation command.

```txt
apps/cloud/src/
|-- app.ts
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
|   |   |-- index.ts
|   |   |-- routes.ts
|   |   |-- schema.ts
|   |   |-- migrations/
|   |   |-- scopes.ts
|   |   `-- policy.ts
|   |-- billing/                   (infrastructure Cloud App)
|   |-- assets/                    (infrastructure Cloud App)
|   `-- dashboard/                 (infrastructure Cloud App)
|-- instances/
|   |-- app-instance.ts            (operator instance shape)
|   |-- instance-registry.ts       (configured per cloud deployment)
|   `-- host-dispatch.ts
|-- oauth-resource.ts
`-- db/
    `-- schema.ts                 (re-exports enabled Cloud App schemas)
```

Cloud Apps live under `cloud-apps/` because they are compile-time server
plugins. They contribute routes, schemas, migrations, scopes, policies, and
optional typed client helpers. App Instances live under `instances/` because
operators configure them per deployment. The code primitive is App Instance;
product docs may call public social instances "networks."

App registration should make the developer and operator choices visible.

```ts
export default defineCloud({
	apps: [
		arkApp,
		billingApp,
		dashboardApp,
	],
	instances: [
		{
			id: 'epicenter-ark',
			host: 'ark.epicenter.so',
			app: 'ark',
			audience: 'https://ark.epicenter.so',
			issuer: 'https://server.epicenter.so',
			name: 'Ark',
			visibility: 'public',
		},
	],
});
```

Start with normal Drizzle migration ownership. Each Cloud App exports schema
and migrations; `apps/cloud` imports enabled app schemas into one schema
entrypoint and runs the ordinary Cloud migration pipeline. A future
`cloud generate` command can scan `defineCloud({ apps })` only after manual
schema composition becomes painful.

## OAuth And Scopes

### Resource Discovery Per App Instance

Each App Instance is its own OAuth protected resource. This closes the loop
with the auth north star (`final-oauth-auth-architecture.md`): tokens are
audience-bound, and the audience is the instance host, not `apps/cloud` as a
whole.

```txt
Per-instance requirements:

  https://<instance-host>/.well-known/oauth-protected-resource
    served by the cloud deployment hosting that instance
    declares the issuer this instance trusts
    declares the scopes this instance enforces

  token audience:
    aud = https://<instance-host>
    must not be substitutable for another instance's audience

  token scope:
    drawn from the owning Cloud App's scope namespace (ark:*, betcha:*)

  CORS:
    allowed origins are configured per instance, not per cloud deployment
```

Infrastructure Cloud Apps (billing, assets, dashboard) share the cloud host
as their resource (`api.epicenter.so` on hosted Epicenter) and use the
`cloud:*` scope namespace. They do not publish per-app protected-resource
metadata.

```txt
Resource summary:

  sync.epicenter.so          apps/server         scope: workspaces:open
  api.epicenter.so           apps/cloud infra      scope: cloud:billing, cloud:storage
  ark.epicenter.so           Cloud App ark         scope: ark:read, ark:publish
  betcha.epicenter.so        Cloud App betcha      scope: betcha:read, betcha:write
  ark.alice.com              Cloud App ark         scope: ark:read, ark:publish
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
    audience = sync.epicenter.so
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
  official hosted instance and canonical ecosystem

Third-party Cloud:
  another operator's hosted instance or ecosystem
```

## Implementation Plan

This spec is not asking for code movement yet. It sets the vocabulary for a
later clean break.

### Phase 1: Spec Alignment

- [ ] **1.1** Mark the older Betcha/Ark server-authoritative spec as historical where it conflicts with `apps/cloud` Cloud Apps and App Instances.
- [ ] **1.2** Link this spec from the final OAuth architecture as the Cloud App follow-up.
- [ ] **1.3** Update README or positioning only after the vocabulary survives one implementation pass.

### Phase 2: Cloud App Skeleton

- [ ] **2.1** Define a `CloudApp` shape with route mounting, schema, migrations, scopes, policy, and optional typed clients.
- [ ] **2.2** Define an `AppInstance` shape with `id`, `host`, `app`, `audience`, `issuer`, `name`, and visibility.
- [ ] **2.3** Add host dispatch for App Instance hosts inside `apps/cloud`.
- [ ] **2.4** Add tests proving disabled Cloud Apps expose no routes.
- [ ] **2.5** Re-export enabled Cloud App schemas through the `apps/cloud` Drizzle schema entrypoint.

### Phase 3: First Product Cloud App

- [ ] **3.1** Pick one Cloud App, likely Ark, as the first implementation.
- [ ] **3.2** Create minimal `post` and `profile` tables inside the Cloud App.
- [ ] **3.3** Add `ark:read` and `ark:publish` scope checks.
- [ ] **3.4** Add `POST /api/ark/posts` and `GET /api/ark/posts/:id`.
- [ ] **3.5** Add a typed client helper only after the route shape is proven.
- [ ] **3.6** Add a small publish integration from a workspace artifact only after the instance API is proven.

### Phase 4: Islands By Design

App Instances are islands. `ark.alice.com` and `ark.epicenter.so` do not
talk to each other. Users on one instance do not follow users on another
instance. Posts, follows, reactions, and ledgers stay inside the instance
where they were published.

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
  identity is per-instance (handle@instance)
```

If federation ever becomes a product requirement, it gets its own
architecture spec. It is not a deferred phase of this one. The seams
this spec leaves (stable per-instance public APIs, audience-bound OAuth,
canonical URLs per record) keep that future spec possible without
forcing this one to design for it.

- [ ] **4.1** Keep public read APIs stable per App Instance.
- [ ] **4.2** Keep handles unique within an App Instance host only.
- [ ] **4.3** Do not add cross-instance link, follow, or identity primitives.

## Open Questions

1. Should `apps/cloud` be self-hostable as a full optional deployable, or should only selected Cloud Apps be packaged for third-party hosting at first?
2. Does a third-party Cloud need its own OAuth issuer, or can it trust a separate `apps/server` issuer controlled by the same operator?
3. Should App Instances be single-host only at first, or can one Cloud host many instances for the same Cloud App?

### Deferred (do not answer in this spec)

These are intentionally not open questions for this spec. They are listed
so future readers know they were considered and refused:

```txt
Federation API design
  Status: deferred until real second-instance demand exists.
  Reason: islands by design (see Phase 4).

License wording for Cloud Apps
  Status: deferred to a separate licensing decision.
  Reason: product intent (network-copyleft) is recorded; legal review
  belongs outside this architecture spec.
```

## Clean Break Rules

1. Do not put social feeds, public posts, or wager ledgers in `apps/server`.
2. Do not let private workspace sync imply public publishing.
3. Do not make Epicenter Cloud synonymous with the Epicenter Platform.
4. Do not force every Cloud operator to run every Cloud App.
5. Do not design federation. App Instances are islands. If federation ever ships, it gets its own architecture spec.
6. Do not make first-party Cloud Apps bypass the same OAuth resource boundary that third-party integrations use.
7. Do not runtime-install unknown Cloud Apps. Package imports plus compile-time registration are the extension model.
8. Do not put instance hostnames, tenant IDs, or record IDs into scope names. Use audience for the instance and policy for record-level authorization.
9. Do not let a sync token publish to an App Instance. Do not let an instance token open private workspaces. Do not let one App Instance's token act on another App Instance.
