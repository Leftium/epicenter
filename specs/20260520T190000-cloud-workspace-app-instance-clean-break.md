# Cloud Workspace App Namespace Clean Break

**Date**: 2026-05-20
**Status**: In Progress (sync route, Workspace API, and first client adoption landed; cleanup pending)
**Author**: Epicenter

## Overview

Epicenter Cloud should make Workspace the product account surface and an app namespace the durable sync boundary. In phase 1, Cloud Workspace identity is Better Auth organization identity: `workspaceId` is `organization.id`. The app namespace is the tuple `workspaceId + appId`; it does not need a required `app_instance` table until Cloud needs an installed-app product surface.

This supersedes the Cloud ownership direction in `specs/20260520T170000-cloud-workspaces-and-organizations-clean-break.md`. That spec kept Workspace as the data boundary and Organization as the team, policy, and billing boundary. This spec collapses that split: the product noun is Workspace, Better Auth organization is the backing row, and `workspaceId + appId` becomes the lower app sync namespace.

## One Sentence

Epicenter Cloud Workspaces are Better Auth organizations presented as Workspaces; app namespaces anchor app-owned root Y.Docs; Rooms coordinate Yjs sync.

## Mental Model

```txt
User =
  a human login identity

Cloud Workspace =
  the product account surface
  same id as Better Auth organization
  owns members, invitations, billing, policy, and app namespaces

App =
  an app definition or package, such as Whispering or Tab Manager

App Namespace =
  the workspace-local namespace for one app
  identified by workspaceId + appId in phase 1
  anchors that app's root Y.Doc namespace inside the Cloud Workspace

App Instance =
  optional future product row for installed apps
  only needed when Cloud must list, disable, bill, delete, or duplicate app installations

Sync Doc =
  one independently synced Y.Doc inside an App Namespace
  usually the app's root Y.Doc in phase 1

Room =
  the live runtime actor that syncs one Sync Doc
```

The friendly version:

```txt
Personal use:
  "Braden" is a one-member Cloud Workspace.

Team use:
  "Epicenter" is a multi-member Cloud Workspace.

Apps:
  each Cloud Workspace can contain app namespaces.

Sync:
  each app namespace opens a root Sync Doc.
  extra Sync Docs are app-owned and optional.
```

The maintenance-cost version:

```txt
Delete:
  workspace.owner_user_id
  workspace.owner_organization_id
  fake personal organization debate
  public Organization product noun
  user-owned room namespace as the Cloud product boundary

Keep:
  Better Auth organization and member tables
  one Cloud Workspace membership surface
  workspaceId = organization.id in phase 1
  zero required Epicenter-owned Cloud app tables in phase 1
  app namespace = workspaceId + appId
  app-owned root Y.Doc as the semantic source of truth
  one opaque roomName builder
  one generic SyncEngine
```

## What This Supersedes

```txt
Supersedes:
  specs/20260520T170000-cloud-workspaces-and-organizations-clean-break.md
    rejects user-owned or organization-owned Workspace rows for Cloud
    replaces public Organization with Cloud Workspace
    moves the Cloud app namespace below Workspace into `workspaceId + appId`

  specs/20260519T155705-workspace-noun-clean-break.md
    keeps Workspace as the daily product noun
    rejects the owner_user_id / owner_organization_id SQL shape for Cloud

  specs/20260520T001032-workspace-capsule-clean-break.md
    keeps the capsule pressure test for local and portable app data
    maps the Cloud app capsule to app namespace plus root Y.Doc

  specs/20260520T130000-workspace-portability-design-brief.md
    keeps portability requirements
    applies them to the app-owned root Y.Doc inside an app namespace

  specs/20260519T231845-realm-boundary-clean-break.md
    keeps the warning that one DO per top-level boundary is wrong
    rejects Realm as a product noun

Builds on:
  specs/20260520T114537-epicenter-sync-engine-host-composition.md
    host-owned authorization and roomName construction

  specs/20260519T085954-api-session-clean-break.md
    authenticated session projection
```

## Current State

The current Cloud API is subject-scoped.

```txt
request
  -> Better Auth user
  -> /rooms/:room
  -> roomName = subject:{user.id}:rooms:{room}
  -> Room Durable Object
```

That is the right sync-engine shape but the wrong Cloud product boundary. The route owns auth, builds an opaque room name, and passes bytes to a generic sync engine. The problem is the route identity:

