# Cloud Workspace App Instance Clean Break

**Date**: 2026-05-20
**Status**: Draft
**Author**: Epicenter

## Overview

Epicenter Cloud should make Workspace the product account surface and App Instance the durable app boundary. In phase 1, Cloud Workspace identity is Better Auth organization identity: `workspaceId` is `organization.id`. App Instances live below that row and anchor one app's root Y.Doc namespace.

This supersedes the Cloud ownership direction in `specs/20260520T170000-cloud-workspaces-and-organizations-clean-break.md`. That spec kept Workspace as the data boundary and Organization as the team, policy, and billing boundary. This spec collapses that split: the product noun is Workspace, Better Auth organization is the backing row, and App Instance becomes the lower data boundary.

## One Sentence

Epicenter Cloud Workspaces are Better Auth organizations presented as Workspaces; App Instances anchor app-owned root Y.Docs; Rooms coordinate Yjs sync.

## Mental Model

```txt
User =
  a human login identity

Cloud Workspace =
  the product account surface
  same id as Better Auth organization
  owns members, invitations, billing, policy, and app instances

App =
  an app definition or package, such as Whispering or Tab Manager

App Instance =
  one workspace-local copy of an app
  anchors that app's root Y.Doc namespace inside the Cloud Workspace

Sync Doc =
  one independently synced Y.Doc inside an App Instance
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
  each Cloud Workspace can contain app instances.

Sync:
  each app instance opens a root Sync Doc.
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
  one required Epicenter-owned table: app_instance
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
    moves the Cloud app namespace below Workspace into App Instance

  specs/20260519T155705-workspace-noun-clean-break.md
    keeps Workspace as the daily product noun
    rejects the owner_user_id / owner_organization_id SQL shape for Cloud

  specs/20260520T001032-workspace-capsule-clean-break.md
    keeps the capsule pressure test for local and portable app data
    maps the Cloud app capsule to App Instance plus root Y.Doc

  specs/20260520T130000-workspace-portability-design-brief.md
    keeps portability requirements
    applies them to the app-owned root Y.Doc inside an App Instance

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

That names personal sync. It does not name a Cloud Workspace, app instance, or sync doc.

## Desired Shape

```txt
request
  -> authenticate user
  -> resolve Cloud Workspace
  -> check Better Auth organization membership
  -> resolve App Instance
  -> resolve app-owned Sync Doc identity
  -> build internal roomName
  -> Room Durable Object
```

The public route should name product resources:

```txt
GET  /workspaces/:workspaceId/apps/:appInstanceId/docs/:docId
POST /workspaces/:workspaceId/apps/:appInstanceId/docs/:docId
WS   /workspaces/:workspaceId/apps/:appInstanceId/docs/:docId
POST /workspaces/:workspaceId/apps/:appInstanceId/docs/:docId/dispatch
```

The internal room name should name the authorized sync doc:

```txt
v1:workspace:{workspaceId}:app:{appInstanceId}:doc:{docId}
```

`v1:` is worth keeping. It is not user-facing API. It is an internal Durable Object naming protocol. The prefix gives future room-name migrations a clean boundary if we need epochs, sharding, custody-mode splits, or a different sync-doc identity format.

## Why Not Just App

Use `App` for the app definition:

```txt
App:
  Whispering
  Tab Manager
  future app package from jsrepo or a local project
```

Use `App Instance` for the workspace-local copy:

```txt
App Instance:
  Whispering inside Braden's Cloud Workspace
  Whispering inside Epicenter's Cloud Workspace
  Tab Manager inside Epicenter's Cloud Workspace
```

This distinction matters because each Workspace needs its own app namespace. The same app definition can exist in many workspaces, and a future Workspace may contain more than one instance of the same app for different purposes.

Cloud should not use App Instance as a shadow app database. The app's root Y.Doc remains the semantic source of truth for app records, child doc references, and blob references.

Creation should be idempotent:

```txt
User opens an app in a Cloud Workspace
  -> Cloud ensures an App Instance exists
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

The storage invariant is smaller than earlier drafts: Cloud owns the App Instance namespace; the app owns the Yjs document graph and blob references inside that namespace.

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

Do not map App Instance to Better Auth team. Better Auth teams are people groupings inside an organization. App Instances are data containers inside a Workspace.

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

Epicenter should use App Instance like Supabase and Vercel use Project:

```txt
App Instance =
  the concrete app data unit inside that place
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

The smaller Cloud data unit is App Instance. Inside it, the app should usually start with one root Y.Doc.

```txt
App Instance:
  Whispering inside Braden's Workspace

Root Sync Doc:
  docId = root
  contains recordings, transformations, settings, blob references
```

Yjs and y-indexeddb both make identity collisions expensive. A `Y.Doc.guid` is document identity metadata, not authorization. `y-indexeddb` persists by the `docName` string passed to `IndexeddbPersistence`, not by `Y.Doc.guid`. Two logical docs that share persistence names or receive the same updates will converge.

So the sync identity must include the full hierarchy:

```txt
syncDocIdentity =
  workspaceId + "/" + appInstanceId + "/" + docId

