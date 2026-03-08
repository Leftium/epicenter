# User-Owned Rooms, Not Org-Scoped

Your CRDT sync server needs a room key for every document. The two obvious choices are `user:{userId}:{docId}` and `org:{orgId}:{docId}`. We went with user-scoped, and the reason has nothing to do with simplicity; it's that org-scoped doesn't actually solve the problem it claims to.

## The two models

Vercel, Supabase, PlanetScale: everything belongs to an org. Users always have a personal org. The room key is `org:{orgId}:{docId}`, and collaboration happens because everyone in the org points at the same backend resource.

Google Docs: every document has an owner. The document ID is globally unique. Sharing is an ACL entry that grants another user access to your document. There's no org boundary at the storage layer.

```ts
// Org-scoped: everyone in the org shares one Durable Object
const roomKey = `org:${orgId}:${workspaceId}`;

// User-owned: each user gets their own Durable Object
const roomKey = `user:${userId}:${workspaceId}`;
```

For a SaaS dashboard backed by a Postgres database, org-scoped is natural. Every row has an `org_id` foreign key. Queries filter by org. Permissions check membership. The org is the isolation boundary.

For a local-first app backed by Yjs CRDTs in Durable Objects, it breaks down.

## The Y.Doc is the permission boundary

A Postgres row can have per-row permissions. A Durable Object can't. When two users connect to the same DO, they get the same Y.Doc. Every change merges. There's no "this Y.Map key is private to user A."

That means if you go org-scoped and two users in the same org both have a workspace called `whispering`, their voice recordings merge into one Y.Doc. User A's transcriptions show up in User B's list. That's not a permissions bug you can patch; it's the architecture working as designed.

```
org:acme:whispering  ←  Alice's recordings AND Bob's recordings
                        merged into one Y.Doc. No way to un-merge.
```

The fix is adding a user sub-scope: `org:acme:user:alice:whispering`. Now you have two prefixing schemes and the org prefix is just overhead for personal workspaces. You added an org table, a member table, an invitation flow, and `activeOrganizationId` on the session, all to arrive at the same isolation you started with.

## Most workspaces are personal

This isn't theoretical. Look at actual workspace types:

| Workspace | Should data be shared? |
|---|---|
| Voice recordings (Whispering) | No |
| Journal entries | No |
| Browser tab manager | No |
| Shared project board | Yes |
| Team wiki | Yes |

The collaborative case is the exception. If your default is org-scoped, every personal workspace needs an escape hatch. If your default is user-scoped, the few collaborative workspaces need a sharing mechanism. The second approach has a smaller surface area.

## Enterprise self-hosted: the deployment is the org

The strongest argument for org-scoped was enterprise. Companies want to host your sync server, scope all data to their org, export it, audit it. An org prefix in the room key makes that clean.

But when an enterprise self-hosts, the deployment itself IS the org. Every user who can authenticate to that server is, by definition, in the organization. GitLab works this way. Outline works this way. Mattermost works this way. None of them embed org management in the self-hosted version. The server is the trust boundary.

```
Self-hosted deployment
├── User Alice  →  user:alice:whispering  (her recordings)
├── User Bob    →  user:bob:whispering    (his recordings)
└── Shared      →  user:alice:project-board  (Alice owns it, Bob has ACL access)

No org table. No member table. No activeOrganizationId.
The server boundary provides the isolation.
```

For a cloud multi-tenant offering, tenant isolation is a platform-layer concern: a routing prefix, a separate Cloudflare namespace, a subdomain. It doesn't need to be embedded in the app's data model. The app stays simple ("user has account, user accesses rooms") and works identically in both environments.

## Sharing without orgs

When you need collaboration, the Google Docs pattern works. The owner's room key doesn't change. An ACL table grants access:

```sql
CREATE TABLE workspace_access (
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  grantee_id TEXT NOT NULL,
  permission TEXT NOT NULL,  -- 'editor' | 'viewer'
  PRIMARY KEY (owner_id, workspace_id, grantee_id)
);
```

Auth middleware checks: is this user the owner, or do they have an ACL entry? If yes, route them to `user:{ownerId}:{workspaceId}`. Both users connect to the same DO, the same Y.Doc. Collaboration works because Yjs handles concurrent edits; the room key just needed to resolve to the same place.

```ts
const owner = c.req.query('owner') ?? c.var.user.id;
const roomKey = `user:${owner}:${room}`;

if (owner !== c.var.user.id) {
  const hasAccess = await checkAccess(owner, room, c.var.user.id);
  if (!hasAccess) return c.text('Forbidden', 403);
}
```

For self-hosted "share with everyone," a wildcard grantee handles it: `INSERT INTO workspace_access VALUES ('alice', 'project-board', '*', 'editor')`. No org abstraction required.

## The tradeoff you accept

Ownership transfer is the ugly part. If the owner deletes their account, you need to pick a new owner, migrate the DO (new room key = new DO instance, copy data), and update ACL entries. Google Docs handles this with admin tools. Org-scoped avoids it entirely because the org owns the data, not the user.

For a local-first app, this tradeoff makes sense. The user's device already has a full copy of the Y.Doc. The server is a sync relay, not the source of truth. Ownership transfer is a server-side key migration, not a data migration.

## When to revisit this

If Epicenter becomes primarily a team collaboration tool where shared workspaces outnumber personal ones, the cost/benefit flips. The Google Docs model optimizes for "mostly personal, sometimes shared." The org model optimizes for "mostly shared, sometimes personal." Pick the one that matches your product.