```txt
subject:{user.id}:rooms:{room}
```

That names personal sync. It does not name a Cloud Workspace, app namespace, or sync doc.

## Desired Shape

```txt
request
  -> authenticate user
  -> resolve Cloud Workspace
  -> check Better Auth organization membership
  -> validate appId and docId
  -> build internal roomName
  -> Room Durable Object
```

The public route should name product resources:

```txt
GET  /workspaces/:workspaceId/apps/:appId/docs/:docId
POST /workspaces/:workspaceId/apps/:appId/docs/:docId
WS   /workspaces/:workspaceId/apps/:appId/docs/:docId
POST /workspaces/:workspaceId/apps/:appId/docs/:docId/dispatch
```

The internal room name should name the authorized sync doc:

```txt
v1:workspace:{workspaceId}:app:{appId}:doc:{docId}
```

`v1:` is worth keeping. It is not user-facing API. It is an internal Durable Object naming protocol. The prefix gives future room-name migrations a clean boundary if we need epochs, sharding, custody-mode splits, or a different sync-doc identity format.

## Phase 1 Boundary

Phase 1 does not need scoped sync tokens. The Hono route is the control-plane boundary.

```txt
Hono route:
  reads the authenticated Better Auth user
  checks Better Auth organization membership
  validates workspaceId, appId, and docId
  builds the internal roomName

Room Gateway:
  maps roomName to the Durable Object id

Room Durable Object:
  syncs Yjs
  persists updates
  manages awareness and dispatch

SyncEngine:
  wraps binary HTTP sync
  knows only roomName
```

This keeps the sync plane policy-free without adding token infrastructure. Scoped sync tokens are a future extraction path for dedicated or self-hosted sync servers. They are not part of this clean break.

The sync-plane primitive is still a room. The product-shaped route exists at the Cloud API edge so the Hono resolver has the authorization inputs without a lookup table.

```txt
Product route:
  /workspaces/:workspaceId/apps/:appId/docs/:docId

Internal room:
  v1:workspace:{workspaceId}:app:{appId}:doc:{docId}
```

## Why AppId Is Enough In Phase 1

Use `App` for the app definition:

```txt
App:
  Whispering
  Tab Manager
  future app package from jsrepo or a local project
```

Use `App Namespace` for the workspace-local sync namespace:

```txt
App Namespace:
  Braden Workspace + whispering
  Epicenter Workspace + whispering
  Epicenter Workspace + tab-manager
```

This distinction matters because each Workspace needs its own app namespace. The same app definition can exist in many workspaces. In phase 1, one app namespace per `workspaceId + appId` is enough.

Cloud should not use an App Instance table as a shadow app database. The app's root Y.Doc remains the semantic source of truth for app records, child doc references, and blob references.

Creation should be idempotent:

```txt
User opens an app in a Cloud Workspace
  -> Cloud validates workspace membership
  -> Cloud validates appId and docId syntax
  -> app opens its root Sync Doc
  -> app records its own data inside that root Y.Doc
  -> additional Sync Docs are opened only if the app needs them
```

That can look explicit in UI:

```txt
Add app
```

or implicit:

```txt
Open Whispering for the first time
```

In phase 1, both flows can be pure navigation into `/workspaces/:workspaceId/apps/:appId/docs/root`. They do not require a Cloud mutation.

The storage invariant is smaller than earlier drafts: Cloud owns access to the Workspace and the room-name namespace; the app owns the Yjs document graph and blob references inside `workspaceId + appId`.

## What The Collapse Buys And Costs

The collapsed phase 1 shape is intentionally sparse:

```txt
Better Auth organization:
  owns Workspace identity and membership

Sync route:
  owns authorization and roomName construction

App root Y.Doc:
  owns app records, child doc references, settings, and blob references

Object storage:
  owns blob bytes under a workspace/app/doc-aware prefix
```

That means Cloud can sync this without creating an installed-app row:

```txt
/workspaces/ws_123/apps/whispering/docs/root
```

and also this:

```txt
/workspaces/ws_123/apps/whispering/docs/recording_rec_456
```

The second route does not prove that `recording_rec_456` exists in Postgres. It means the caller is a member of `ws_123`, `whispering` is an allowed app id, and `recording_rec_456` is a syntactically valid app-owned doc id. The app root Y.Doc decides whether that child doc is referenced by the product state.

