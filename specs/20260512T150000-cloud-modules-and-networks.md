# Cloud Modules And Networks

**Date**: 2026-05-12
**Status**: Draft
**Author**: AI assisted
**Depends on**: `specs/20260511T150000-final-oauth-auth-architecture.md`
**Supersedes in part**: `specs/20260413T120000-server-authoritative-apps-wager-social.md`

## One Sentence

Epicenter Cloud is a modular host for server-authoritative apps; each
enabled module can create one or more networks, and each network owns its
public records, policy, and domain. Networks are islands by design: they
do not talk to each other.

## Overview

This spec defines the product boundary above `apps/cloud`. `apps/server` stays
the private workspace auth and sync runtime. `apps/cloud` becomes a modular host
for public, server-authoritative apps such as Ark and Betcha. Epicenter can run
the canonical hosted ecosystem, while other operators can host their own
ecosystems with the modules they choose.

## Vocabulary

| Term | Meaning | Example |
| --- | --- | --- |
| Platform | The Epicenter codebase, protocols, packages, and deployable shapes. | `@epicenter/workspace`, `apps/server`, `apps/cloud` |
| Deployable | A built runtime an operator can host. | `apps/server`, `apps/cloud` |
| Module | A server-authoritative product surface inside Cloud. Owns routes, schema, UI, and scopes. | Ark, Betcha, billing, assets |
| Network | A configured hosted instance of one module. Owns public records and policy. | `ark.epicenter.so`, `ark.alice.com` |
| Record | A canonical public object owned by one network. | post, comment, reaction, wager, ledger entry |
| Integration | A user action that moves or projects private workspace data into a network. | "Post this presentation to Ark" |

The important correction is this:

```txt
Cloud hosts modules.
Modules create networks.
Networks own public records.
Networks ARE OAuth protected resources.
Modules are not.
```

Do not say "Cloud owns Ark" as if Cloud is one fixed product bundle. Cloud is
the host. Ark is a module. `ark.epicenter.so` is one network. The OAuth
resource boundary (audience, scope, discovery) lives at the network host,
not at `apps/cloud` as a whole.

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
`apps/cloud` split.

## Desired State

Operators can choose how much Epicenter they host.

```txt
Bob
  runs:
    apps/server
  gets:
    private workspace auth and sync
  does not run:
    public networks

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
    her own Ark network at ark.alice.com

Company Cloud
  runs:
    apps/server
    apps/cloud with betcha only
  gets:
    private or public company Betcha network
```

This preserves symmetry:

```txt
Epicenter is the platform.
Epicenter Cloud is our hosted instance.
Other people can run their own clouds and networks.
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
|   apps/cloud       public modules and hosted control plane    |
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
| product modules (each may register one or more networks):    |
|   ark                                                        |
|   betcha                                                     |
|                                                              |
| infrastructure modules (no networks, serve cloud host):      |
|   billing                                                    |
|   assets                                                     |
|   dashboard                                                  |
+--------------------------------------------------------------+
                       |
                       | operator picks which modules ship
                       | and configures their networks
                       v
+--------------------------------------------------------------+
| Networks (operator-configured, OAuth protected resources)    |
|                                                              |
|   ark.epicenter.so       (module: ark,    host: cloud A)     |
|   betcha.epicenter.so    (module: betcha, host: cloud A)     |
|   ark.alice.com          (module: ark,    host: cloud B)     |
|                                                              |
| each network publishes:                                      |
|   /.well-known/oauth-protected-resource                      |
|   token audience = network host                              |
|   scopes scoped to the module (ark:*, betcha:*)              |
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
   Resource choice: ark.epicenter.so, ark.alice.com, or another Ark network

3. Auth gets a Cloud/network-scoped grant.
   Audience: selected network resource
   Scope: ark:publish

4. Presenter sends a post input.
   POST {network}/api/ark/posts

5. Ark network stores the public record.
   Owner: selected network
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
  public or network-visible
  server-authoritative
  moderated by network
  served by apps/cloud
```

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Keep `apps/server` private-sync focused | 2 coherence | No Ark or Betcha in Server | Social feeds, public records, moderation, and shared relational state are not workspace sync. |
| Make Cloud modular | 2 coherence | Cloud hosts optional modules | Operators should not be forced to run Ark, Betcha, billing, and assets as one bundle. |
| Make Network first-class | 2 coherence | Network owns public records | A public URL needs one authoritative host for moderation, deletion, feeds, and policy. |
| Treat Epicenter Cloud as an instance | 2 coherence | Canonical hosted ecosystem, not the platform itself | Other operators can host their own ecosystems without becoming Epicenter-the-company. |
| Islands by design | 2 coherence | Networks do not federate | Federation is a large protocol and moderation commitment for zero shipped users. Self-hostable islands give operators full control without a network-to-network protocol. If federation ever ships, it gets its own architecture spec. |
| Keep integrations explicit | 2 coherence | Publish actions move private drafts into selected networks | Private workspace data should not become public by ambient sync. |
| License server-hosted modules with network-copyleft intent | Deferred | Legal review required | The current AGPL pattern likely fits hosted network software, but final license wording is outside this architecture spec. |

