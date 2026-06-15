/**
 * Tests for `bindChildDocs`: the runtime half of the row-declared child docs.
 *
 * Verifies the binding reads each table's `childDocLayouts`, exposes a per-row
 * accessor keyed `bound.<table>.<field>`, derives the body guid from the row id
 * (matching {@link docGuid}), shares one doc per row across opens, and tears
 * every cache down on a single top-level dispose. Local storage uses
 * `fake-indexeddb`; the parked socket exercises the runtime without a relay.
 */

import { describe, expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { asOwnerId } from '@epicenter/identity';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import * as Y from 'yjs';
import { attachPlainText } from './attach-plain-text.js';
import { bindChildDocs } from './bind-child-docs.js';
import { type ChildDocConnection } from './create-child-docs.js';
import { defineTable } from './define-table.js';
import { asDeviceId } from './device-id.js';
import { docGuid } from './doc-guid.js';

Object.assign(globalThis, { indexedDB, IDBKeyRange });

/** Parked WebSocket: stays CONNECTING until `close()`, which `ydoc.destroy()` triggers. */
function fakeWebSocket(): Promise<WebSocket> {
	const ws = {
		readyState: 0,
		onclose: null as ((e: CloseEvent) => void) | null,
		close() {
			if (ws.readyState === 3) return;
			ws.readyState = 3;
			ws.onclose?.({ code: 1000, reason: '' } as CloseEvent);
		},
	};
	return Promise.resolve(ws as unknown as WebSocket);
}

const connection: ChildDocConnection = {
	server: 'api.test.invalid',
	baseURL: 'https://api.test.invalid',
	ownerId: asOwnerId('owner-1'),
	openWebSocket: fakeWebSocket,
	onReconnectSignal: () => () => {},
	deviceId: asDeviceId('device-1'),
};

const WORKSPACE_ID = 'epicenter-test';

/** A workspace with one table that declares a single plain-text body. */
function setup() {
	const tables = {
		entries: defineTable({
			id: field.string(),
			title: field.string(),
		}).childDocs({ content: attachPlainText }),
	};
	const ydoc = new Y.Doc({ guid: WORKSPACE_ID, gc: true });
	return { tables, workspace: { ydoc } };
}

describe('bindChildDocs', () => {
	test('exposes an accessor per declared body, keyed by table and field', () => {
		const { tables, workspace } = setup();
		const childDocs = bindChildDocs({ tables, workspace, connection });
		try {
			expect(typeof childDocs.entries.content.open).toBe('function');
		} finally {
			childDocs[Symbol.dispose]();
		}
	});

	test('open(rowId) derives the body guid from the row id', () => {
		const { tables, workspace } = setup();
		const childDocs = bindChildDocs({ tables, workspace, connection });
		const handle = childDocs.entries.content.open('row-1');
		try {
			expect(handle.guid).toBe(
				docGuid({
					workspaceId: WORKSPACE_ID,
					collection: 'entries',
					rowId: 'row-1',
					field: 'content',
				}),
			);
		} finally {
			handle[Symbol.dispose]();
			childDocs[Symbol.dispose]();
		}
	});

	test('same row id shares one underlying doc; different rows are independent', () => {
		const { tables, workspace } = setup();
		const childDocs = bindChildDocs({ tables, workspace, connection });
		const a = childDocs.entries.content.open('row-1');
		const b = childDocs.entries.content.open('row-1');
		const other = childDocs.entries.content.open('row-2');
		try {
			a.write('shared');
			expect(b.read()).toBe('shared');
			expect(other.read()).toBe('');
		} finally {
			a[Symbol.dispose]();
			b[Symbol.dispose]();
			other[Symbol.dispose]();
			childDocs[Symbol.dispose]();
		}
	});

	test('applies the declared layout surface to the opened body', async () => {
		const { tables, workspace } = setup();
		const childDocs = bindChildDocs({ tables, workspace, connection });
		const handle = childDocs.entries.content.open('row-1');
		try {
			handle.write('hello');
			expect(handle.read()).toBe('hello');
			await handle.whenLoaded;
		} finally {
			handle[Symbol.dispose]();
			childDocs[Symbol.dispose]();
		}
	});

	test('a table with no declared bodies yields an empty accessor set', () => {
		const tables = {
			plain: defineTable({ id: field.string(), title: field.string() }),
		};
		const ydoc = new Y.Doc({ guid: WORKSPACE_ID, gc: true });
		const childDocs = bindChildDocs({
			tables,
			workspace: { ydoc },
			connection,
		});
		try {
			expect(Object.keys(childDocs.plain)).toEqual([]);
		} finally {
			childDocs[Symbol.dispose]();
		}
	});
});