This gives up a few Cloud control-plane features in phase 1:

```txt
Cloud cannot list installed apps from SQL.
Cloud cannot distinguish "never opened" from "opened but empty" without reading app data.
Cloud cannot disable one app namespace without app-level policy.
Cloud cannot delete one app namespace with a single relational cascade.
Cloud cannot support two separate Whispering instances in one Workspace.
```

Those are real costs, but they are product costs, not sync correctness costs. If one becomes necessary, add `app_instance` then.

## Whispering Example

Whispering should treat the root Y.Doc as the app's semantic index.

```txt
/workspaces/braden/apps/whispering/docs/root
  recordings table
  transformations table
  settings KV
  blob references
  optional child doc references
```

A recording can stay entirely inside the root doc if its CRDT state is small:

```txt
recording rec_123:
  metadata in root Y.Doc
  transcript text in root Y.Doc
  audio blob path in root Y.Doc
  audio bytes in object storage
```

If a recording grows enough to deserve independent sync, Whispering can create a child doc by convention:

```txt
/workspaces/braden/apps/whispering/docs/recording_rec_123
```

Cloud does not register that child doc. The root Y.Doc references it. The route allows it. The Room Durable Object coordinates it when clients open it.

That avoids turning Cloud into an orchestra that every app-specific record creation must call. The app owns app semantics; Cloud owns authorization and sync transport.

## Better Auth Grounding

Better Auth organization plugin is the right backing layer for Cloud Workspace. In phase 1, it should also be the Workspace identity row. `workspaceId` is the public product name for `organization.id`.

DeepWiki confirmed the plugin provides:

```txt
organization:
  id
  name
  slug
  logo
  metadata

member:
  userId
  organizationId
  role

invitation:
  email
  inviterId
  organizationId
  role
  status
  expiresAt

session:
  activeOrganizationId

optional teams:
  team
  teamMember
  activeTeamId
```

Epicenter should map that like this:

```txt
Better Auth organization =
  Cloud Workspace row

Better Auth organization.id =
  Cloud Workspace workspaceId

Better Auth member =
  Cloud Workspace member

Better Auth invitation =
  Cloud Workspace invitation

Better Auth activeOrganizationId =
  active Cloud Workspace context in auth/session plumbing
```

Do not expose Organization as a separate product noun in Cloud. Users see Workspaces. Better Auth can keep its internal organization vocabulary.

Do not map App Namespace to Better Auth team. Better Auth teams are people groupings inside an organization. App namespaces are data namespaces inside a Workspace.

Do not create a separate `cloud_workspace` table in phase 1. Better Auth already owns the top-level account shape. Add a 1:1 `workspace_profile` table only when Workspace owns product fields that do not belong in Better Auth organization metadata.

Examples that would justify `workspace_profile` later:

```txt
workspace custody mode
workspace deletion lifecycle
workspace export/import lineage
workspace default app policy
workspace billing cache
```

## Notion And Comparable Products

The product shape is closer to Notion and Linear than to the old owner-union model.

| Product | Top-level surface | Inner surface | Lesson |
| --- | --- | --- | --- |
| Notion | Workspace | teamspaces, pages, databases | Workspace is the daily product container. Smaller content surfaces live inside it. |
| Linear | Workspace | teams, projects, issues | A company should usually live in one workspace. Teams and projects organize work inside it. |
| Supabase | Organization | projects | Billing and members live at the org; deployable units live below it. |
| Vercel | personal or team scope | projects | The selected scope owns billing and members; projects sit inside. |

Epicenter should use the Workspace word like Notion and Linear:

```txt
Workspace =
  the place people enter, invite members to, and pay for
```

Epicenter should not copy Supabase and Vercel project tables unless the product need is real:

```txt
Supabase or Vercel Project =
  deployable product surface with settings, status, env vars, domains, and lifecycle

Epicenter app namespace in phase 1 =
  workspaceId + appId
  sync namespace only
  no settings row, no installed-app lifecycle row
```

## Why A Smaller Data Unit Still Exists

Cloud Workspace should not be the Yjs document boundary.

One giant Workspace-level Y.Doc would create these problems:

```txt
all apps load together
one app edit touches the whole workspace document stream
export and delete boundaries get muddy
key rotation gets too coarse
offline caches collide more easily
one Durable Object can bottleneck an entire Workspace
```

The smaller Cloud unit is the app namespace. Inside it, the app should usually start with one root Y.Doc.

```txt
App Namespace:
  workspaceId = braden
  appId = whispering

Root Sync Doc:
  docId = root
  contains recordings, transformations, settings, blob references
```

Yjs and y-indexeddb both make identity collisions expensive. A `Y.Doc.guid` is document identity metadata, not authorization. `y-indexeddb` persists by the `docName` string passed to `IndexeddbPersistence`, not by `Y.Doc.guid`. Two logical docs that share persistence names or receive the same updates will converge.

So the sync identity must include the full hierarchy:

```txt
syncDocIdentity =
  workspaceId + "/" + appId + "/" + docId

Y.Doc.guid =
  syncDocIdentity, or a documented legacy guid mapped to it

IndexedDB docName =
  owner-scoped syncDocIdentity

BroadcastChannel name =
  owner-scoped syncDocIdentity

roomName =
  v1:workspace:{encodedWorkspaceId}:app:{encodedAppId}:doc:{encodedDocId}
```

The sync protocol does not know any of these ids. The host authorizes the request, builds the room name, and passes bytes to the sync engine.

Cloud does not need a relational row for every Sync Doc by default. The app root Y.Doc owns the app's semantic document graph. Extra Sync Docs are app-owned choices, not Cloud control-plane records.

The route accepts any valid app-owned `docId`. `root` is only the convention for the entry point, not a different resource type.

```txt
docs/root =
  conventional app entry document

docs/{anything-else} =
  optional app-owned child document
```

Cloud treats `root` and every other valid `docId` the same after authorization. Apps give `root` meaning. For Whispering, `root` should contain recordings, settings, transformations, blob references, and optional child doc references.

## Architecture

```txt
┌─────────────────────────────────────────────┐
│ Better Auth user                             │
│ human login identity                         │
└─────────────────────────────────────────────┘
                    │ member rows
                    ▼
┌─────────────────────────────────────────────┐
│ Better Auth organization                     │
│ Epicenter Cloud Workspace identity row       │
│ members, invitations, roles, billing context │
└─────────────────────────────────────────────┘
                    │ contains
                    ▼
┌─────────────────────────────────────────────┐
│ App Namespace                                │
│ workspace-local namespace for one app id      │
│ Cloud namespace for the app root Y.Doc       │
└─────────────────────────────────────────────┘
                    │ contains
                    ▼
┌─────────────────────────────────────────────┐
│ Sync Doc                                     │
│ root Y.Doc by default; app-owned extras later │
└─────────────────────────────────────────────┘
                    │ coordinated by
                    ▼
┌─────────────────────────────────────────────┐
│ Room Durable Object                          │
│ live peers, Yjs update log, awareness        │
└─────────────────────────────────────────────┘
```

## Schema Sketch

Better Auth owns the top-level Workspace tables. Cloud Workspace is not a separate table in phase 1.

```txt
organization
  id
  name
  slug
  metadata
  used publicly as workspaceId

member
  user_id
  organization_id
  role

invitation
  organization_id
  email
  role
  status
```

Epicenter owns no required Cloud app tables in phase 1. The app namespace is derived from the route:

```txt
app namespace =
  workspaceId + appId

root document =
  workspaceId + appId + root
```

Do not add these tables in phase 1:

```txt
cloud_workspace
workspace_member
workspace_invitation
workspace_role
workspace_owner
workspace_billing
workspace_policy
app_sync_doc
app_asset
app_instance_member
app_key_grant
billing_cache
```

Keep these as future escape hatches, not phase 1 plan items:

```txt
app_instance:
  installed-app inventory if Cloud must list, disable, delete, duplicate, bill, migrate, or configure apps independently of app-owned Yjs data

app_sync_doc:
  Cloud inventory for Sync Docs if app-owned root docs are not enough for deletion, migration, support, or metering

workspace_profile:
  1:1 product fields for a Workspace when Better Auth metadata is not enough

app_asset:
  Cloud inventory for blobs if object-store prefix accounting and app-owned references are not enough

app_instance_member:
  private apps or app-level roles

app_key_grant:
  user-held or customer-managed key grants

billing_cache:
  cached billing state if Autumn lookup cost or dashboard needs justify it
```

