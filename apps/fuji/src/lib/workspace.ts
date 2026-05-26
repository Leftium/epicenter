/**
 * Fuji workspace schema: id, branded types, table definitions, the workspace
 * factory, and per-row derived guids. Pure data. No Y.Doc, no encryption, no
 * openers.
 *
 * Distribution: `apps/fuji/package.json` exports this file as the
 * `@epicenter/fuji` package root. Browser code, daemon code, and tests all
 * import from here. The table shapes here are the wire contract for sync;
 * forking a column shape breaks sync compatibility with peers running the
 * canonical schema.
 *
 * Composition lives elsewhere:
 *  - `apps/fuji/src/lib/browser.ts`  → `openFujiBrowser({ signedIn, deviceId })`
 *  - `apps/fuji/daemon.ts`           → `openFujiDaemon(ctx)`
 *  - `examples/fuji/epicenter.config.ts` → canonical project layout composition
 *
 * The action registry lives in `./actions.ts` and is re-exported at the bottom
 * of this file so `@epicenter/fuji` exposes a single import surface.
 */

import {
	column,
	createWorkspace,
	defineTable,
	docGuid,
	type IanaTimeZone,
	type InferTableRow,
	type Keyring,
} from '@epicenter/workspace';
import { Type } from 'typebox';
import type { Brand } from 'wellcrafted/brand';

export const FUJI_ID = 'epicenter.fuji';

export type EntryId = string & Brand<'EntryId'>;

/**
 * Syntactic sugar for `value as EntryId`. The constrained `string` parameter
 * is what earns it over a raw `as` cast (callers can't widen to `unknown`).
 * The only place in the codebase where `as EntryId` should appear.
 */
export const asEntryId = (value: string): EntryId => value as EntryId;

const entriesTable = defineTable(
	// v1
	{
		id: column.string<EntryId>(),
		title: column.string(),
		subtitle: column.string(),
		type: column.json(Type.Array(Type.String())),
		tags: column.json(Type.Array(Type.String())),
		pinned: column.boolean(),
		deletedAt: column.nullable(column.dateTime()),
		date: column.dateTime(),
		createdAt: column.dateTime(),
		updatedAt: column.dateTime(),
	},
	// v2 — added rating
	{
		id: column.string<EntryId>(),
		title: column.string(),
		subtitle: column.string(),
		type: column.json(Type.Array(Type.String())),
		tags: column.json(Type.Array(Type.String())),
		pinned: column.boolean(),
		deletedAt: column.nullable(column.dateTime()),
		date: column.dateTime(),
		createdAt: column.dateTime(),
		updatedAt: column.dateTime(),
		rating: column.number(),
	},
	// v3 — split user-meaningful `date` into UTC `date` + IANA `dateZone`.
	// `date` is the canonical UTC instant; `dateZone` carries the originating
	// IANA zone so display code can render the user's local wall-clock time.
	// Per the workspace `<field>` + `<field>Zone` convention.
	{
		id: column.string<EntryId>(),
		title: column.string(),
		subtitle: column.string(),
		type: column.json(Type.Array(Type.String())),
		tags: column.json(Type.Array(Type.String())),
		pinned: column.boolean(),
		deletedAt: column.nullable(column.dateTime()),
		date: column.dateTime(),
		dateZone: column.ianaTimeZone(),
		createdAt: column.dateTime(),
		updatedAt: column.dateTime(),
		rating: column.number(),
	},
).migrate(({ value, version }) => {
	switch (version) {
		case 1:
			return { ...value, rating: 0, dateZone: 'UTC' as IanaTimeZone };
		case 2:
			return { ...value, dateZone: 'UTC' as IanaTimeZone };
		case 3:
			return value;
	}
});

export type Entry = InferTableRow<typeof entriesTable>;

/**
 * Build a Fuji workspace bundle: `{ ydoc, tables, kv, [Symbol.dispose] }`.
 *
 * Encrypted under the supplied keyring; the same factory is used in both
 * browser and daemon entrypoints.
 */
export function createFujiWorkspace(opts: { keyring: () => Keyring }) {
	return createWorkspace({
		id: FUJI_ID,
		keyring: opts.keyring,
		tables: { entries: entriesTable },
		kv: {},
	});
}
export type FujiWorkspace = ReturnType<typeof createFujiWorkspace>;

/**
 * Deterministic guid of an entry's rich-text content sub-doc.
 *
 * Browser editors, daemon materializers, and wipe paths reach this same
 * function so every layer points at the same Y.Doc identity.
 */
export function entryContentDocGuid(entryId: EntryId): string {
	return docGuid({
		workspaceId: FUJI_ID,
		collection: 'entries',
		rowId: entryId,
		field: 'content',
	});
}

export { createFujiActions, type FujiActions } from './actions';