Y.Doc.guid =
  syncDocIdentity, or a documented legacy guid mapped to it

IndexedDB docName =
  owner-scoped syncDocIdentity

BroadcastChannel name =
  owner-scoped syncDocIdentity

roomName =
  v1:workspace:{encodedWorkspaceId}:app:{encodedAppInstanceId}:doc:{encodedDocId}
```

The sync protocol does not know any of these ids. The host authorizes the request, builds the room name, and passes bytes to the sync engine.

Cloud does not need a relational row for every Sync Doc by default. The app root Y.Doc owns the app's semantic document graph. Extra Sync Docs are app-owned choices, not Cloud control-plane records.

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
│ App Instance                                 │
│ workspace-local copy of one app definition   │
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

Epicenter owns one required Cloud app table below that: `app_instance`. It is a containment and namespace table, not a duplicate app database. The app root Y.Doc owns app records, child doc references, and blob references.

```sql
create table app_instance (
  id text primary key,
  workspace_id text not null references organization(id) on delete cascade,
  app_id text not null,
  created_at timestamp not null default now()
);

create index app_instance_workspace_id_idx
  on app_instance(workspace_id);

create unique index app_instance_workspace_app_id_idx
  on app_instance(workspace_id, app_id);
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

App Instance access in phase 1 =
  any Workspace member can open any App Instance

Custody in phase 1 =
  server-managed encryption, not zero-knowledge
```

Future private apps and user-held keys should not be compressed into `app_instance` metadata.

```txt
Private app access:
  app_instance_member may earn itself

User-held or customer-managed keys:
  app_key_grant may earn itself
```

## Route Flow

```txt
GET /workspaces/:workspaceId/apps/:appInstanceId/docs/:docId
  -> authenticate user
  -> require Better Auth member in organization workspaceId
  -> require app_instance.workspace_id = workspaceId
  -> build roomName
  -> if WebSocket upgrade, hand to Room
  -> else return snapshot

POST /workspaces/:workspaceId/apps/:appInstanceId/docs/:docId
  -> same resolver
  -> sync.handleHttpSync(request, { roomName })

POST /workspaces/:workspaceId/apps/:appInstanceId/docs/:docId/dispatch
  -> same resolver
  -> rooms.dispatch(roomName, body)
```

The resolver returns the authorized sync target:

```ts
type AuthorizedSyncDoc = {
  workspaceId: string;
  appInstanceId: string;
  docId: string;
  role: 'owner' | 'admin' | 'member';
};
```

The common doc id is `root`.

```txt
/workspaces/:workspaceId/apps/:appInstanceId/docs/root
```

Additional doc ids are app-owned. Cloud authorizes the App Instance boundary and constructs a room name; it does not need to know what a child doc means.

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

App Instance:
  Cloud namespace and containment row for one app

Sync Doc:
  independently synced Y.Doc
  usually the root Y.Doc for an App Instance

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

`App Installation` sounds like package management. `App Instance` names the workspace-local namespace for an app. The app may be created explicitly by an Add App command or lazily by first use. Either way, the resulting Cloud containment boundary is the same.

## Billing

Billing attaches to Cloud Workspace.

```txt
Autumn customerId =
  workspace:{workspaceId}

workspaceId =
  Better Auth organization.id

Usage event properties =
  workspaceId
  appInstanceId
  appId
  docId when useful
```

Personal and team billing use the same model:

```txt
Personal:
  one-member Cloud Workspace pays for its app instances

Team:
  multi-member Cloud Workspace pays for its app instances
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

Do not add a `key_policy` column while there is only one mode. Add `custody_mode` to `app_instance` only when a second real mode exists.

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

App Instance
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
  -> app instances
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

Packages should remain inversion-of-control friendly. `packages/workspace` should not import Better Auth organization, Autumn billing, or Cloud Workspace schema. Local apps open local app data; Cloud maps that data into App Instances.

Apps own their document graph in every deployment mode. Cloud does not need to understand Whispering recordings, transcript docs, or blob relationships to sync them.

## Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Public product noun | 2 coherence | Workspace | Matches Notion and Linear. Users enter workspaces, invite members, and pay for them. |
| Auth backing row | 1 evidence | Better Auth organization.id is workspaceId | Better Auth already provides organization, member, invitation, activeOrganizationId, and optional teams. A duplicate Cloud Workspace table does not earn itself in phase 1. |
| Required Epicenter Cloud table | 1 evidence | app_instance only | Cloud needs containment below Workspace. App data, doc graph, and blob references stay in the app root Y.Doc. |
| App versus App Instance | 2 coherence | Use both | App names the definition. App Instance names the workspace-local namespace. |
| App Instance creation | 3 taste | Idempotent ensure-on-first-use, explicit Add App can call same path | Supports Notion-like sidebar use without making installation a package-management ceremony. |
| Room-name version | 2 coherence | Prefix internal names with `v1:` | It gives migration room for epochs, sharding, custody modes, or identity format changes without public route churn. |
| Root document | 2 coherence | One root Y.Doc per App Instance | The root Y.Doc is the app-owned entry point and semantic index. |
| Sync grain | 1 evidence | One Room per opened Sync Doc | Yjs sync and Cloudflare DO coordination fit per-doc boundaries. Cloud does not need a Postgres row for each doc. |
| Read-only live sync | Deferred | Snapshot-only until frame filtering exists | Yjs protocol does not enforce read-only peers by itself. |
| Better Auth teams | Deferred | Do not map to App Instance | Teams are people groupings, not app data boundaries. |
| Workspace profile table | Deferred | Add only when product fields earn it | Start with Better Auth organization metadata and add a 1:1 profile table only for real Workspace fields. |
| App asset table | Deferred | Avoid by default | Apps own blob references in Yjs. Cloud object storage can stay opaque and prefix-addressed. |
| Key grants | Deferred | Server-managed only in phase 1 | True user-held or customer-managed keys need an earned grant store later. |

## Implementation Plan

### Phase 1: Spec And Vocabulary

- [ ] **1.1** Mark older Cloud ownership specs as superseded by this model.
- [ ] **1.2** Rename Cloud product language from Organization to Workspace.
- [ ] **1.3** Reserve App Instance for workspace-local app namespaces.
- [ ] **1.4** Keep App for app definitions and packages.

### Phase 2: Better Auth Organization As Workspace

- [ ] **2.1** Enable Better Auth organization plugin for Cloud Workspaces.
- [ ] **2.2** Create a personal Cloud Workspace as a one-member organization during signup or first Cloud use.
- [ ] **2.3** Expose Workspace APIs that wrap Better Auth organization APIs.
- [ ] **2.4** Keep Better Auth organization naming below the product API boundary.
- [ ] **2.5** Do not create `cloud_workspace`, `workspace_member`, `workspace_invitation`, or `workspace_role` tables.
- [ ] **2.6** Defer `workspace_profile` until Workspace owns product fields that Better Auth organization metadata should not carry.

### Phase 3: App Instance Tables

- [ ] **3.1** Add `app_instance`.
- [ ] **3.2** Add idempotent `ensureAppInstance` service.
- [ ] **3.3** Do not add `app_sync_doc`, `app_asset`, `app_instance_member`, `app_key_grant`, or `billing_cache` in phase 1.
- [ ] **3.4** Keep app display metadata, child doc references, and blob references in the app root Y.Doc unless a Cloud operation earns a table.

### Phase 4: Workspace App Sync Routes

- [ ] **4.1** Add `/workspaces/:workspaceId/apps/:appInstanceId/docs/:docId`.
- [ ] **4.2** Add `/workspaces/:workspaceId/apps/:appInstanceId/docs/:docId/dispatch`.
- [ ] **4.3** Build `roomName` with `v1:` and encoded route parts.
- [ ] **4.4** Keep SyncEngine policy-free.
- [ ] **4.5** Use `docs/root` as the default App Instance entry point.

### Phase 5: Cleanup

- [ ] **5.1** Remove public `/rooms/:room` as the Cloud sync route.
- [ ] **5.2** Remove subject-scoped room names from Cloud product routes.
- [ ] **5.3** Remove owner-user versus owner-organization workspace schema proposals from active Cloud plans.

## Test And Migration Invariants

Even in a clean break, these should become tests or migration gates.

```txt
Every Cloud Workspace has at least one owner/admin member.
Cloud Workspace identity is Better Auth organization.id in phase 1.
No duplicate Cloud Workspace membership, invitation, role, owner, billing, or policy tables are added in phase 1.
Every App Instance belongs to exactly one Cloud Workspace.
Every App Instance has a root Sync Doc address.
Cloud does not require a persisted Sync Doc inventory row in phase 1.
Cloud does not require an app asset table in phase 1.
The sync route rejects users who are not members of the backing Better Auth organization.
The sync route rejects App Instance ids outside the requested Workspace.
roomName is built by one host-owned function.
roomName includes a version prefix.
roomName is never parsed for auth.
docId, Y.Doc.guid, IndexedDB docName, BroadcastChannel name, and roomName collision cases are tested.
SyncEngine imports no Better Auth, Autumn, Workspace membership, or billing code.
Viewer live sync is not enabled until update frames are filtered.
Cloud v1 encryption is server-managed and must not be described as zero-knowledge.
```

## Open Questions

1. Should the product API expose Better Auth `activeOrganizationId` as `activeWorkspaceId`, or should Epicenter keep active Workspace selection outside Better Auth session state?
2. Should every new Workspace get default App Instances, or should apps be created only on first use?
3. Can a Workspace contain multiple App Instances for the same App in phase 1?
4. Is app-level privacy needed in phase 1, or can every Workspace member open every App Instance?
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
