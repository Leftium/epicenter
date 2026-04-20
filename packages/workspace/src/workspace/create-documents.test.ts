/**
 * createDocuments Tests
 *
 * Validates documents lifecycle, content read/write behavior, and integration with table row metadata.
 * The suite protects contracts around open/close idempotency, direct content access, cleanup semantics, and hook orchestration.
 *
 * Key behaviors:
 * - Document operations keep row metadata in sync and honor documents origins.
 * - Lifecycle methods (`close`, `closeAll`) safely clean up open documents.
 */

import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import * as Y from 'yjs';
import {
	type CreateDocumentsConfig,
	createDocuments,
	DOCUMENTS_ORIGIN,
} from './create-documents.js';
import { createTables } from '../__tests__/create-tables.js';
import { defineTable } from './define-table.js';
import { timeline } from './strategies.js';

const fileSchema = type({
	id: 'string',
	name: 'string',
	updatedAt: 'number',
	_v: '1',
});

function setupTables() {
	const ydoc = new Y.Doc({ guid: 'test-workspace' });
	const tables = createTables(ydoc, { files: defineTable(fileSchema) });
	return { ydoc, tables };
}

function setup(
	overrides?: Pick<
		CreateDocumentsConfig<typeof fileSchema.infer>,
		'documentExtensions' | 'graceMs'
	>,
) {
	const { ydoc, tables } = setupTables();
	const documents = createDocuments({
		id: 'test-workspace',
		tableName: 'files',
		documentName: 'content',
		guidKey: 'id',
		content: timeline,
		onUpdate: () => ({ updatedAt: Date.now() }),
		tableHelper: tables.files,
		ydoc,
		...overrides,
	});
	return { ydoc, tables, documents };
}

