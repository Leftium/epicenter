# API Namespace Restructure

**Date**: 2025-12-27
**Status**: Planning

## Overview

Restructure both the server REST API and client API to provide clearer namespacing while maintaining ergonomics.

### Goals

1. **Server API**: Organize endpoints hierarchically under workspace-scoped resources
2. **Client API**: Expose `$tables` and `$providers` while keeping actions at top level
3. **RESTful Tables**: Expose tables as traditional CRUD resources via HTTP
4. **Maintain Compatibility**: Actions still work, just at new URLs

---

## Part 1: Server API Restructure

### Current Structure

```
/                                    → API info
/openapi                             → Scalar docs
/sync/{workspaceId}                  → WebSocket sync
/workspaces/{workspaceId}/{action}   → Actions (flat)
```

### Proposed Structure

```
/                                    → API info
/openapi                             → Scalar docs

/workspaces/{workspaceId}/
├── actions/{actionName}             → POST mutations, GET queries
├── tables/{tableName}               → RESTful CRUD
│   ├── GET                          → List all rows
│   ├── POST                         → Create row (upsert)
│   └── {rowId}
│       ├── GET                      → Get single row
│       ├── PUT                      → Update row
│       └── DELETE                   → Delete row
├── sync                             → WebSocket (moved from /sync/{id})
└── blobs/
    └── {blobHash}
        ├── GET                      → Download blob
        └── PUT                      → Upload blob
```

### URL Examples

| Operation      | Current                            | Proposed                                      |
| -------------- | ---------------------------------- | --------------------------------------------- |
| Call action    | `POST /workspaces/blog/createPost` | `POST /workspaces/blog/actions/createPost`    |
| Query action   | `GET /workspaces/blog/getAllPosts` | `GET /workspaces/blog/actions/getAllPosts`    |
| List rows      | N/A                                | `GET /workspaces/blog/tables/posts`           |
| Get row        | N/A                                | `GET /workspaces/blog/tables/posts/abc123`    |
| Create row     | N/A                                | `POST /workspaces/blog/tables/posts`          |
| Update row     | N/A                                | `PUT /workspaces/blog/tables/posts/abc123`    |
| Delete row     | N/A                                | `DELETE /workspaces/blog/tables/posts/abc123` |
| WebSocket sync | `WS /sync/blog`                    | `WS /workspaces/blog/sync`                    |
| Get blob       | N/A                                | `GET /workspaces/blog/blobs/sha256:abc...`    |
| Put blob       | N/A                                | `PUT /workspaces/blog/blobs/sha256:abc...`    |

### Implementation Changes

#### 1. Update `server.ts` Route Generation

```typescript
// Current (server.ts:86-131)
for (const { workspaceId, actionPath, action } of iterActions(client)) {
	const path = `/workspaces/${workspaceId}/${actionPath.join('/')}`;
	// ...
}

// Proposed
for (const { workspaceId, actionPath, action } of iterActions(client)) {
	const path = `/workspaces/${workspaceId}/actions/${actionPath.join('/')}`;
	// ...
}
```

#### 2. Add Table Routes

```typescript
// New: Add RESTful table routes
for (const [workspaceId, workspaceClient] of Object.entries(workspaceClients)) {
	const tables = workspaceClient.$tables;

	for (const [tableName, tableHelper] of Object.entries(tables)) {
		const basePath = `/workspaces/${workspaceId}/tables/${tableName}`;

		// GET /tables/{tableName} - List all
		app.get(basePath, async () => {
			return tableHelper.getAllValid().map((row) => row.toJSON());
		});

		// GET /tables/{tableName}/{id} - Get one
		app.get(`${basePath}/:id`, async ({ params }) => {
			const result = tableHelper.get({ id: params.id });
			if (result.status === 'not_found') {
				return { status: 404, body: { error: 'Not found' } };
			}
			if (result.status === 'invalid') {
				return { status: 422, body: { error: result.error.message } };
			}
			return result.row.toJSON();
		});

		// POST /tables/{tableName} - Create/Upsert
		app.post(basePath, async ({ body }) => {
			tableHelper.upsert(body);
			return { success: true };
		});

		// PUT /tables/{tableName}/{id} - Update
		app.put(`${basePath}/:id`, async ({ params, body }) => {
			const result = tableHelper.update({ id: params.id, ...body });
			return result;
		});

		// DELETE /tables/{tableName}/{id} - Delete
		app.delete(`${basePath}/:id`, async ({ params }) => {
			const result = tableHelper.delete({ id: params.id });
			return result;
		});
	}
}
```

#### 3. Move Sync Endpoint