Access and custody stay deliberately simple in phase 1.

```txt
Workspace membership =
  can user enter this Cloud Workspace?

App namespace access in phase 1 =
  any Workspace member can open any valid appId namespace

Custody in phase 1 =
  server-managed encryption, not zero-knowledge
```

Future private apps and user-held keys should not be compressed into route parsing or app metadata.

```txt
Private app access:
  app_instance plus app_instance_member may earn themselves

User-held or customer-managed keys:
  app_key_grant may earn itself
```

## Route Flow

```txt
GET /workspaces/:workspaceId/apps/:appId/docs/:docId
  -> authenticate user
  -> require Better Auth member in organization workspaceId
  -> validate appId and docId syntax
  -> optionally require appId is known to the Cloud app registry
  -> build roomName
  -> if WebSocket upgrade, hand to Room
  -> else return snapshot

POST /workspaces/:workspaceId/apps/:appId/docs/:docId
  -> same resolver
  -> sync.handleHttpSync(request, { roomName })

POST /workspaces/:workspaceId/apps/:appId/docs/:docId/dispatch
  -> same resolver
  -> rooms.dispatch(roomName, body)
```

The resolver returns the authorized sync target:

```ts
type AuthorizedSyncDoc = {
  workspaceId: string;
  appId: string;
  docId: string;
};
```

The conventional entry doc id is `root`.

```txt
/workspaces/:workspaceId/apps/:appId/docs/root
```

Additional doc ids are app-owned. Cloud authorizes the Workspace boundary, validates route identity, and constructs a room name; it does not need to know what a child doc means. A child doc does not need a Postgres row before it can sync.

The sync engine still sees only:

```ts
sync.handleHttpSync(request, { roomName });
```

## Naming Rules

Use these names consistently:

```txt
Cloud Workspace:
  product/account surface
  Better Auth organization backing row

App:
  app definition or package

App Namespace:
  Cloud sync namespace for one workspace-local app id

App Instance:
  optional future installed-app product row

Sync Doc:
  independently synced Y.Doc
  usually the root Y.Doc for an App Namespace

Room:
  live runtime actor for one Sync Doc
```

Avoid:

```txt
Organization as public Cloud product noun
Workspace owner
workspace_member as a custom duplicate of Better Auth member
App Installation for the data boundary
Project unless the app-specific UI needs that word
Realm
Tenant
```

`App Installation` sounds like package management. `App Instance` is acceptable only when Cloud has an installed-app lifecycle to manage. In phase 1, `workspaceId + appId` is enough; the namespace can be entered explicitly by Add App or lazily by first use.

## Billing

Billing attaches to Cloud Workspace.

```txt
Autumn customerId =
  workspace:{workspaceId}

workspaceId =
  Better Auth organization.id

Usage event properties =
  workspaceId
  appId
  docId when useful
```

Personal and team billing use the same model:

```txt
Personal:
  one-member Cloud Workspace pays for its app usage

Team:
  multi-member Cloud Workspace pays for its app usage
```

If a company needs hard-separated billing, policy, or custody, it creates another Cloud Workspace. If it needs nested departments, SCIM group mirroring, cross-workspace enterprise policy, or custom IAM, that belongs in a later enterprise or self-host shape.

## Encryption And Custody

Do not call current Cloud encryption E2E or zero-knowledge.

Phase 1 has one custody mode:

```txt
server_managed:
  Cloud derives or unwraps the key material it gives the client
  easier recovery and sharing
  not end-to-end encryption
  not zero-knowledge
```

Do not add a `key_policy` or `custody_mode` column while there is only one mode. Add custody storage only when a second real mode exists.

Future custody modes:

```txt
user_held:
  Cloud stores wrapped grants only
  server cannot derive plaintext keys

customer_managed:
  a customer-owned root key or KMS wraps app keys
```

Recommended phase 1 key hierarchy:

```txt
Cloud Workspace
  membership and billing

App Namespace
  app root Y.Doc namespace

Sync Doc
  encrypted values under server-managed key material
```

Access and custody stay separate.

```txt
Removing a member:
  stops new Cloud Workspace access immediately

Changing custody:
  explicit migration, not an access-control toggle

True user-held sharing:
  requires app_key_grant or an equivalent grant store
```

