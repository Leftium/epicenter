/**
 * Workspace construction tests: low-level root docs via `createWorkspace`, and
 * app-facing definitions via `defineWorkspace(...).open(...)`.
 */

import { describe, expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { asOwnerId } from '@epicenter/identity';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import { Type } from 'typebox';
import { defineActions, defineQuery } from '../shared/actions.js';
import { attachPlainText } from './attach-plain-text.js';
import type { ConnectionConfig } from './connect-doc.js';
import { defineKv } from './define-kv.js';
import { defineTable } from './define-table.js';
import { asDeviceId } from './device-id.js';
import { createWorkspace, defineWorkspace } from './workspace.js';

Object.assign(globalThis, { indexedDB, IDBKeyRange });

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

const connection: ConnectionConfig = {
	server: 'api.test.invalid',
	baseURL: 'https://api.test.invalid',
	ownerId: asOwnerId('owner-1'),
	openWebSocket: fakeWebSocket,
	onReconnectSignal: () => () => {},
	deviceId: asDeviceId('device-1'),
};

const notesDefinition = defineTable({
	id: field.string(),
	title: field.string(),
});

const sortOrderDefinition = defineKv(
	Type.Enum(['asc', 'desc']),
	() => 'asc' as const,
);

describe('createWorkspace', () => {
	test('plaintext construction reads and writes', () => {
		const workspace = createWorkspace({
			id: 'ws-plain',
			tables: { notes: notesDefinition },
			kv: { sortOrder: sortOrderDefinition },
		});

		workspace.tables.notes.set({ id: '1', title: 'hello' });
		expect(workspace.tables.notes.get('1').data).toEqual({
			id: '1',
			title: 'hello',
		});

		expect(workspace.kv.get('sortOrder')).toBe('asc');
		workspace.kv.set('sortOrder', 'desc');
		expect(workspace.kv.get('sortOrder')).toBe('desc');

		workspace[Symbol.dispose]();
	});

	test('workspace.ydoc.guid equals options.id', () => {
		const workspace = createWorkspace({
			id: 'ws-identity',
			tables: {},
			kv: {},
		});
		expect(workspace.ydoc.guid).toBe('ws-identity');
		workspace[Symbol.dispose]();
	});

	test('using-disposal destroys the underlying ydoc', () => {
		let destroyed = false;
		{
			using workspace = createWorkspace({
				id: 'ws-using',
				tables: { notes: notesDefinition },
				kv: {},
			});
			workspace.ydoc.once('destroy', () => {
				destroyed = true;
			});
		}
		expect(destroyed).toBe(true);
	});

	test('empty tables and empty kv are coherent', () => {
		const workspace = createWorkspace({
			id: 'ws-empty',
			tables: {},
			kv: {},
		});
		expect(workspace.ydoc.guid).toBe('ws-empty');
		expect(Object.keys(workspace.tables)).toEqual([]);
		workspace[Symbol.dispose]();
	});
});

describe('defineWorkspace', () => {
	test('open() builds an unconnected root workspace', () => {
		using workspace = defineWorkspace({
			id: 'ws-definition-local',
			tables: { notes: notesDefinition },
			kv: { sortOrder: sortOrderDefinition },
		}).open();

		workspace.tables.notes.set({ id: '1', title: 'hello' });
		expect(workspace.tables.notes.get('1').data?.title).toBe('hello');
		expect(workspace.kv.get('sortOrder')).toBe('asc');
	});

	test('open(connection) wires root sync and row child-doc handles', async () => {
		const workspaceDefinition = defineWorkspace({
			id: 'ws-definition-connected',
			tables: {
				notes: notesDefinition.childDocs({ body: attachPlainText }),
			},
			kv: {},
		});

		const workspace = workspaceDefinition.open(connection);
		const body = workspace.tables.notes.body.open('note-1');
		try {
			body.write('body text');
			expect(body.read()).toBe('body text');
			expect(String(body.guid)).toBe(
				'ws-definition-connected.notes.note-1.body',
			);
			await Promise.all([workspace.idb.whenLoaded, body.whenLoaded]);
		} finally {
			body[Symbol.dispose]();
			workspace[Symbol.dispose]();
		}
	});

	test('open(connection) rejects child docs that would overwrite table methods', () => {
		const unsafeNotesDefinition = notesDefinition.childDocs({
			set: attachPlainText,
		} as never);
		const workspaceDefinition = defineWorkspace({
			id: 'ws-definition-reserved-child-doc',
			tables: {
				notes: unsafeNotesDefinition,
			},
			kv: {},
		});

		expect(() => workspaceDefinition.open(connection)).toThrow(
			'Child doc field "set" on table "notes" conflicts with the table API.',
		);
	});

	test('open(connection, compose) publishes runtime actions and disposes runtime extras', () => {
		let runtimeDisposed = false;
		const workspace = defineWorkspace({
			id: 'ws-definition-runtime',
			tables: { notes: notesDefinition },
			kv: {},
		}).open(connection, ({ tables, actions }) => ({
			runtimeLabel: 'browser-only',
			actions: defineActions({
				...actions,
				notes_count: defineQuery({
					description: 'Count notes.',
					handler: () => tables.notes.storedCount(),
				}),
			}),
			[Symbol.dispose]() {
				runtimeDisposed = true;
			},
		}));

		workspace.tables.notes.set({ id: '1', title: 'hello' });
		expect(workspace.runtimeLabel).toBe('browser-only');
		expect(workspace.collaboration.actions.notes_count()).toBe(1);
		workspace[Symbol.dispose]();
		expect(runtimeDisposed).toBe(true);
	});
});