describe('createDocuments', () => {
	describe('open', () => {
		test('document extension factory receives tableName and documentName in context', async () => {
			let receivedTableName: string | undefined;
			let receivedDocumentName: string | undefined;
			const { documents } = setup({
				documentExtensions: [
					{
						key: 'test',
						factory: (ctx) => {
							receivedTableName = ctx.tableName;
							receivedDocumentName = ctx.documentName;
						},
					},
				],
			});
			await documents.open('f1');
			expect(receivedTableName).toBe('files');
			expect(receivedDocumentName).toBe('content');
		});

		test('is idempotent — same GUID returns the same content instance', async () => {
			const { documents } = setup();

			const content1 = await documents.open('f1');
			const content2 = await documents.open('f1');
			expect(content1).toBe(content2);
		});

		test('open accepts a row object and returns content', async () => {
			const { tables, documents } = setup();
			const row = {
				id: 'f1',
				name: 'test.txt',
				updatedAt: 0,
				_v: 1,
			} as const;
			tables.files.set(row);

			const content = await documents.open(row);
			content.write('hello from row');
			expect(content.read()).toBe('hello from row');
		});

		test('open accepts a string guid directly and returns content', async () => {
			const { documents } = setup();

			const content = await documents.open('f1');
			content.write('hello from guid');
			expect(content.read()).toBe('hello from guid');
		});
	});

	describe('document content read and write', () => {
		test('read returns empty string for new doc', async () => {
			const { documents } = setup();

			const content = await documents.open('f1');
			const text = content.read();
			expect(text).toBe('');
		});

		test('write replaces text content, then read returns it', async () => {
			const { documents } = setup();

			const content = await documents.open('f1');
			content.write('hello world');
			const text = content.read();
			expect(text).toBe('hello world');
		});

		test('write replaces existing content', async () => {
			const { documents } = setup();

			const content = await documents.open('f1');
			content.write('first');
			content.write('second');
			const text = content.read();
			expect(text).toBe('second');
		});
	});

	describe('onUpdate callback', () => {
		test('content doc change invokes onUpdate and writes returned fields', async () => {
			const { tables, documents } = setup();
			tables.files.set({
				id: 'f1',
				name: 'test.txt',
				updatedAt: 0,
				_v: 1,
			});

			const content = await documents.open('f1');
			content.write('hello');

			// Give the update observer a tick
			const result = tables.files.get('f1');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.row.updatedAt).toBeGreaterThan(0);
			}
		});

		test('onUpdate callback return values are written to the row', async () => {
			const customSchema = type({
				id: 'string',
				name: 'string',
				updatedAt: 'number',
				lastEditedBy: 'string',
				_v: '1',
			});
			const ydoc = new Y.Doc({ guid: 'test-custom-onUpdate' });
			const tables = createTables(ydoc, {
				files: defineTable(customSchema),
			});

			const documents = createDocuments({
				id: 'test-custom-onUpdate',
				tableName: 'files',
				documentName: 'content',
				guidKey: 'id',
				content: timeline,
				onUpdate: () => ({
					updatedAt: 999,
					lastEditedBy: 'test-user',
				}),
				tableHelper: tables.files,
				ydoc,
			});

			tables.files.set({
				id: 'f1',
				name: 'test.txt',
				updatedAt: 0,
				lastEditedBy: '',
				_v: 1,
			});

			const content = await documents.open('f1');
			content.write('hello');

			const result = tables.files.get('f1');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.row.updatedAt).toBe(999);
				expect(result.row.lastEditedBy).toBe('test-user');
			}
		});

		test('onUpdate returning empty object is a no-op', async () => {
			const ydoc = new Y.Doc({ guid: 'test-noop-onUpdate' });
			const tables = createTables(ydoc, {
				files: defineTable(fileSchema),
			});

			const documents = createDocuments({
				id: 'test-noop-onUpdate',
				tableName: 'files',
				documentName: 'content',
				guidKey: 'id',
				content: timeline,
				onUpdate: () => ({}),
				tableHelper: tables.files,
				ydoc,
			});

			tables.files.set({
				id: 'f1',
				name: 'test.txt',
				updatedAt: 0,
				_v: 1,
			});

			const content = await documents.open('f1');
			content.write('hello');

			const result = tables.files.get('f1');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.row.updatedAt).toBe(0); // unchanged
			}
		});

		test('onUpdate bump uses DOCUMENTS_ORIGIN', async () => {
			const { tables, documents } = setup();
			tables.files.set({
				id: 'f1',
				name: 'test.txt',
				updatedAt: 0,
				_v: 1,
			});

			let capturedOrigin: unknown = null;
			tables.files.observe((_changedIds, origin) => {
				capturedOrigin = origin;
			});

			const content = await documents.open('f1');
			content.write('hello');

			expect(capturedOrigin).toBe(DOCUMENTS_ORIGIN);
		});

		test('non-transport remote update invokes onUpdate', async () => {
			const { tables, documents } = setup();
			tables.files.set({
				id: 'f1',
				name: 'test.txt',
				updatedAt: 0,
				_v: 1,
			});

			const content = await documents.open('f1');
			// Get the underlying Y.Doc via a shared type — Timeline no longer exposes ydoc directly.
			// asText() creates a timeline entry which triggers onUpdate, so reset updatedAt after.
			const contentYdoc = content.asText().doc!;
			tables.files.update('f1', { updatedAt: 0 });

			// Apply a remote update with no origin (e.g., IndexedDB load)
			const remoteDoc = new Y.Doc({ guid: 'f1', gc: false });
			remoteDoc.getText('content').insert(0, 'remote edit');
			const remoteUpdate = Y.encodeStateAsUpdate(remoteDoc);

			Y.applyUpdate(contentYdoc, remoteUpdate);

			const result = tables.files.get('f1');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.row.updatedAt).not.toBe(0);
			}

			remoteDoc.destroy();
		});

		test('transport-originated update does NOT invoke onUpdate', async () => {
			const { tables, documents } = setup();
			tables.files.set({
				id: 'f1',
				name: 'test.txt',
				updatedAt: 0,
				_v: 1,
			});

			const content = await documents.open('f1');
			// Get the underlying Y.Doc via a shared type — Timeline no longer exposes ydoc directly.
			// asText() creates a timeline entry which triggers onUpdate, so reset updatedAt after.
			const contentYdoc = content.asText().doc!;
			tables.files.update('f1', { updatedAt: 0 });

			// Apply a remote update with a Symbol origin (simulating sync/broadcast)
			const FAKE_TRANSPORT = Symbol('fake-transport');
			const remoteDoc = new Y.Doc({ guid: 'f1', gc: false });
			remoteDoc.getText('content').insert(0, 'synced edit');
			const remoteUpdate = Y.encodeStateAsUpdate(remoteDoc);

			Y.applyUpdate(contentYdoc, remoteUpdate, FAKE_TRANSPORT);

			const result = tables.files.get('f1');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				// Transport-originated updates skip onUpdate — the originating
				// tab already bumped metadata via workspace sync.
				expect(result.row.updatedAt).toBe(0);
			}

			remoteDoc.destroy();
		});
	});
	describe('close', () => {
		test('frees memory — doc can be re-opened as new instance', async () => {
			const { documents } = setup();

			const content1 = await documents.open('f1');
			await documents.close('f1');

			const content2 = await documents.open('f1');
			expect(content2).not.toBe(content1);
		});

		test('close on non-existent guid is a no-op', async () => {
			const { documents } = setup();

			// Should not throw
			await documents.close('nonexistent');
		});
	});

	describe('closeAll', () => {
		test('closes all open documents', async () => {
			const { documents } = setup();

			const content1 = await documents.open('f1');
			const content2 = await documents.open('f2');

			await documents.closeAll();

			// Re-opening should create new content instances
			const content1b = await documents.open('f1');
			const content2b = await documents.open('f2');
			expect(content1b).not.toBe(content1);
			expect(content2b).not.toBe(content2);
		});
	});

	describe('document extension hooks', () => {
		test('hooks are called in order', async () => {
			const order: number[] = [];

			const { documents } = setup({
				documentExtensions: [
					{
						key: 'first',
						factory: () => {
							order.push(1);
							return { exports: {}, dispose: () => {} };
						},
					},
					{
						key: 'second',
						factory: () => {
							order.push(2);
							return { exports: {}, dispose: () => {} };
						},
					},
					{
						key: 'third',
						factory: () => {
							order.push(3);
							return { exports: {}, dispose: () => {} };
						},
					},
				],
			});

			await documents.open('f1');
			expect(order).toEqual([1, 2, 3]);
		});

		test('second hook receives init from first', async () => {
			let secondReceivedInit = false;

			const { documents } = setup({
				documentExtensions: [
					{
						key: 'first',
						factory: () => ({
							exports: {},
							init: Promise.resolve(),
							dispose: () => {},
						}),
					},
					{
						key: 'second',
						factory: ({ init }) => {
							secondReceivedInit = init instanceof Promise;
							return { exports: {}, dispose: () => {} };
						},
					},
				],
			});

			await documents.open('f1');
			expect(secondReceivedInit).toBe(true);
		});

		test('hook returning void is skipped', async () => {
			let hooksCalled = 0;

			const { documents } = setup({
				documentExtensions: [
					{
						key: 'void-hook',
						factory: () => {
							hooksCalled++;
							return undefined; // void return
						},
					},
					{
						key: 'normal-hook',
						factory: () => {
							hooksCalled++;
							return { exports: {}, dispose: () => {} };
						},
					},
				],
			});

			await documents.open('f1');
			expect(hooksCalled).toBe(2);
		});

		test('no hooks → bare content opens with instant resolution', async () => {
			const { documents } = setup({ documentExtensions: [] });

			const content = await documents.open('f1');
			expect(content.read()).toBe('');
		});
	});

	describe('document extension whenReady and typed extensions', () => {
		test('document extension receives extensions map with flat exports', async () => {
			let capturedFirstExtension: unknown;

			const { documents } = setup({
				documentExtensions: [
					{
						key: 'first',
						factory: () => ({
							exports: { someValue: 42 },
							dispose: () => {},
						}),
					},
					{
						key: 'second',
						factory: (context) => {
							capturedFirstExtension = context.extensions.first;
							return { exports: {}, dispose: () => {} };
						},
					},
				],
			});

			await documents.open('f1');
			expect(capturedFirstExtension).toBeDefined();
			expect(
				(capturedFirstExtension as Record<string, unknown>).someValue,
			).toBe(42);
		});

		test('document extension with no exports is still accessible', async () => {
			let firstExtensionSeen = false;

			const { documents } = setup({
				documentExtensions: [
					{
						key: 'first',
						factory: () => ({
							exports: {},
							dispose: () => {},
						}),
					},
					{
						key: 'second',
						factory: (context) => {
							firstExtensionSeen = context.extensions.first !== undefined;
							return { exports: {}, dispose: () => {} };
						},
					},
				],
			});

			await documents.open('f1');
			expect(firstExtensionSeen).toBe(true);
		});
	});
});