## Self-Hosting

Self-hosting does not have to copy Better Auth organization policy.

The portable model is:

```txt
Workspace-like container
  -> app namespaces
      -> app-owned root docs
```

The host can map local auth or IAM into that shape:

```txt
Epicenter Cloud:
  Better Auth organization is the Cloud Workspace row

Solo self-host:
  local owner maps to one Workspace

Enterprise self-host:
  IAM group or deployment policy maps to Workspace membership
```

Packages should remain inversion-of-control friendly. `packages/workspace` should not import Better Auth organization, Autumn billing, or Cloud Workspace schema. Local apps open local app data; Cloud maps that data into app namespaces.

Apps own their document graph in every deployment mode. Cloud does not need to understand Whispering recordings, transcript docs, or blob relationships to sync them.

## Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Public product noun | 2 coherence | Workspace | Matches Notion and Linear. Users enter workspaces, invite members, and pay for them. |
| Auth backing row | 1 evidence | Better Auth organization.id is workspaceId | Better Auth already provides organization, member, invitation, activeOrganizationId, and optional teams. A duplicate Cloud Workspace table does not earn itself in phase 1. |
| Required Epicenter Cloud app table | 1 evidence | None in phase 1 | Better Auth owns Workspace membership. The app root Y.Doc owns app records, doc graph, and blob references. |
| App versus App Namespace | 2 coherence | Use App for the definition, App Namespace for `workspaceId + appId` | App names the package. App Namespace names the workspace-local sync namespace. |
| App Instance table | Deferred | Add only when installed-app lifecycle earns it | Listing, disabling, duplicating, deleting, app billing, app settings, or multiple same-app instances would earn a row. |
| App Namespace creation | 3 taste | Idempotent first sync, explicit Add App can navigate to the same path | Supports Notion-like sidebar use without making installation a package-management ceremony. |
| Room-name version | 2 coherence | Prefix internal names with `v1:` | It gives migration room for epochs, sharding, custody modes, or identity format changes without public route churn. |
| Root document | 2 coherence | One root Y.Doc per App Namespace | The root Y.Doc is the app-owned entry point and semantic index. |
| Sync grain | 1 evidence | One Room per opened Sync Doc | Yjs sync and Cloudflare DO coordination fit per-doc boundaries. Cloud does not need a Postgres row for each doc. |
| Read-only live sync | Deferred | Snapshot-only until frame filtering exists | Yjs protocol does not enforce read-only peers by itself. |
| Better Auth teams | Deferred | Do not map to App Namespace | Teams are people groupings, not app data boundaries. |
| Workspace profile table | Deferred | Add only when product fields earn it | Start with Better Auth organization metadata and add a 1:1 profile table only for real Workspace fields. |
| App asset table | Deferred | Avoid by default | Apps own blob references in Yjs. Cloud object storage can stay opaque and prefix-addressed. |
| Key grants | Deferred | Server-managed only in phase 1 | True user-held or customer-managed keys need an earned grant store later. |

## Implementation Plan

### Phase 1: Spec And Vocabulary

- [ ] **1.1** Mark older Cloud ownership specs as superseded by this model.
- [ ] **1.2** Rename Cloud product language from Organization to Workspace.
- [ ] **1.3** Use App Namespace for `workspaceId + appId`; reserve App Instance for a future installed-app row.
- [ ] **1.4** Keep App for app definitions and packages.

### Phase 2: Better Auth Organization As Workspace

- [x] **2.1** Enable Better Auth organization plugin for Cloud Workspaces.
- [x] **2.2** Create a personal Cloud Workspace as a one-member organization during signup or first Cloud use.
- [x] **2.3** Expose Workspace APIs that wrap Better Auth organization APIs.
- [x] **2.4** Keep Better Auth organization naming below the product API boundary.
- [x] **2.5** Do not create `cloud_workspace`, `workspace_member`, `workspace_invitation`, or `workspace_role` tables.
- [x] **2.6** Defer `workspace_profile` until Workspace owns product fields that Better Auth organization metadata should not carry.

### Phase 3: App Namespace Sync