```typescript
// Current: createSyncPlugin has prefix '/sync'
// sync/index.ts:107
return new Elysia({ prefix: '/sync' }).ws('/:room', { ... });

// Proposed: No prefix, mount under workspace
function createWorkspaceSyncPlugin(workspaceId: string, getDoc: () => Y.Doc | undefined) {
  return new Elysia().ws(`/workspaces/${workspaceId}/sync`, {
    // ... same handlers
  });
}
```

#### 4. Add Blob Routes

```typescript
// New: Blob endpoints
for (const [workspaceId, workspaceClient] of Object.entries(workspaceClients)) {
	const basePath = `/workspaces/${workspaceId}/blobs`;

	// GET /blobs/{hash} - Download blob
	app.get(`${basePath}/:hash`, async ({ params }) => {
		const blob = await getBlobFromStore(params.hash);
		if (!blob) return { status: 404 };
		return new Response(blob, {
			headers: { 'Content-Type': blob.type },
		});
	});

	// PUT /blobs/{hash} - Upload blob
	app.put(`${basePath}/:hash`, async ({ params, body }) => {
		await putBlobToStore(params.hash, body);
		return { success: true };
	});
}
```

---

## Part 2: Client API Restructure

### Current Structure

```typescript
type WorkspaceClient<TActions> = TActions & {
	$ydoc: Y.Doc;
	destroy: () => Promise<void>;
	[Symbol.asyncDispose]: () => Promise<void>;
	// Browser only:
	whenSynced?: Promise<void>;
};
```

### Proposed Structure

```typescript
type WorkspaceClient<
	TActions extends Actions,
	TSchema extends WorkspaceSchema,
	TProviders extends WorkspaceProviderMap,
> = TActions & {
	// Existing
	$ydoc: Y.Doc;
	destroy: () => Promise<void>;
	[Symbol.asyncDispose]: () => Promise<void>;

	// New
	$tables: Tables<TSchema>;
	$providers: TProviders;

	// Browser only:
	whenSynced?: Promise<void>;
};
```

### Usage Examples

```typescript
const client = await createClient(blogWorkspace);

// Actions at top level (unchanged)
await client.createPost({ title: 'Hello' });
const posts = await client.getAllPosts();

// NEW: Direct table access via $tables
const result = client.$tables.posts.get({ id: '123' });
if (result.status === 'valid') {
	const ytext = result.row.content; // Y.Text for binding to editor
}

// NEW: Observe changes
client.$tables.posts.observe({
	onAdd: (result) => console.log('New post:', result),
	onUpdate: (result) => console.log('Updated:', result),
	onDelete: (id) => console.log('Deleted:', id),
});

// NEW: Provider access via $providers
const sqliteResults = await client.$providers.sqlite.posts.select().all();

// Existing: Y.Doc access
client.$ydoc.transact(() => {
	/* ... */
});

// Destructuring works great
const { createPost, $tables, $providers } = client;
const { posts, users } = $tables;
```

### Implementation Changes

#### 1. Update Type Definitions

**client.browser.ts:**

```typescript
export type WorkspaceClient<
	TActions extends Actions,
	TSchema extends WorkspaceSchema = WorkspaceSchema,
	TProviders extends WorkspaceProviderMap = WorkspaceProviderMap,
> = TActions & {
	$ydoc: Y.Doc;
	$tables: Tables<TSchema>;
	$providers: TProviders;
	whenSynced: Promise<void>;
	destroy: () => Promise<void>;
	[Symbol.asyncDispose]: () => Promise<void>;
};
```

**client.node.ts:**

```typescript
export type WorkspaceClient<
	TActions extends Actions,
	TSchema extends WorkspaceSchema = WorkspaceSchema,
	TProviders extends WorkspaceProviderMap = WorkspaceProviderMap,
> = TActions & {
	$ydoc: Y.Doc;
	$tables: Tables<TSchema>;
	$providers: TProviders;
	destroy: () => Promise<void>;
	[Symbol.asyncDispose]: () => Promise<void>;
};
```

**client.shared.ts:**

```typescript
type BaseWorkspaceClient = Actions & {
	$ydoc: Y.Doc;
	$tables: unknown; // Add
	$providers: unknown; // Add
	destroy: () => Promise<void>;
	[Symbol.asyncDispose]: () => Promise<void>;
};
```

#### 2. Update Client Creation

**In both client.browser.ts and client.node.ts:**

```typescript
// Current (around line 532-538 browser, 552-558 node)
clients.set(workspaceId, {
	...actions,
	$ydoc: ydoc,
	destroy: cleanup,
	[Symbol.asyncDispose]: cleanup,
});

// Proposed
clients.set(workspaceId, {
	...actions,
	$ydoc: ydoc,
	$tables: tables, // Add
	$providers: providers, // Add
	destroy: cleanup,
	[Symbol.asyncDispose]: cleanup,
});
```

