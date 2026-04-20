/**
 * defineDocument tests.
 *
 * Ports the load-bearing primitive-level invariants from the previous
 * `packages/workspace/src/workspace/create-documents.test.ts`, stripping out
 * the workspace-coupling tests (documentExtensions registry, table-row API,
 * strategy-specific read/write). Adds the three new invariants introduced by
 * the primitive: standalone (no parent workspace), throwing-closure doesn't
 * poison the cache, guid-stability check.
 */

import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { defineDocument } from './define-document.js';
import { DOCUMENTS_ORIGIN, onLocalUpdate } from './on-local-update.js';

/**
 * Build a factory whose closure returns `{ ydoc, whenLoaded? }`. The optional
 * `whenLoadedImpl` factory lets tests control a per-id `whenLoaded` promise
 * exposed via a fake attachment.
 */
function makeSimpleFactory(opts?: {
	graceMs?: number;
	buildExtra?: (ydoc: Y.Doc, id: string) => Record<string, unknown>;
}) {
	return defineDocument(
		(id: string) => {
			const ydoc = new Y.Doc({ guid: id });
			const extra = opts?.buildExtra?.(ydoc, id) ?? {};
			return { ydoc, ...extra };
		},
		{ graceMs: opts?.graceMs },
	);
}

// ════════════════════════════════════════════════════════════════════════════
// get / cache identity
// ════════════════════════════════════════════════════════════════════════════