- [x] **3.1** Do not add `app_instance` in phase 1.
- [x] **3.2** Add `appId` and `docId` validators.
- [x] **3.3** Do not add `app_sync_doc`, `app_asset`, `app_instance_member`, `app_key_grant`, or `billing_cache` in phase 1.
- [ ] **3.4** Keep app display metadata, child doc references, and blob references in the app root Y.Doc unless a Cloud operation earns a table.
- [ ] **3.5** Treat Add App as navigation or app-owned root-doc initialization unless Cloud product state earns an installed-app row.
- [x] **3.6** Treat `docId = root` as the conventional app entry document, not as a special platform resource type.
- [x] **3.7** Do not add a Workspace head Y.Doc in phase 1.

### Phase 4: Workspace App Sync Routes

- [x] **4.1** Add `/workspaces/:workspaceId/apps/:appId/docs/:docId`.
- [x] **4.2** Add `/workspaces/:workspaceId/apps/:appId/docs/:docId/dispatch`.
- [x] **4.3** Build `roomName` with `v1:` and encoded route parts.
- [x] **4.4** Keep SyncEngine policy-free.
- [x] **4.5** Use `docs/root` as the default App Namespace entry point.
- [x] **4.6** Keep Better Auth membership checks in the Hono route or resolver, not in the Room Durable Object or SyncEngine.
- [x] **4.7** Do not add scoped sync tokens in phase 1.

### Phase 5: Cleanup

- [ ] **5.1** Remove public `/rooms/:room` as the Cloud sync route.
- [x] **5.2** Remove subject-scoped room names from Cloud product routes.
- [ ] **5.3** Remove owner-user versus owner-organization workspace schema proposals from active Cloud plans.

### Phase 6: Client Adoption

- [x] **6.1** Resolve a default Cloud Workspace from `/api/session.defaultWorkspaceId` for at least one real client path.
- [x] **6.2** Open the client root Sync Doc at `/workspaces/:workspaceId/apps/:appId/docs/root` by default.
- [x] **6.3** Keep `/rooms/:room` as a compatibility path when the default Workspace is not available.
- [x] **6.4** Add tests for the client Workspace app doc URL construction.

## Test And Migration Invariants

Even in a clean break, these should become tests or migration gates.

```txt
Every Cloud Workspace has at least one owner/admin member.
Cloud Workspace identity is Better Auth organization.id in phase 1.
No duplicate Cloud Workspace membership, invitation, role, owner, billing, or policy tables are added in phase 1.
No required Epicenter-owned Cloud app tables are added in phase 1.
Every app namespace is addressed by workspaceId + appId.
Every app namespace has a conventional root Sync Doc address.
Cloud does not require a persisted Sync Doc inventory row in phase 1.
Cloud does not require an app asset table in phase 1.
The sync route rejects users who are not members of the backing Better Auth organization.
The sync route validates appId and docId before building roomName.
The sync route accepts any valid app-owned docId, not only root.
roomName is built by one host-owned function.
roomName includes a version prefix.
roomName is never parsed for auth.
The Room Durable Object does not import Better Auth or billing code.
The Hono resolver is the phase 1 control-plane boundary.
Scoped sync tokens are not required in phase 1.
No Workspace head Y.Doc is required in phase 1.
docId root is tested as a normal valid docId with conventional app meaning.
docId, Y.Doc.guid, IndexedDB docName, BroadcastChannel name, and roomName collision cases are tested.
SyncEngine imports no Better Auth, Autumn, Workspace membership, or billing code.
Viewer live sync is not enabled until update frames are filtered.
Cloud v1 encryption is server-managed and must not be described as zero-knowledge.
```

## Execution Readiness

This spec is ready to execute as a narrow clean break if the implementation stays inside these limits:

```txt
Do:
  add Workspace/App/Doc sync routes
  use Better Auth organization membership as Workspace authorization
  build roomName from workspaceId + appId + docId
  keep Room and SyncEngine policy-free
  keep /rooms/:room only as a temporary compatibility route if needed

Do not:
  add app_instance
  add app_sync_doc
  add app_asset
  add scoped sync tokens
  add a Workspace head Y.Doc
  add app-level billing, disablement, migration, or dashboard state
```

The first implementation should change the route boundary and identity construction. It should not solve future Cloud app management.

## Implementation Notes

### 2026-05-20 Phase 1 Sync Route

Implemented the product-shaped sync route boundary in `apps/api`:

```txt
GET  /workspaces/:workspaceId/apps/:appId/docs/:docId
POST /workspaces/:workspaceId/apps/:appId/docs/:docId
POST /workspaces/:workspaceId/apps/:appId/docs/:docId/dispatch
```

The resolver validates `workspaceId`, `appId`, and `docId`, checks the Better Auth `member` table with `workspaceId = organization.id`, and builds opaque room names with:

```txt
v1:workspace:{workspaceId}:app:{appId}:doc:{docId}
```

Route compatibility remains for `/rooms/:room` because existing clients still depend on it. No `app_instance`, `app_sync_doc`, `app_asset`, scoped sync token, Workspace head Y.Doc, or app management table was added.

### 2026-05-21 Phase 2 Workspace API

Implemented the minimal Cloud Workspace product surface in `apps/api`:

```txt
GET /api/workspaces
```

Cloud Workspace remains backed by Better Auth `organization` and `member` rows. `workspaceId` is `organization.id`; the API does not expose Organization as a product noun. A deterministic personal Workspace is ensured during signup, `/api/session`, `/api/workspaces`, and first `/workspaces/*` use so older accounts are backfilled without a separate migration.

`/api/session` now includes `defaultWorkspaceId` for clients that need to open:

```txt
/workspaces/:workspaceId/apps/:appId/docs/root
```

No `cloud_workspace`, `workspace_member`, `app_instance`, `app_sync_doc`, `app_asset`, scoped sync token, or Workspace head Y.Doc was added.

### 2026-05-21 Phase 3 Client Adoption

Tab Manager now resolves the default Cloud Workspace through `/api/session.defaultWorkspaceId` and opens its root sync document at:

```txt
/workspaces/:workspaceId/apps/tab-manager/docs/root
```

`@epicenter/workspace` exposes a `workspaceAppDocWsUrl()` helper for the product-shaped WebSocket route while keeping `roomWsUrl()` for compatibility. Tab Manager uses the Workspace app doc URL when the default Workspace is known and falls back to `/rooms/:room` when the user is offline, signed out, or reauth is required before the default Workspace can be refreshed.

Auth keeps `defaultWorkspaceId` in memory after `/api/session` verification or sign-in. It does not persist the value into the local auth cell, so offline local workspace boot still depends only on `localIdentity`.

No `app_instance`, `app_sync_doc`, `app_asset`, scoped sync token, Workspace head Y.Doc, or Better Auth Organization product surface was added.

## Open Questions

1. Should the product API expose Better Auth `activeOrganizationId` as `activeWorkspaceId`, or should Epicenter keep active Workspace selection outside Better Auth session state?
2. Should every new Workspace show default apps in UI, or should app namespaces appear only after first use?
3. What exact product requirement would justify multiple instances of the same app in one Workspace?
4. Is app-level privacy needed in phase 1, or can every Workspace member open every app namespace?
5. What exact product field would justify a future `workspace_profile` table instead of Better Auth organization metadata?
6. What product requirement would justify `app_sync_doc` despite the app-owned root Y.Doc?
7. What product requirement would justify `app_asset` despite app-owned blob references?
8. Should a future user-held or customer-managed custody mode use `app_key_grant`, or should it require self-hosting/customer-managed deployment first?

## References

- Better Auth organization plugin grounding: https://deepwiki.com/search/for-the-organization-plugin-ca_4c544468-a46e-4704-8f77-7d3d09a08075
- Yjs document boundary grounding: https://deepwiki.com/search/for-an-app-with-a-hierarchy-wo_6e15f867-ab97-4d2e-8b3e-a7602ccda9ea
- y-indexeddb naming grounding: https://deepwiki.com/search/for-a-hierarchy-workspace-app_c29d43b0-e146-428b-af9f-6e2cafb92c8b
- Cloudflare Durable Object sync-doc grounding: https://deepwiki.com/search/for-cloudflare-durable-objects_f4afa7fa-3c24-4a3e-b47b-b108ea8d9417
- Yjs protocol host boundary grounding: https://deepwiki.com/search/for-a-workspace-app-instance-s_0ccef3e3-e831-411f-803f-73b7d9813832
- Linear Workspaces: https://linear.app/docs/workspaces
- Linear Teams: https://linear.app/docs/teams
- Supabase Platform: https://supabase.com/docs/guides/platform
- Supabase billing: https://supabase.com/docs/guides/platform/billing-on-supabase
