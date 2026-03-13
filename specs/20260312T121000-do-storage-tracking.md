# DO Storage Tracking Registry

**Status:** In Progress
**Scope:** 3 files modified, 1 migration generated, 2 atomic commits

## Problem

No visibility into which Durable Object instances exist per user, what type they are, or how much storage they consume. A user dashboard needs this data to show storage usage. The Worker already accesses DOs on every request—we just need to record the access and piggyback storage size on existing RPC responses.

## Architecture Decisions

1. **Single table** `durable_object_instance` with `do_type` discriminator
2. **Composite PK**: `(userId, doType, resourceName)`—not `doName` alone
3. **`doName` as a regular column** with UNIQUE constraint (not PK)
4. **`resourceName` denormalized** for queryable display without parsing `doName`
5. **Both `createdAt` + `lastAccessedAt`** timestamps retained
6. **Separate `storageMeasuredAt`** from `lastAccessedAt`—storage isn't measured on every access (e.g. WebSocket upgrades)
7. **Piggyback storage size** on existing `sync()` and `getDoc()` RPC responses—no separate RPC
8. **`afterResponse` queue pattern** in DB middleware—ensures upsert completes before `client.end()` without blocking the HTTP response
9. **Skip snapshot route tracking** in v1—any document access via `getDoc()`/`sync()` captures the instance before snapshots are used
10. **WebSocket upgrades** upsert `lastAccessedAt` only (no `storageBytes`)—next HTTP call fills in storage

## Implementation Plan

### Task 1: Schema definition + migration

- [x] Add imports to `schema.ts`: `bigint`, `primaryKey`, `uniqueIndex` from `drizzle-orm/pg-core`
- [x] Add `durableObjectInstance` table definition
- [x] Add `durableObjectInstanceRelations`
- [x] Add `durableObjectInstances: many(durableObjectInstance)` to `userRelations`
- [x] Generate migration via `bun run db:generate` from `apps/api/`
- [x] Verify generated SQL looks correct

**Table definition:**

```typescript
export const durableObjectInstance = pgTable(
	'durable_object_instance',
	{
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		doType: text('do_type').notNull(),
		resourceName: text('resource_name').notNull(),
		doName: text('do_name').notNull(),
		storageBytes: bigint('storage_bytes', { mode: 'number' }),
		createdAt: timestamp('created_at').defaultNow().notNull(),
		lastAccessedAt: timestamp('last_accessed_at').defaultNow().notNull(),
		storageMeasuredAt: timestamp('storage_measured_at'),
	},
	(table) => [
		primaryKey({
			columns: [table.userId, table.doType, table.resourceName],
		}),
		uniqueIndex('doi_do_name_idx').on(table.doName),
		index('doi_user_id_idx').on(table.userId),
	],
);
```

**Relations:**

```typescript
export const durableObjectInstanceRelations = relations(
	durableObjectInstance,
	({ one }) => ({
		user: one(user, {
			fields: [durableObjectInstance.userId],
			references: [user.id],
		}),
	}),
);
```

**Existing `userRelations` addition:**

```typescript
// Add to the existing userRelations spread:
durableObjectInstances: many(durableObjectInstance),
```

**Verification:**
- `bun run db:generate` from `apps/api/` succeeds
- Generated SQL contains `CREATE TABLE "durable_object_instance"` with composite PK, unique index on `do_name`, and index on `user_id`
- `bun run typecheck` from `apps/api/` passes

### Task 2: DO RPC return type changes (`base-sync-room.ts`)

- [ ] Change `sync()` return type from `Promise<Uint8Array | null>` to `Promise<{ diff: Uint8Array | null; storageBytes: number }>`
- [ ] Change `getDoc()` return type from `Promise<Uint8Array>` to `Promise<{ data: Uint8Array; storageBytes: number }>`
- [ ] Read `this.ctx.storage.sql.databaseSize` in each method

**`sync()` change (base-sync-room.ts:244–257):**

```typescript
async sync(body: Uint8Array): Promise<{ diff: Uint8Array | null; storageBytes: number }> {
	const { stateVector: clientSV, update } = decodeSyncRequest(body);

	if (update.byteLength > 0) {
		Y.applyUpdateV2(this.doc, update, 'http');
	}

	const serverSV = Y.encodeStateVector(this.doc);
	const diff = stateVectorsEqual(serverSV, clientSV)
		? null
		: Y.encodeStateAsUpdateV2(this.doc, clientSV);

	return { diff, storageBytes: this.ctx.storage.sql.databaseSize };
}
```