## Boundary Rules

Use these rules before adding a route, table, or module.

```txt
If it is private workspace boot, workspace sync, or document sync:
  apps/server

If it is a public or shared social object:
  apps/cloud product module (registers a network)

If it needs moderation, feed ranking, public URLs, counters, or abuse controls:
  apps/cloud product module (registers a network)

If it is cloud-host infrastructure (billing, asset uploads, dashboard UI)
that operators run but users do not publish records to:
  apps/cloud infrastructure module (no network; serves the cloud host)

If it is a private draft or artifact before publishing:
  workspace document

If it is the canonical public version after publishing:
  network record (lives on the configured network host)
```

Two flavors of module, one rule:

```txt
Product module     registers networks, owns public records and moderation
                   examples: ark, betcha
                   resource origin: per-network host
                   scope namespace: <module>:* (ark:read, betcha:write, etc.)

Infrastructure     no network, serves the cloud host directly
module             examples: billing, assets, dashboard
                   resource origin: api.epicenter.so
                   scope namespace: cloud:* (cloud:billing, cloud:storage)
```

## Suggested File Shape

This is a target shape, not an immediate implementation command.

```txt
apps/cloud/src/
|-- app.ts
|-- modules/
|   |-- ark/                       (product module)
|   |   |-- routes.ts
|   |   |-- schema.ts
|   |   |-- scopes.ts
|   |   `-- network-shape.ts       (what a network of this module looks like)
|   |-- betcha/                    (product module)
|   |   |-- routes.ts
|   |   |-- schema.ts
|   |   |-- scopes.ts
|   |   `-- network-shape.ts
|   |-- billing/                   (infrastructure module)
|   |-- assets/                    (infrastructure module)
|   `-- dashboard/                 (infrastructure module)
|-- networks/
|   |-- network.ts                 (operator network instance)
|   |-- network-registry.ts        (configured per cloud deployment)
|   `-- host-dispatch.ts
`-- oauth-resource.ts
```

`network-shape.ts` lives in the module because the module defines what
fields a network of that module needs. `network-registry.ts` lives in
`networks/` because operators populate it per deployment. Modules declare
network shapes; operators configure network instances.

Module registration should make the operator choice visible.

```ts
createCloudApp({
	modules: [
		arkModule({
			networks: [
				{
					id: 'epicenter-ark',
					host: 'ark.epicenter.so',
					name: 'Ark',
					visibility: 'public',
				},
			],
		}),
		billingModule(),
		dashboardModule(),
	],
});
```

## OAuth And Scopes

### Resource Discovery Per Network

Each network is its own OAuth protected resource. This closes the loop with
the auth north star (`final-oauth-auth-architecture.md`): tokens are
audience-bound, and the audience is the network host, not `apps/cloud` as a
whole.

```txt
Per-network requirements:

  https://<network-host>/.well-known/oauth-protected-resource
    served by the cloud deployment hosting that network
    declares the issuer this network trusts
    declares the scopes this network enforces

  token audience:
    aud = https://<network-host>
    must not be substitutable for another network's audience

  token scope:
    drawn from the owning module's scope namespace (ark:*, betcha:*)

  CORS:
    allowed origins are configured per network, not per cloud deployment
```

Infrastructure modules (billing, assets, dashboard) share the cloud host
as their resource (`api.epicenter.so` on hosted Epicenter) and use the
`cloud:*` scope namespace. They do not publish per-module protected-resource
metadata.

```txt
Resource summary:

  sync.epicenter.so          apps/server         scope: workspaces:open
  api.epicenter.so           apps/cloud infra    scope: cloud:billing, cloud:storage
  ark.epicenter.so           apps/cloud, ark     scope: ark:read, ark:publish
  betcha.epicenter.so        apps/cloud, betcha  scope: betcha:read, betcha:write
  ark.alice.com              alice's cloud, ark  scope: ark:read, ark:publish