#### 3. Update iterActions to Skip New Properties

**client.shared.ts:**

```typescript
export function* iterActions(
	client: BaseEpicenterClient,
): Generator<ActionInfo> {
	const {
		destroy: _destroy,
		[Symbol.asyncDispose]: _asyncDispose,
		...workspaceClients
	} = client;

	for (const [workspaceId, workspaceClient] of Object.entries(
		workspaceClients,
	)) {
		if (typeof workspaceClient === 'function') continue;

		const {
			destroy: _workspaceDestroy,
			[Symbol.asyncDispose]: _workspaceAsyncDispose,
			$ydoc: _$ydoc,
			$tables: _$tables, // Add
			$providers: _$providers, // Add
			...workspaceActions
		} = workspaceClient as BaseWorkspaceClient;

		for (const { path, action } of walkActions(workspaceActions)) {
			yield { workspaceId, actionPath: path, action };
		}
	}
}
```

---

## Part 3: Implementation Plan

### Phase 1: Client API (Low Risk) ✅

- [x] Update type definitions in `client.browser.ts`
- [x] Update type definitions in `client.node.ts`
- [x] Update `BaseWorkspaceClient` in `client.shared.ts`
- [x] Add `$tables` and `$providers` to client creation (both files)
- [x] Update `iterActions` to skip new properties
- [x] Run type checks and tests (no errors in client files)

### Phase 2: Server Actions Path (Medium Risk) ✅

- [x] Update route generation in `server.ts` to use `/actions/` prefix
- [x] Update MCP tool generation if needed (no changes needed - MCP uses action names, not paths)
- [x] Update tests (no tests use action URLs directly)
- [x] Update documentation (server README updated)

### Phase 3: RESTful Tables (New Feature) ✅

- [x] Create `createTablesPlugin()` function
- [x] Add GET (list), GET (single), POST, PUT, DELETE routes
- [x] Add input validation using table validators
- [x] Add proper error handling and status codes
- [x] Add to `createServer()` composition

### Phase 4: Move Sync Endpoint (Breaking Change) ✅

- [x] Refactor `createSyncPlugin` to accept workspace-scoped config
- [x] Update URL from `/sync/{workspaceId}` to `/workspaces/{workspaceId}/sync`
- [ ] Update `createWebsocketSyncProvider` to use new URL format (client-side - separate PR)
- [x] Update documentation

### Phase 5: Blob HTTP Endpoints (New Feature)

- [ ] Create `createBlobsPlugin()` function
- [ ] Add GET and PUT routes for blob access
- [ ] Integrate with existing blob storage system
- [ ] Add to `createServer()` composition

---

## Migration Guide

### For Client Users

```typescript
// No changes needed for action calls
client.createPost({ title: 'Hello' });  // Still works

// New capabilities available
client.$tables.posts.observe({ ... });
client.$providers.sqlite.posts.select();
```

### For Server/HTTP Users

```typescript
// Old URLs (deprecated but could add redirects)
POST /workspaces/blog/createPost
GET  /workspaces/blog/getAllPosts

// New URLs
POST /workspaces/blog/actions/createPost
GET  /workspaces/blog/actions/getAllPosts

// New table endpoints
GET  /workspaces/blog/tables/posts
GET  /workspaces/blog/tables/posts/abc123
POST /workspaces/blog/tables/posts
PUT  /workspaces/blog/tables/posts/abc123
DELETE /workspaces/blog/tables/posts/abc123

// Sync endpoint moved
WS /sync/blog           → WS /workspaces/blog/sync
```

---

## Open Questions

1. **Should we add backwards-compatible redirects?** Old action URLs could redirect to new `/actions/` URLs.

2. **Table validation on HTTP writes?** Should POST/PUT to tables validate against the schema, or accept any JSON?

3. **Blob endpoint auth?** Should blob uploads require any auth, or rely on content-addressing integrity?

4. **Read-only tables via HTTP?** Should we only expose GET for tables and require mutations to go through actions?

---

## Files to Modify

### Client API

- `packages/epicenter/src/core/workspace/client.browser.ts`
- `packages/epicenter/src/core/workspace/client.node.ts`
- `packages/epicenter/src/core/workspace/client.shared.ts`

### Server API

- `packages/epicenter/src/server/server.ts`
- `packages/epicenter/src/server/sync/index.ts`
- `packages/epicenter/src/server/index.ts` (exports)

### New Files

- `packages/epicenter/src/server/tables.ts` (RESTful tables plugin)
- `packages/epicenter/src/server/blobs.ts` (Blob HTTP plugin)

### Documentation

- `packages/epicenter/src/server/README.md`
- `packages/epicenter/README.md`