**`getDoc()` change (base-sync-room.ts:266–268):**

```typescript
async getDoc(): Promise<{ data: Uint8Array; storageBytes: number }> {
	return {
		data: Y.encodeStateAsUpdateV2(this.doc),
		storageBytes: this.ctx.storage.sql.databaseSize,
	};
}
```

**Verification:**
- `bun run typecheck` from `apps/api/` passes (will fail until Task 3 updates callers—Tasks 2+3 are in the same commit)

### Task 3: Worker upsert logic (`app.ts`)

Three sub-tasks: afterResponse middleware, upsert helper, route handler modifications.

#### 3a: afterResponse queue in DB middleware

- [ ] Add `afterResponse: Promise<unknown>[]` to `Env.Variables`
- [ ] Initialize the array and set it on context in the DB middleware
- [ ] Change `finally` block to `Promise.allSettled(afterResponse).then(() => client.end())`

**Env type change (app.ts:34–42):**

```typescript
export type Env = {
	Bindings: Cloudflare.Env;
	Variables: {
		db: Db;
		auth: Auth;
		user: Session['user'];
		session: Session['session'];
		afterResponse: Promise<unknown>[];
	};
};
```

**DB middleware change (app.ts:166–177):**

```typescript
app.use('*', async (c, next) => {
	const client = new pg.Client({
		connectionString: c.env.HYPERDRIVE.connectionString,
	});
	const afterResponse: Promise<unknown>[] = [];
	try {
		await client.connect();
		c.set('db', drizzle(client, { schema }));
		c.set('afterResponse', afterResponse);
		await next();
	} finally {
		c.executionCtx.waitUntil(
			Promise.allSettled(afterResponse).then(() => client.end()),
		);
	}
});
```

#### 3b: Upsert helper function

- [ ] Add `upsertDoInstance` function in `app.ts` (above the route definitions, below the factory)

```typescript
/**
 * Fire-and-forget upsert for DO instance tracking.
 *
 * Records that a user accessed a DO, optionally updating storage bytes.
 * Uses INSERT ON CONFLICT so the first access creates the row and
 * subsequent accesses update `lastAccessedAt` (and `storageBytes` when
 * provided). Errors are caught and logged—this is best-effort telemetry,
 * not billing authority.
 */
function upsertDoInstance(
	db: Db,
	params: {
		userId: string;
		doType: string;
		resourceName: string;
		doName: string;
		storageBytes?: number;
	},
): Promise<unknown> {
	const now = new Date();
	return db
		.insert(schema.durableObjectInstance)
		.values({
			userId: params.userId,
			doType: params.doType,
			resourceName: params.resourceName,
			doName: params.doName,
			storageBytes: params.storageBytes ?? null,
			lastAccessedAt: now,
			storageMeasuredAt: params.storageBytes != null ? now : null,
		})
		.onConflictDoUpdate({
			target: [
				schema.durableObjectInstance.userId,
				schema.durableObjectInstance.doType,
				schema.durableObjectInstance.resourceName,
			],
			set: {
				lastAccessedAt: now,
				...(params.storageBytes != null && {
					storageBytes: params.storageBytes,
					storageMeasuredAt: now,
				}),
			},
		})
		.catch((e) => console.error('[do-tracking] upsert failed:', e));
}
```

#### 3c: Route handler modifications

- [ ] `GET /workspaces/:workspace` — destructure `getDoc()` result, add upsert (with storageBytes for HTTP, without for WS)
- [ ] `POST /workspaces/:workspace` — destructure `sync()` result, add upsert with storageBytes
- [ ] `GET /documents/:document` — same pattern as workspace GET
- [ ] `POST /documents/:document` — same pattern as workspace POST

**Pattern for GET routes (using workspace as example, document is identical with `'document'` doType):**