```

### Module Scopes

Sync scopes and network scopes are separate.

```txt
workspaces:open
  resource: sync resource
  permits: workspace identity and sync

ark:read
  resource: Ark network
  permits: read user-visible posts and profiles

ark:publish
  resource: Ark network
  permits: create public records

betcha:read
  resource: Betcha network
  permits: read visible challenges and ledgers

betcha:write
  resource: Betcha network
  permits: create and update challenges
```

If one app needs both private sync and network publishing, it requests separate
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

Do not let a workspace sync token publish to Ark. Do not let an Ark token open
private workspaces.

## Licensing And Host Control

This is not legal advice. It is the product intent the license should support.

```txt
Open source code:
  people can inspect, modify, and host the software

Network copyleft intent:
  if someone modifies and hosts the server-side network software,
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

- [ ] **1.1** Mark the older Betcha/Ark server-authoritative spec as historical where it conflicts with `apps/cloud` modules and networks.
- [ ] **1.2** Link this spec from the final OAuth architecture as the Cloud product-module follow-up.
- [ ] **1.3** Update README or positioning only after the vocabulary survives one implementation pass.

### Phase 2: Cloud Module Skeleton

- [ ] **2.1** Define a `CloudModule` shape with route mounting, scopes, and optional network config.
- [ ] **2.2** Define a `NetworkConfig` shape with `id`, `host`, `module`, `name`, and visibility.
- [ ] **2.3** Add host dispatch for network hosts inside `apps/cloud`.
- [ ] **2.4** Add tests proving disabled modules expose no routes.

### Phase 3: First Network Module

- [ ] **3.1** Pick one module, likely Ark, as the first implementation.
- [ ] **3.2** Create minimal `post` and `profile` tables inside the module.
- [ ] **3.3** Add `ark:read` and `ark:publish` scope checks.
- [ ] **3.4** Add `POST /api/ark/posts` and `GET /api/ark/posts/:id`.
- [ ] **3.5** Add a small publish integration from a workspace artifact only after the network API is proven.

### Phase 4: Islands By Design

Networks are islands. `ark.alice.com` and `ark.epicenter.so` do not talk
to each other. Users on one network do not follow users on another network.
Posts, follows, reactions, and ledgers stay inside the network where they
were published.

```txt
What islands give us:
  one less protocol to design and ship
  no inter-instance key trust to maintain
  no inter-instance moderation handshake
  no identity mapping problem
  each operator owns their network policy completely

What islands cost users:
  cross-network follow does not exist
  posting to N networks means N publish actions
  identity is per-network (handle@network)
```

If federation ever becomes a product requirement, it gets its own
architecture spec. It is not a deferred phase of this one. The seams
this spec leaves (stable per-network public APIs, audience-bound OAuth,
canonical URLs per record) keep that future spec possible without
forcing this one to design for it.

- [ ] **4.1** Keep public read APIs stable per network.
- [ ] **4.2** Keep network handles unique within a network host only.
- [ ] **4.3** Do not add cross-network link, follow, or identity primitives.

## Open Questions

1. Should `apps/cloud` be self-hostable as a full optional deployable, or should only selected modules be packaged for third-party hosting at first?
2. Does a third-party Cloud need its own OAuth issuer, or can it trust a separate `apps/server` issuer controlled by the same operator?
3. Should networks be single-host only at first, or can one Cloud host many networks for the same module?

### Deferred (do not answer in this spec)

These are intentionally not open questions for this spec. They are listed
so future readers know they were considered and refused:

```txt
Federation API design
  Status: deferred until a real second network asks for it.
  Reason: islands by design (see Phase 4).

License wording for Cloud modules
  Status: deferred to a separate licensing decision.
  Reason: product intent (network-copyleft) is recorded; legal review
  belongs outside this architecture spec.
```

## Clean Break Rules

1. Do not put social feeds, public posts, or wager ledgers in `apps/server`.
2. Do not let private workspace sync imply public publishing.
3. Do not make Epicenter Cloud synonymous with the Epicenter Platform.
4. Do not force every Cloud operator to run every module.
5. Do not design federation. Networks are islands. If federation ever ships, it gets its own architecture spec.
6. Do not make first-party modules bypass the same OAuth resource boundary that third-party integrations use.
7. Do not collapse product modules and infrastructure modules into one shape. Product modules register networks; infrastructure modules do not.
8. Do not let a sync token publish to a network. Do not let a network token open private workspaces. Do not let one network's token act on another network.