// ════════════════════════════════════════════════════════════════════════════
// bind() / release — idle-able extension lifecycle
// ════════════════════════════════════════════════════════════════════════════

describe('handle.bind() / release lifecycle', () => {
	/**
	 * Build a counting idle-able extension that records every onActive /
	 * onIdle call. Also exposes its init promise so we can await it from the
	 * outside.
	 */
	function countingIdleExtension() {
		let active = 0;
		let idle = 0;
		return {
			counts: () => ({ active, idle }),
			registration: {
				key: 'counter',
				factory: () => ({
					exports: {},
					onActive: () => {
						active++;
					},
					onIdle: () => {
						idle++;
					},
				}),
			},
		};
	}

	test('construct alone does not activate (refcount 0)', async () => {
		const ext = countingIdleExtension();
		const { documents } = setup({
			documentExtensions: [ext.registration],
		});
		documents.get('f1');
		// No bind → onActive must not have fired.
		expect(ext.counts()).toEqual({ active: 0, idle: 0 });
	});

	test('first bind activates; last release + grace idles', async () => {
		const ext = countingIdleExtension();
		const { documents } = setup({
			documentExtensions: [ext.registration],
			graceMs: 10,
		});
		const handle = documents.get('f1');

		const release = handle.bind();
		expect(ext.counts()).toEqual({ active: 1, idle: 0 });

		release();
		// Still in grace period; onIdle has not fired yet.
		expect(ext.counts().idle).toBe(0);

		await new Promise((r) => setTimeout(r, 20));
		expect(ext.counts()).toEqual({ active: 1, idle: 1 });
	});

	test('multiple binds refcount; last release schedules idle', async () => {
		const ext = countingIdleExtension();
		const { documents } = setup({
			documentExtensions: [ext.registration],
			graceMs: 10,
		});
		const handle = documents.get('f1');

		const r1 = handle.bind();
		const r2 = handle.bind();
		expect(ext.counts()).toEqual({ active: 1, idle: 0 }); // only 0→1 activates

		r1();
		// refcount 1 > 0 → no idle scheduled
		await new Promise((r) => setTimeout(r, 20));
		expect(ext.counts().idle).toBe(0);

		r2();
		await new Promise((r) => setTimeout(r, 20));
		expect(ext.counts()).toEqual({ active: 1, idle: 1 });
	});

	test('re-bind during grace cancels the pending idle', async () => {
		const ext = countingIdleExtension();
		const { documents } = setup({
			documentExtensions: [ext.registration],
			graceMs: 20,
		});
		const handle = documents.get('f1');

		const r1 = handle.bind();
		r1();
		// Grace started. Bind again before it fires.
		await new Promise((r) => setTimeout(r, 5));
		const r2 = handle.bind();

		await new Promise((r) => setTimeout(r, 30));
		// Still bound — no idle fired.
		expect(ext.counts().idle).toBe(0);

		r2();
		await new Promise((r) => setTimeout(r, 30));
		expect(ext.counts()).toEqual({ active: 1, idle: 1 });
	});

	test('release() is idempotent (double-release does not double-decrement)', async () => {
		const ext = countingIdleExtension();
		const { documents } = setup({
			documentExtensions: [ext.registration],
			graceMs: 10,
		});
		const handle = documents.get('f1');

		const r1 = handle.bind();
		const r2 = handle.bind();

		r1();
		r1(); // double-release
		// refcount should still be 1 — r2 still holds.
		await new Promise((r) => setTimeout(r, 20));
		expect(ext.counts().idle).toBe(0);

		r2();
		await new Promise((r) => setTimeout(r, 20));
		expect(ext.counts()).toEqual({ active: 1, idle: 1 });
	});

	test('0 → 1 → 0 → 1 cycles onActive again', async () => {
		const ext = countingIdleExtension();
		const { documents } = setup({
			documentExtensions: [ext.registration],
			graceMs: 5,
		});
		const handle = documents.get('f1');

		handle.bind()();
		await new Promise((r) => setTimeout(r, 15));
		expect(ext.counts()).toEqual({ active: 1, idle: 1 });

		handle.bind();
		expect(ext.counts().active).toBe(2);
	});

	test('close cancels pending idle timer', async () => {
		const ext = countingIdleExtension();
		const { documents } = setup({
			documentExtensions: [ext.registration],
			graceMs: 50,
		});
		const handle = documents.get('f1');
		const release = handle.bind();
		release();
		// Grace pending. Close before it fires.
		await documents.close('f1');
		await new Promise((r) => setTimeout(r, 80));
		// onIdle must NOT have fired — dispose ran instead.
		expect(ext.counts().idle).toBe(0);
	});

	test('release captured before close is safe to call after close', async () => {
		// If a consumer holds a release function, then close() happens, then
		// they call release — we must not schedule an idle timer against the
		// disposed entry (extensions have already been torn down).
		const ext = countingIdleExtension();
		const { documents } = setup({
			documentExtensions: [ext.registration],
			graceMs: 50,
		});
		const handle = documents.get('f1');
		const release = handle.bind();
		expect(ext.counts().active).toBe(1);

		await documents.close('f1');
		// Now the consumer finally releases the stale handle.
		release();

		// Wait longer than graceMs — no idle callback should fire because
		// the entry was disposed before release ran.
		await new Promise((r) => setTimeout(r, 80));
		expect(ext.counts().idle).toBe(0);
	});

	test('bind on a stale handle after close is a safe no-op', async () => {
		// Same guard from the opposite direction: stale bind() on a disposed
		// entry shouldn't re-fire onActive or leak resources. (In practice,
		// callers should re-.get() to get a fresh entry — this just keeps the
		// framework defensive against misuse.)
		const ext = countingIdleExtension();
		const { documents } = setup({
			documentExtensions: [ext.registration],
			graceMs: 50,
		});
		const handle = documents.get('f1');
		await documents.close('f1');

		const staleRelease = handle.bind();
		expect(ext.counts().active).toBe(0); // onActive must not fire
		staleRelease(); // must not throw or mutate anything
	});

	test('close during an active bind runs dispose but does not fire onIdle', async () => {
		// Design decision locked in: dispose supersedes onIdle. If the caller
		// closes a doc while it's bound, extensions see dispose() (permanent
		// teardown) rather than onIdle (transient). The release function held
		// by the original binder is still safe to call later (covered by the
		// "release captured before close" test).
		const ext = countingIdleExtension();
		let disposeCount = 0;
		const { documents } = setup({
			documentExtensions: [
				ext.registration,
				{
					key: 'counter-dispose',
					factory: () => ({
						exports: {},
						dispose: () => {
							disposeCount++;
						},
					}),
				},
			],
			graceMs: 50,
		});
		const handle = documents.get('f1');
		handle.bind();
		expect(ext.counts().active).toBe(1);

		await documents.close('f1');

		expect(disposeCount).toBe(1);
		expect(ext.counts().idle).toBe(0);
	});

	test('bind on one doc does not fire hooks for another doc', async () => {
		// Multi-doc independence — refcount is per-guid, not global.
		const extA = countingIdleExtension();
		const extB = countingIdleExtension();
		const { documents } = setup({
			documentExtensions: [extA.registration, extB.registration],
			graceMs: 10,
		});

		const a = documents.get('f1');
		const b = documents.get('f2');

		const release = a.bind();
		// Both A and B's extensions get invoked for f1's construction, but
		// only because BOTH registrations apply to EVERY constructed doc.
		// After `a.bind()`, both extensions are activated ONCE for f1 only.
		expect(extA.counts().active).toBe(1);
		expect(extB.counts().active).toBe(1);

		// Now confirm binding `a` hasn't affected f2's entry.
		b.bind()(); // bind + release on f2
		// f2 had its own construction; activators fired for it too now. The
		// counters are shared across entries because the same factory closure
		// increments them. What we really want to assert: f1's grace timer is
		// independent of f2's.
		await new Promise((r) => setTimeout(r, 5));
		// f2's release should start its grace; f1 should still be active.
		expect(extA.counts().idle).toBe(0);

		release(); // release f1
		await new Promise((r) => setTimeout(r, 20));
		expect(extA.counts().idle).toBe(2); // both f1 and f2 eventually idle
	});

	test('onActive hooks fire in extension registration order', async () => {
		const order: string[] = [];
		const { documents } = setup({
			documentExtensions: [
				{
					key: 'first',
					factory: () => ({
						exports: {},
						onActive: () => order.push('first'),
					}),
				},
				{
					key: 'second',
					factory: () => ({
						exports: {},
						onActive: () => order.push('second'),
					}),
				},
			],
		});
		documents.get('f1').bind();
		expect(order).toEqual(['first', 'second']);
	});

	test('a throwing onActive does not prevent subsequent extensions from activating', async () => {
		const order: string[] = [];
		const { documents } = setup({
			documentExtensions: [
				{
					key: 'throws',
					factory: () => ({
						exports: {},
						onActive: () => {
							order.push('throws');
							throw new Error('simulated');
						},
					}),
				},
				{
					key: 'runs',
					factory: () => ({
						exports: {},
						onActive: () => order.push('runs'),
					}),
				},
			],
		});
		const handle = documents.get('f1');
		// Should not throw out to the caller.
		handle.bind();
		expect(order).toEqual(['throws', 'runs']);
	});

	test('a throwing onActive still increments refcount so release works', async () => {
		// Critical invariant: if activation fails for some extensions, the
		// refcount must still reflect the bind. Otherwise release() would
		// decrement to -1, and subsequent binds would double-fire.
		const goodExt = countingIdleExtension();
		const { documents } = setup({
			documentExtensions: [
				{
					key: 'bad',
					factory: () => ({
						exports: {},
						onActive: () => {
							throw new Error('simulated');
						},
					}),
				},
				goodExt.registration,
			],
			graceMs: 5,
		});
		const handle = documents.get('f1');
		const release = handle.bind();
		expect(goodExt.counts().active).toBe(1);
		release();
		await new Promise((r) => setTimeout(r, 15));
		expect(goodExt.counts().idle).toBe(1);
	});

	test('rapid 0→1→0→1 within same tick keeps sync active through the dance', async () => {
		// With graceMs=0 the timer is still scheduled in the next task — so a
		// synchronous re-bind still cancels it. This guards the classic bug:
		// "release triggers idle immediately, then bind fires a second activate."
		const ext = countingIdleExtension();
		const { documents } = setup({
			documentExtensions: [ext.registration],
			graceMs: 0,
		});
		const handle = documents.get('f1');
		const r1 = handle.bind();
		r1();
		const r2 = handle.bind();
		// No microtask yield — timer hasn't had a chance to fire. The fresh
		// bind cancelled it.
		expect(ext.counts()).toEqual({ active: 1, idle: 0 });
		r2();
		await new Promise((r) => setTimeout(r, 10));
		expect(ext.counts()).toEqual({ active: 1, idle: 1 });
	});

	test('closeAll cancels all pending grace timers', async () => {
		// Mass teardown scenario: multiple docs in grace, workspace disposes.
		// None of their onIdle hooks should fire after closeAll resolves.
		const ext = countingIdleExtension();
		const { documents } = setup({
			documentExtensions: [ext.registration],
			graceMs: 50,
		});

		for (const id of ['f1', 'f2', 'f3']) {
			const release = documents.get(id).bind();
			release();
		}
		// Three grace timers pending.
		await documents.closeAll();

		await new Promise((r) => setTimeout(r, 80));
		// None of the three fired onIdle — dispose ran instead.
		expect(ext.counts().idle).toBe(0);
	});

	test('extension without onActive/onIdle is unaffected', async () => {
		// A plain extension with no hooks should be invisible to bind/release.
		let initCount = 0;
		let disposeCount = 0;
		const { documents } = setup({
			documentExtensions: [
				{
					key: 'plain',
					factory: () => ({
						exports: {},
						init: (async () => {
							initCount++;
						})(),
						dispose: () => {
							disposeCount++;
						},
					}),
				},
			],
			graceMs: 5,
		});
		const handle = documents.get('f1');
		await handle.whenLoaded;
		expect(initCount).toBe(1);

		handle.bind()();
		await new Promise((r) => setTimeout(r, 15));
		// Idle fired, but plain extension has no onIdle so nothing happens.
		expect(disposeCount).toBe(0);

		await documents.close('f1');
		expect(disposeCount).toBe(1);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// as*() conversion methods
// ════════════════════════════════════════════════════════════════════════════

describe('content.asText / asRichText / asSheet', () => {
	function setupSimple() {
		const ydoc = new Y.Doc({ guid: 'workspace' });
		const tableDef = defineTable(
			type({ id: 'string', name: 'string', updatedAt: 'number', _v: '1' }),
		);
		const tables = createTables(ydoc, { files: tableDef });
		const documents = createDocuments({
			id: 'test-timeline',
			tableName: 'files',
			documentName: 'content',
			guidKey: 'id',
			content: timeline,
			onUpdate: () => ({ updatedAt: Date.now() }),
			tableHelper: tables.files,
			ydoc,
		});
		tables.files.set({ id: 'f1', name: 'test', updatedAt: 0, _v: 1 });
		return { documents, tables };
	}

	// ─── asText ────────────────────────────────────────────────────────

	test('asText on empty timeline auto-creates text entry', async () => {
		const { documents } = setupSimple();
		const content = await documents.open('f1');

		const text = content.asText();
		expect(text).toBeInstanceOf(Y.Text);
		expect(content.currentType).toBe('text');
	});

	test('asText on text entry returns existing Y.Text', async () => {
		const { documents } = setupSimple();
		const content = await documents.open('f1');
		content.write('hello');

		const text = content.asText();
		expect(text.toString()).toBe('hello');
		expect(content.length).toBe(1);
	});

	test('asText on richtext entry converts (lossy)', async () => {
		const { documents } = setupSimple();
		const content = await documents.open('f1');

		const fragment = content.asRichText();
		const p = new Y.XmlElement('paragraph');
		const t = new Y.XmlText();
		t.insert(0, 'Rich content');
		p.insert(0, [t]);
		fragment.insert(0, [p]);

		expect(content.currentType).toBe('richtext');

		const text = content.asText();
		expect(text.toString()).toBe('Rich content');
		expect(content.currentType).toBe('text');
		expect(content.length).toBe(2);
	});

	test('asText on sheet entry converts to CSV', async () => {
		const { documents } = setupSimple();
		const content = await documents.open('f1');

		content.write('Name,Age\nAlice,30\n');
		content.asSheet();
		expect(content.currentType).toBe('sheet');

		const text = content.asText();
		expect(text.toString()).toBe('Name,Age\nAlice,30\n');
		expect(content.currentType).toBe('text');
		expect(content.length).toBe(3);
	});

	// ─── asRichText ────────────────────────────────────────────────────

	test('asRichText on empty timeline auto-creates richtext entry', async () => {
		const { documents } = setupSimple();
		const content = await documents.open('f1');

		const fragment = content.asRichText();
		expect(fragment).toBeInstanceOf(Y.XmlFragment);
		expect(content.currentType).toBe('richtext');
	});

	test('asRichText on richtext entry returns existing fragment', async () => {
		const { documents } = setupSimple();
		const content = await documents.open('f1');
		content.asRichText();

		const fragment = content.asRichText();
		expect(fragment).toBeInstanceOf(Y.XmlFragment);
		expect(content.length).toBe(1);
	});

	test('asRichText on text entry converts to paragraphs', async () => {
		const { documents } = setupSimple();
		const content = await documents.open('f1');
		content.write('Line 1\nLine 2');

		const fragment = content.asRichText();
		expect(fragment).toBeInstanceOf(Y.XmlFragment);
		expect(content.currentType).toBe('richtext');
		expect(content.length).toBe(2);
		expect(content.read()).toBe('Line 1\nLine 2');
	});

	test('asRichText on sheet entry converts CSV to paragraphs', async () => {
		const { documents } = setupSimple();
		const content = await documents.open('f1');
		content.write('A,B\n1,2\n');
		content.asSheet();

		const fragment = content.asRichText();
		expect(fragment).toBeInstanceOf(Y.XmlFragment);
		expect(content.currentType).toBe('richtext');
		expect(content.length).toBe(3);
	});

	// ─── asSheet ──────────────────────────────────────────────────────

	test('asSheet on empty timeline auto-creates sheet entry', async () => {
		const { documents } = setupSimple();
		const content = await documents.open('f1');

		const sheet = content.asSheet();
		expect(sheet.columns).toBeInstanceOf(Y.Map);
		expect(sheet.rows).toBeInstanceOf(Y.Map);
		expect(content.currentType).toBe('sheet');
	});

	test('asSheet on sheet entry returns existing binding', async () => {
		const { documents } = setupSimple();
		const content = await documents.open('f1');
		content.write('X,Y\n1,2\n');
		content.asSheet();

		const sheet = content.asSheet();
		expect(sheet.columns.size).toBe(2);
		expect(sheet.rows.size).toBe(1);
		expect(content.length).toBe(2);
	});

	test('asSheet on text entry parses as CSV', async () => {
		const { documents } = setupSimple();
		const content = await documents.open('f1');
		content.write('Col1,Col2\nA,B\n');

		const sheet = content.asSheet();
		expect(sheet.columns.size).toBe(2);
		expect(sheet.rows.size).toBe(1);
		expect(content.currentType).toBe('sheet');
		expect(content.length).toBe(2);
	});

	test('asSheet on richtext entry extracts text then parses CSV', async () => {
		const { documents } = setupSimple();
		const content = await documents.open('f1');

		const fragment = content.asRichText();
		const p1 = new Y.XmlElement('paragraph');
		const t1 = new Y.XmlText();
		t1.insert(0, 'Name,Age');
		p1.insert(0, [t1]);
		const p2 = new Y.XmlElement('paragraph');
		const t2 = new Y.XmlText();
		t2.insert(0, 'Alice,30');
		p2.insert(0, [t2]);
		fragment.insert(0, [p1, p2]);

		const sheet = content.asSheet();
		expect(sheet.columns.size).toBe(2);
		expect(content.currentType).toBe('sheet');
		expect(content.length).toBe(2);
	});

	// ─── mode getter ──────────────────────────────────────────────────

	test('mode reflects current timeline state', async () => {
		const { documents } = setupSimple();
		const content = await documents.open('f1');

		expect(content.currentType).toBeUndefined(); // empty
		content.write('text');
		expect(content.currentType).toBe('text');
	});

	// ─── consecutive conversions ──────────────────────────────────────

	test('consecutive conversions: text → richtext → sheet → text', async () => {
		const { documents } = setupSimple();
		const content = await documents.open('f1');

		content.write('hello');
		expect(content.currentType).toBe('text');
		expect(content.length).toBe(1);

		content.asRichText();
		expect(content.currentType).toBe('richtext');
		expect(content.length).toBe(2);

		content.asSheet();
		expect(content.currentType).toBe('sheet');
		expect(content.length).toBe(3);

		content.asText();
		expect(content.currentType).toBe('text');
		expect(content.length).toBe(4);
	});
});
