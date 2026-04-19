import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { defineDocument, openDocument } from './define-document.js';

/**
 * Fake attachment that mirrors the `{ disposed }` contract of real helpers,
 * without touching IndexedDB/WebSocket (unavailable in bun test env).
 */
function attachFake(ydoc: Y.Doc, opts: { cleanupMs?: number } = {}) {
	const { promise: disposed, resolve } = Promise.withResolvers<void>();
	ydoc.once('destroy', async () => {
		if (opts.cleanupMs) await new Promise((r) => setTimeout(r, opts.cleanupMs));
		resolve();
	});
	return { disposed };
}

describe('defineDocument', () => {
	test('is inert — no Y.Doc allocated', () => {
		const def = defineDocument('test.inert', () => ({ hello: 'world' }));
		expect(def.id).toBe('test.inert');
		expect(typeof def.bootstrap).toBe('function');
	});

	test('opens synchronously, returns api + ydoc + dispose', () => {
		const def = defineDocument('test.open', (ydoc) => {
			const map = ydoc.getMap<number>('state');
			return {
				get: () => map.get('n') ?? 0,
				inc: () => map.set('n', (map.get('n') ?? 0) + 1),
			};
		});

		const handle = openDocument(def);
		expect(handle.ydoc).toBeInstanceOf(Y.Doc);
		expect(handle.ydoc.guid).toBe('test.open');
		expect(handle.get()).toBe(0);
		handle.inc();
		expect(handle.get()).toBe(1);
		handle.dispose();
	});

	test('dispose triggers ydoc destroy event for attach helpers', () => {
		let cleanupRan = false;
		const def = defineDocument('test.cleanup', (ydoc) => {
			ydoc.once('destroy', () => {
				cleanupRan = true;
			});
			return {};
		});

		const handle = openDocument(def);
		expect(cleanupRan).toBe(false);
		handle.dispose();
		expect(cleanupRan).toBe(true);
	});

	test('bootstrap error destroys the ydoc and runs partial cleanup', () => {
		let cleanupRan = false;
		const def = defineDocument('test.error', (ydoc) => {
			ydoc.once('destroy', () => {
				cleanupRan = true;
			});
			throw new Error('boom');
		});

		expect(() => openDocument(def)).toThrow('boom');
		expect(cleanupRan).toBe(true);
	});
});

describe('attach helpers expose opt-in `disposed` promises', () => {
	test('composed whenDisposed resolves after all helpers tear down', async () => {
		const def = defineDocument('test.composed-dispose', (ydoc) => {
			const a = attachFake(ydoc, { cleanupMs: 10 });
			const b = attachFake(ydoc, { cleanupMs: 20 });
			return {
				whenDisposed: Promise.all([a.disposed, b.disposed]).then(() => {}),
			};
		});

		const handle = openDocument(def);
		let resolved = false;
		handle.whenDisposed.then(() => {
			resolved = true;
		});

		handle.dispose();
		expect(resolved).toBe(false); // sync — async cleanup still pending

		await handle.whenDisposed;
		expect(resolved).toBe(true);
	});
});