```typescript
app.get(
	'/workspaces/:workspace',
	describeRoute({
		description: 'Get workspace doc or upgrade to WebSocket',
		tags: ['workspaces'],
	}),
	async (c) => {
		const stub = getWorkspaceStub(c);

		if (c.req.header('upgrade') === 'websocket') {
			c.var.afterResponse.push(
				upsertDoInstance(c.var.db, {
					userId: c.var.user.id,
					doType: 'workspace',
					resourceName: c.req.param('workspace'),
					doName: `user:${c.var.user.id}:${c.req.param('workspace')}`,
				}),
			);
			return stub.fetch(c.req.raw);
		}

		const { data, storageBytes } = await stub.getDoc();
		c.var.afterResponse.push(
			upsertDoInstance(c.var.db, {
				userId: c.var.user.id,
				doType: 'workspace',
				resourceName: c.req.param('workspace'),
				doName: `user:${c.var.user.id}:${c.req.param('workspace')}`,
				storageBytes,
			}),
		);
		return new Response(data, {
			headers: { 'content-type': 'application/octet-stream' },
		});
	},
);
```

**Pattern for POST routes (using workspace as example):**

```typescript
app.post(
	'/workspaces/:workspace',
	describeRoute({
		description: 'Sync workspace doc',
		tags: ['workspaces'],
	}),
	async (c) => {
		const body = new Uint8Array(await c.req.arrayBuffer());
		if (body.byteLength > MAX_PAYLOAD_BYTES) {
			return c.body('Payload too large', 413);
		}

		const stub = getWorkspaceStub(c);
		const { diff, storageBytes } = await stub.sync(body);

		c.var.afterResponse.push(
			upsertDoInstance(c.var.db, {
				userId: c.var.user.id,
				doType: 'workspace',
				resourceName: c.req.param('workspace'),
				doName: `user:${c.var.user.id}:${c.req.param('workspace')}`,
				storageBytes,
			}),
		);

		if (!diff) return c.body(null, 304);
		return new Response(diff, {
			headers: { 'content-type': 'application/octet-stream' },
		});
	},
);
```

**Verification:**
- `bun run typecheck` from `apps/api/` passes
- All 4 main routes (`GET`/`POST` for workspaces + documents) include upsert calls
- WebSocket upgrade paths only pass `lastAccessedAt` (no `storageBytes`)
- HTTP paths pass `storageBytes` from DO RPC response

## Atomic Commit Strategy

### Commit 1: `feat(api): add durable_object_instance schema and migration`

**Files:**
- `apps/api/src/db/schema.ts` — new table + relations + updated `userRelations`
- `apps/api/drizzle/0001_*.sql` — generated migration

**Why separate:** Schema is a DB-only change. The new table doesn't affect existing code. Can be deployed (migration applied) independently before the runtime change ships.

### Commit 2: `feat(api): track DO instances with storage size on every access`

**Files:**
- `apps/api/src/base-sync-room.ts` — `sync()` and `getDoc()` return `{ data/diff, storageBytes }`
- `apps/api/src/app.ts` — `afterResponse` queue, `upsertDoInstance` helper, route handler updates

**Why together:** The RPC return type change and the Worker code that destructures the new shape must ship atomically. If deployed separately, the Worker would try to use a `Uint8Array` as a `{ data, storageBytes }` object (or vice versa).

## Data Flow Diagram

```
Client                    Worker (app.ts)              DO (base-sync-room.ts)      Postgres
  │                           │                              │                        │
  │── POST /workspaces/foo ──▶│                              │                        │
  │                           │── stub.sync(body) ──────────▶│                        │
  │                           │                              │ apply update            │
  │                           │                              │ read databaseSize       │
  │                           │◀── { diff, storageBytes } ──│                        │
  │                           │                              │                        │
  │                           │ push upsert to afterResponse │                        │
  │◀── Response(diff) ───────│                              │                        │
  │                           │                              │                        │
  │                           │──── (waitUntil) upsert ─────────────────────────────▶│
  │                           │                              │                        │ INSERT ON
  │                           │                              │                        │ CONFLICT
  │                           │◀─── (waitUntil) client.end() ◀──────────────────────│
```

## Not in Scope (v1)

- **Snapshot route tracking** — covered by `getDoc()`/`sync()` accesses
- **Upsert throttling** — add later if traffic warrants it
- **Deletion cleanup** — when DOs are deleted, rows become stale; a future cleanup job can handle this
- **Dashboard query endpoint** — separate feature; this spec only covers the write path

## Review

_To be filled in after implementation._