describe('get', () => {
	test('returns the same handle instance for the same id', () => {
		const factory = makeSimpleFactory();
		const h1 = factory.get('a');
		const h2 = factory.get('a');
		expect(h1).toBe(h2);
	});

	test('returns independent handles for different ids', () => {
		const factory = makeSimpleFactory();
		const h1 = factory.get('a');
		const h2 = factory.get('b');
		expect(h1).not.toBe(h2);
		expect(h1.ydoc.guid).toBe('a');
		expect(h2.ydoc.guid).toBe('b');
	});

	test('concurrent .get(sameId) is race-safe (construction is synchronous)', () => {
		// No await between Map.get and Map.set — three calls in the same tick
		// must share the same handle.
		const factory = makeSimpleFactory();
		const [a, b, c] = [factory.get('x'), factory.get('x'), factory.get('x')];
		expect(a).toBe(b);
		expect(b).toBe(c);
	});

	test('build closure runs without coupling to a parent workspace', () => {
		// No workspace, no tables — just the primitive.
		const factory = defineDocument((id: string) => {
			const ydoc = new Y.Doc({ guid: id });
			return { ydoc, createdAt: Date.now() };
		});
		const handle = factory.get('solo');
		expect(handle.ydoc).toBeInstanceOf(Y.Doc);
		expect(typeof handle.createdAt).toBe('number');
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Throwing closure doesn't poison the cache
// ════════════════════════════════════════════════════════════════════════════

describe('throwing build closure', () => {
	test('error propagates and the cache does not retain the id', () => {
		let calls = 0;
		const factory = defineDocument((id: string) => {
			calls++;
			if (calls === 1) throw new Error('boom');
			const ydoc = new Y.Doc({ guid: id });
			return { ydoc };
		});

		expect(() => factory.get('foo')).toThrow('boom');
		// The second attempt must run the closure again, not hit a poisoned cache entry.
		const handle = factory.get('foo');
		expect(calls).toBe(2);
		expect(handle.ydoc.guid).toBe('foo');
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Guid stability
// ════════════════════════════════════════════════════════════════════════════

describe('guid stability', () => {
	test('throws if a second construction for the same id produces a different guid', async () => {
		let seed = 0;
		const factory = defineDocument((id: string) => {
			const ydoc = new Y.Doc({ guid: `${id}-${seed++}` });
			return { ydoc };
		});

		const h1 = factory.get('foo');
		expect(h1.ydoc.guid).toBe('foo-0');
		// Evict so the next get() reruns the closure.
		await factory.close('foo');
		expect(() => factory.get('foo')).toThrow(/guid instability/);
	});

	test('accepts stable guids across reconstructions', async () => {
		const factory = defineDocument((id: string) => {
			const ydoc = new Y.Doc({ guid: `stable-${id}` });
			return { ydoc };
		});
		const h1 = factory.get('foo');
		const guid1 = h1.ydoc.guid;
		await factory.close('foo');
		const h2 = factory.get('foo');
		expect(h2.ydoc.guid).toBe(guid1);
		expect(h2).not.toBe(h1); // fresh handle after close
	});
});

// ════════════════════════════════════════════════════════════════════════════
// whenLoaded aggregation
// ════════════════════════════════════════════════════════════════════════════

describe('whenLoaded', () => {
	test('resolves immediately when no attachment exposes whenLoaded', async () => {
		const factory = makeSimpleFactory();
		const handle = factory.get('a');
		await handle.whenLoaded; // should not hang
		expect(true).toBe(true);
	});

	test('aggregates multiple attachments exposing whenLoaded', async () => {
		let resolveA!: () => void;
		let resolveB!: () => void;
		const factory = defineDocument((id: string) => {
			const ydoc = new Y.Doc({ guid: id });
			const idbLike = {
				whenLoaded: new Promise<void>((r) => {
					resolveA = r;
				}),
			};
			const syncLike = {
				whenLoaded: new Promise<void>((r) => {
					resolveB = r;
				}),
			};
			return { ydoc, idbLike, syncLike };
		});

		const handle = factory.get('a');
		let resolved = false;
		void handle.whenLoaded.then(() => {
			resolved = true;
		});

		await new Promise((r) => setTimeout(r, 5));
		expect(resolved).toBe(false);

		resolveA();
		await new Promise((r) => setTimeout(r, 5));
		expect(resolved).toBe(false); // still waiting on B

		resolveB();
		await handle.whenLoaded;
		expect(resolved).toBe(true);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// onLocalUpdate filtering
// ════════════════════════════════════════════════════════════════════════════

describe('onLocalUpdate', () => {
	test('fires for local edits (null origin)', () => {
		const factory = makeSimpleFactory();
		const handle = factory.get('a');
		let calls = 0;
		onLocalUpdate(handle.ydoc, () => calls++);
		handle.ydoc.getText('content').insert(0, 'hi');
		expect(calls).toBe(1);
	});

	test('skips transport-origin updates (Symbol origin)', () => {
		const factory = makeSimpleFactory();
		const handle = factory.get('a');
		let calls = 0;
		onLocalUpdate(handle.ydoc, () => calls++);

		const FAKE_TRANSPORT = Symbol('fake-transport');
		const remote = new Y.Doc({ guid: 'remote' });
		remote.getText('content').insert(0, 'synced');
		const update = Y.encodeStateAsUpdate(remote);
		Y.applyUpdate(handle.ydoc, update, FAKE_TRANSPORT);

		expect(calls).toBe(0);
		remote.destroy();
	});

	test('skips DOCUMENTS_ORIGIN-tagged transactions', () => {
		const factory = makeSimpleFactory();
		const handle = factory.get('a');
		let calls = 0;
		onLocalUpdate(handle.ydoc, () => calls++);

		handle.ydoc.transact(() => {
			handle.ydoc.getText('content').insert(0, 'tagged');
		}, DOCUMENTS_ORIGIN);

		expect(calls).toBe(0);
	});

	test('fires for non-transport remote replays (null origin on applyUpdate)', () => {
		const factory = makeSimpleFactory();
		const handle = factory.get('a');
		let calls = 0;
		onLocalUpdate(handle.ydoc, () => calls++);

		// Simulate IndexedDB replay: applyUpdate with no origin.
		const remote = new Y.Doc({ guid: 'remote' });
		remote.getText('content').insert(0, 'replay');
		const update = Y.encodeStateAsUpdate(remote);
		Y.applyUpdate(handle.ydoc, update);

		expect(calls).toBe(1);
		remote.destroy();
	});

	test('throwing callback is isolated (logged, does not crash caller)', () => {
		const factory = makeSimpleFactory();
		const handle = factory.get('a');
		const prevError = console.error;
		const errors: unknown[] = [];
		console.error = (...args: unknown[]) => errors.push(args);
		try {
			onLocalUpdate(handle.ydoc, () => {
				throw new Error('listener boom');
			});
			// Must not throw out to the caller.
			expect(() => {
				handle.ydoc.getText('content').insert(0, 'x');
			}).not.toThrow();
			expect(errors.length).toBe(1);
		} finally {
			console.error = prevError;
		}
	});

	test('unsubscribe stops future callbacks', () => {
		const factory = makeSimpleFactory();
		const handle = factory.get('a');
		let calls = 0;
		const off = onLocalUpdate(handle.ydoc, () => calls++);
		handle.ydoc.getText('t').insert(0, 'a');
		off();
		handle.ydoc.getText('t').insert(0, 'b');
		expect(calls).toBe(1);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// close / closeAll
// ════════════════════════════════════════════════════════════════════════════

describe('close / closeAll', () => {
	test('close evicts the entry; next .get() constructs fresh', async () => {
		const factory = makeSimpleFactory();
		const h1 = factory.get('a');
		await factory.close('a');
		const h2 = factory.get('a');
		expect(h2).not.toBe(h1);
	});

	test('close on unknown id is a no-op', async () => {
		const factory = makeSimpleFactory();
		await factory.close('nobody');
	});

	test('close destroys the ydoc', async () => {
		const factory = makeSimpleFactory();
		const handle = factory.get('a');
		let destroyed = false;
		handle.ydoc.once('destroy', () => {
			destroyed = true;
		});
		await factory.close('a');
		expect(destroyed).toBe(true);
	});

	test('close awaits attachments\' async disposed promises', async () => {
		let resolveDisposed!: () => void;
		const factory = defineDocument((id: string) => {
			const ydoc = new Y.Doc({ guid: id });
			const idbLike = {
				disposed: new Promise<void>((r) => {
					resolveDisposed = r;
				}),
			};
			return { ydoc, idbLike };
		});
		factory.get('a');

		let settled = false;
		const closePromise = factory.close('a').then(() => {
			settled = true;
		});
		// Even after ydoc.destroy() fires, close() should not resolve until
		// the attachment's async teardown resolves.
		await new Promise((r) => setTimeout(r, 10));
		expect(settled).toBe(false);

		resolveDisposed();
		await closePromise;
		expect(settled).toBe(true);
	});

	test('closeAll awaits every attachment\'s disposed promise', async () => {
		const resolvers: Array<() => void> = [];
		const factory = defineDocument((id: string) => {
			const ydoc = new Y.Doc({ guid: id });
			const idbLike = {
				disposed: new Promise<void>((r) => {
					resolvers.push(r);
				}),
			};
			return { ydoc, idbLike };
		});
		factory.get('a');
		factory.get('b');

		let settled = false;
		const p = factory.closeAll().then(() => {
			settled = true;
		});

		await new Promise((r) => setTimeout(r, 10));
		expect(settled).toBe(false);
		resolvers[0]!();
		await new Promise((r) => setTimeout(r, 10));
		expect(settled).toBe(false); // still waiting on b
		resolvers[1]!();
		await p;
		expect(settled).toBe(true);
	});

	test('closeAll disposes every open entry and re-get creates fresh handles', async () => {
		const factory = makeSimpleFactory();
		const a1 = factory.get('a');
		const b1 = factory.get('b');
		await factory.closeAll();
		expect(factory.get('a')).not.toBe(a1);
		expect(factory.get('b')).not.toBe(b1);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// bind / release — ref-count and grace-period disposal
// ════════════════════════════════════════════════════════════════════════════

describe('bind / release lifecycle', () => {
	test('construct alone does not schedule disposal (refcount starts at 0)', async () => {
		const factory = makeSimpleFactory({ graceMs: 10 });
		const handle = factory.get('a');
		// No bind() → no scheduled disposal.
		await new Promise((r) => setTimeout(r, 25));
		expect(handle.ydoc.isDestroyed).toBe(false);
	});

	test('last release + grace elapsed disposes the ydoc', async () => {
		const factory = makeSimpleFactory({ graceMs: 10 });
		const handle = factory.get('a');
		const release = handle.bind();
		release();
		expect(handle.ydoc.isDestroyed).toBe(false);
		await new Promise((r) => setTimeout(r, 30));
		expect(handle.ydoc.isDestroyed).toBe(true);
		// And the cache has evicted: a fresh .get() returns a new handle.
		const fresh = factory.get('a');
		expect(fresh).not.toBe(handle);
	});

	test('multiple binds refcount; only last release schedules disposal', async () => {
		const factory = makeSimpleFactory({ graceMs: 15 });
		const handle = factory.get('a');
		const r1 = handle.bind();
		const r2 = handle.bind();
		r1();
		await new Promise((r) => setTimeout(r, 30));
		expect(handle.ydoc.isDestroyed).toBe(false);
		r2();
		await new Promise((r) => setTimeout(r, 30));
		expect(handle.ydoc.isDestroyed).toBe(true);
	});

	test('re-bind during grace cancels the pending disposal', async () => {
		const factory = makeSimpleFactory({ graceMs: 20 });
		const handle = factory.get('a');
		const r1 = handle.bind();
		r1();
		await new Promise((r) => setTimeout(r, 5));
		const r2 = handle.bind();

		await new Promise((r) => setTimeout(r, 35));
		expect(handle.ydoc.isDestroyed).toBe(false);

		r2();
		await new Promise((r) => setTimeout(r, 35));
		expect(handle.ydoc.isDestroyed).toBe(true);
	});

	test('release() is idempotent (double-release does not double-decrement)', async () => {
		const factory = makeSimpleFactory({ graceMs: 10 });
		const handle = factory.get('a');
		const r1 = handle.bind();
		const r2 = handle.bind();
		r1();
		r1(); // double release — refcount must stay at 1
		await new Promise((r) => setTimeout(r, 25));
		expect(handle.ydoc.isDestroyed).toBe(false);
		r2();
		await new Promise((r) => setTimeout(r, 25));
		expect(handle.ydoc.isDestroyed).toBe(true);
	});

	test('rapid 0→1→0→1 within the same tick does not fire stale disposal', async () => {
		// Classic bug: release schedules a timer; an immediate re-bind must
		// cancel it. Since the timer is scheduled in the next task queue,
		// a synchronous re-bind must clear it before it fires.
		const factory = makeSimpleFactory({ graceMs: 0 });
		const handle = factory.get('a');
		const r1 = handle.bind();
		r1();
		const r2 = handle.bind();
		// No microtask yield yet — timer hasn't had a chance to fire.
		expect(handle.ydoc.isDestroyed).toBe(false);
		r2();
		await new Promise((r) => setTimeout(r, 15));
		expect(handle.ydoc.isDestroyed).toBe(true);
	});

	test('close() during grace fires disposal synchronously and cancels the pending timer', async () => {
		const factory = makeSimpleFactory({ graceMs: 100 });
		const handle = factory.get('a');
		const release = handle.bind();
		release();
		// Grace pending. close() must fire disposal now, not later.
		await factory.close('a');
		expect(handle.ydoc.isDestroyed).toBe(true);
	});

	test('release captured before close is a safe no-op after close', async () => {
		const factory = makeSimpleFactory({ graceMs: 100 });
		const handle = factory.get('a');
		const release = handle.bind();
		await factory.close('a');
		// Stale release must not throw and must not resurrect any timer.
		release();
		await new Promise((r) => setTimeout(r, 20));
		// Already destroyed; not re-destroyed — no crash.
		expect(handle.ydoc.isDestroyed).toBe(true);
	});

	test('bind on a stale handle after close is a safe no-op', async () => {
		const factory = makeSimpleFactory({ graceMs: 100 });
		const handle = factory.get('a');
		await factory.close('a');
		const staleRelease = handle.bind();
		// No error, no side effects.
		staleRelease();
		expect(handle.ydoc.isDestroyed).toBe(true);
	});

	test('bind lifecycle is per-id — releasing one doc does not affect another', async () => {
		const factory = makeSimpleFactory({ graceMs: 15 });
		const a = factory.get('a');
		const b = factory.get('b');
		const ra = a.bind();
		const rb = b.bind();

		ra();
		await new Promise((r) => setTimeout(r, 25));
		expect(a.ydoc.isDestroyed).toBe(true);
		expect(b.ydoc.isDestroyed).toBe(false);

		rb();
		await new Promise((r) => setTimeout(r, 25));
		expect(b.ydoc.isDestroyed).toBe(true);
	});

	test('0 → 1 → 0 → 1 after dispose: new construction after grace', async () => {
		const factory = makeSimpleFactory({ graceMs: 5 });
		const a1 = factory.get('a');
		a1.bind()();
		await new Promise((r) => setTimeout(r, 15));
		expect(a1.ydoc.isDestroyed).toBe(true);

		const a2 = factory.get('a');
		expect(a2).not.toBe(a1);
		expect(a2.ydoc.isDestroyed).toBe(false);
	});

	test('closeAll cancels all pending grace timers', async () => {
		const factory = makeSimpleFactory({ graceMs: 50 });
		const docs = ['a', 'b', 'c'].map((id) => {
			const h = factory.get(id);
			h.bind()();
			return h;
		});

		await factory.closeAll();
		// All must be destroyed immediately, not after the pending 50ms timer.
		for (const h of docs) expect(h.ydoc.isDestroyed).toBe(true);

		// Waiting longer must not revive or re-run anything.
		await new Promise((r) => setTimeout(r, 80));
		for (const h of docs) expect(h.ydoc.isDestroyed).toBe(true);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// read sugar
// ════════════════════════════════════════════════════════════════════════════

describe('factory.read', () => {
	test('resolves with the handle after whenLoaded', async () => {
		let resolve!: () => void;
		const factory = defineDocument((id: string) => {
			const ydoc = new Y.Doc({ guid: id });
			const idbLike = {
				whenLoaded: new Promise<void>((r) => {
					resolve = r;
				}),
			};
			return { ydoc, idbLike };
		});

		let done = false;
		const p = factory.read('a').then((h) => {
			done = true;
			return h;
		});
		await new Promise((r) => setTimeout(r, 5));
		expect(done).toBe(false);
		resolve();
		const handle = await p;
		expect(done).toBe(true);
		expect(handle.ydoc.guid).toBe('a');
	});
});
