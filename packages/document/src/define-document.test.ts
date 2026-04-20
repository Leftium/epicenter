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
// open / cache identity
// ════════════════════════════════════════════════════════════════════════════

describe('open / cache identity', () => {
	test('returns distinct wrappers for the same id, sharing the underlying ydoc', () => {
		const factory = makeSimpleFactory();
		const h1 = factory.open('a');
		const h2 = factory.open('a');
		expect(h1).not.toBe(h2);
		expect(h1.ydoc).toBe(h2.ydoc);
		h1.release();
		h2.release();
	});

	test('returns independent handles for different ids', () => {
		const factory = makeSimpleFactory();
		const h1 = factory.open('a');
		const h2 = factory.open('b');
		expect(h1.ydoc).not.toBe(h2.ydoc);
		expect(h1.ydoc.guid).toBe('a');
		expect(h2.ydoc.guid).toBe('b');
		h1.release();
		h2.release();
	});

	test('concurrent .open(sameId) is race-safe (construction is synchronous)', () => {
		// No await between Map.get and Map.set — three calls in the same tick
		// must share the same underlying ydoc.
		const factory = makeSimpleFactory();
		const [a, b, c] = [
			factory.open('x'),
			factory.open('x'),
			factory.open('x'),
		];
		expect(a.ydoc).toBe(b.ydoc);
		expect(b.ydoc).toBe(c.ydoc);
		a.release();
		b.release();
		c.release();
	});

	test('build closure runs without coupling to a parent workspace', () => {
		// No workspace, no tables — just the primitive.
		const factory = defineDocument((id: string) => {
			const ydoc = new Y.Doc({ guid: id });
			return { ydoc, createdAt: Date.now() };
		});
		const handle = factory.open('solo');
		expect(handle.ydoc).toBeInstanceOf(Y.Doc);
		expect(typeof handle.createdAt).toBe('number');
		handle.release();
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

		expect(() => factory.open('foo')).toThrow('boom');
		// The second attempt must run the closure again, not hit a poisoned cache entry.
		const handle = factory.open('foo');
		expect(calls).toBe(2);
		expect(handle.ydoc.guid).toBe('foo');
		handle.release();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Reserved keys
// ════════════════════════════════════════════════════════════════════════════

describe('reserved attachment keys', () => {
	test('throws if build returns top-level "release"', () => {
		const factory = defineDocument((id: string) => {
			const ydoc = new Y.Doc({ guid: id });
			return { ydoc, release: 'oops' } as never;
		});
		expect(() => factory.open('a')).toThrow(/reserved key "release"/);
	});

	test('throws if build returns top-level "whenLoaded"', () => {
		const factory = defineDocument((id: string) => {
			const ydoc = new Y.Doc({ guid: id });
			return { ydoc, whenLoaded: Promise.resolve() } as never;
		});
		expect(() => factory.open('a')).toThrow(/reserved key "whenLoaded"/);
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

		const h1 = factory.open('foo');
		expect(h1.ydoc.guid).toBe('foo-0');
		// Evict so the next open() reruns the closure.
		h1.release();
		await factory.close('foo');
		expect(() => factory.open('foo')).toThrow(/guid instability/);
	});

	test('accepts stable guids across reconstructions', async () => {
		const factory = defineDocument((id: string) => {
			const ydoc = new Y.Doc({ guid: `stable-${id}` });
			return { ydoc };
		});
		const h1 = factory.open('foo');
		const guid1 = h1.ydoc.guid;
		h1.release();
		await factory.close('foo');
		const h2 = factory.open('foo');
		expect(h2.ydoc.guid).toBe(guid1);
		expect(h2.ydoc).not.toBe(h1.ydoc); // fresh ydoc after close
		h2.release();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// whenLoaded aggregation
// ════════════════════════════════════════════════════════════════════════════

describe('whenLoaded', () => {
	test('resolves immediately when no attachment exposes whenLoaded', async () => {
		const factory = makeSimpleFactory();
		const handle = factory.open('a');
		await handle.whenLoaded; // should not hang
		expect(true).toBe(true);
		handle.release();
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

		const handle = factory.open('a');
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
		handle.release();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// onLocalUpdate filtering
// ════════════════════════════════════════════════════════════════════════════

describe('onLocalUpdate', () => {
	test('fires for local edits (null origin)', () => {
		const factory = makeSimpleFactory();
		const handle = factory.open('a');
		let calls = 0;
		onLocalUpdate(handle.ydoc, () => calls++);
		handle.ydoc.getText('content').insert(0, 'hi');
		expect(calls).toBe(1);
		handle.release();
	});

	test('skips transport-origin updates (Symbol origin)', () => {
		const factory = makeSimpleFactory();
		const handle = factory.open('a');
		let calls = 0;
		onLocalUpdate(handle.ydoc, () => calls++);

		const FAKE_TRANSPORT = Symbol('fake-transport');
		const remote = new Y.Doc({ guid: 'remote' });
		remote.getText('content').insert(0, 'synced');
		const update = Y.encodeStateAsUpdate(remote);
		Y.applyUpdate(handle.ydoc, update, FAKE_TRANSPORT);

		expect(calls).toBe(0);
		remote.destroy();
		handle.release();
	});

	test('skips DOCUMENTS_ORIGIN-tagged transactions', () => {
		const factory = makeSimpleFactory();
		const handle = factory.open('a');
		let calls = 0;
		onLocalUpdate(handle.ydoc, () => calls++);

		handle.ydoc.transact(() => {
			handle.ydoc.getText('content').insert(0, 'tagged');
		}, DOCUMENTS_ORIGIN);

		expect(calls).toBe(0);
		handle.release();
	});

	test('fires for non-transport remote replays (null origin on applyUpdate)', () => {
		const factory = makeSimpleFactory();
		const handle = factory.open('a');
		let calls = 0;
		onLocalUpdate(handle.ydoc, () => calls++);

		// Simulate IndexedDB replay: applyUpdate with no origin.
		const remote = new Y.Doc({ guid: 'remote' });
		remote.getText('content').insert(0, 'replay');
		const update = Y.encodeStateAsUpdate(remote);
		Y.applyUpdate(handle.ydoc, update);

		expect(calls).toBe(1);
		remote.destroy();
		handle.release();
	});

	test('throwing callback is isolated (logged, does not crash caller)', () => {
		const factory = makeSimpleFactory();
		const handle = factory.open('a');
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
		handle.release();
	});

	test('unsubscribe stops future callbacks', () => {
		const factory = makeSimpleFactory();
		const handle = factory.open('a');
		let calls = 0;
		const off = onLocalUpdate(handle.ydoc, () => calls++);
		handle.ydoc.getText('t').insert(0, 'a');
		off();
		handle.ydoc.getText('t').insert(0, 'b');
		expect(calls).toBe(1);
		handle.release();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// close / closeAll
// ════════════════════════════════════════════════════════════════════════════

describe('close / closeAll', () => {
	test('close evicts the entry; next .open() constructs fresh', async () => {
		const factory = makeSimpleFactory();
		const h1 = factory.open('a');
		const ydoc1 = h1.ydoc;
		await factory.close('a');
		const h2 = factory.open('a');
		expect(h2.ydoc).not.toBe(ydoc1);
		h2.release();
	});

	test('close on unknown id is a no-op', async () => {
		const factory = makeSimpleFactory();
		await factory.close('nobody');
	});

	test('close destroys the ydoc', async () => {
		const factory = makeSimpleFactory();
		const handle = factory.open('a');
		let destroyed = false;
		handle.ydoc.once('destroy', () => {
			destroyed = true;
		});
		await factory.close('a');
		expect(destroyed).toBe(true);
	});

	test("close awaits attachments' async disposed promises", async () => {
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
		factory.open('a');

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

	test("closeAll awaits every attachment's disposed promise", async () => {
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
		factory.open('a');
		factory.open('b');

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

	test('closeAll disposes every open entry and re-open creates fresh ydocs', async () => {
		const factory = makeSimpleFactory();
		const a1 = factory.open('a');
		const b1 = factory.open('b');
		const ydocA = a1.ydoc;
		const ydocB = b1.ydoc;
		await factory.closeAll();
		const a2 = factory.open('a');
		const b2 = factory.open('b');
		expect(a2.ydoc).not.toBe(ydocA);
		expect(b2.ydoc).not.toBe(ydocB);
		a2.release();
		b2.release();
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
		handle.release();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// open / release — ref-count, grace-period disposal, disposable protocol
// ════════════════════════════════════════════════════════════════════════════

describe('open / release', () => {
	test('open() retains — ref-count increments, no disposal pending', async () => {
		const factory = makeSimpleFactory({ graceMs: 10 });
		const h = factory.open('a');
		// Pure open() with no release: count > 0, no timer scheduled.
		await new Promise((r) => setTimeout(r, 25));
		expect(h.ydoc.isDestroyed).toBe(false);
		h.release();
	});

	test('open() + release() — grace timer fires, ydoc destroyed', async () => {
		const factory = makeSimpleFactory({ graceMs: 10 });
		const h = factory.open('a');
		h.release();
		expect(h.ydoc.isDestroyed).toBe(false);
		await new Promise((r) => setTimeout(r, 30));
		expect(h.ydoc.isDestroyed).toBe(true);
	});

	test('two open() calls on same id return distinct wrappers but share ydoc/attachments', () => {
		const factory = makeSimpleFactory();
		const h1 = factory.open('a');
		const h2 = factory.open('a');
		expect(h1).not.toBe(h2);
		expect(h1.ydoc).toBe(h2.ydoc);
		h1.release();
		h2.release();
	});

	test('two open() calls require two releases before grace timer starts', async () => {
		const factory = makeSimpleFactory({ graceMs: 15 });
		const h1 = factory.open('a');
		const h2 = factory.open('a');
		h1.release();
		await new Promise((r) => setTimeout(r, 30));
		expect(h1.ydoc.isDestroyed).toBe(false);
		h2.release();
		await new Promise((r) => setTimeout(r, 30));
		expect(h1.ydoc.isDestroyed).toBe(true);
	});

	test('using h = docs.open(id) — releases on scope exit', async () => {
		const factory = makeSimpleFactory({ graceMs: 10 });
		let ydocRef: Y.Doc;
		{
			using h = factory.open('a');
			ydocRef = h.ydoc;
			expect(h.ydoc.isDestroyed).toBe(false);
		}
		// Released on scope exit; grace timer queued.
		expect(ydocRef.isDestroyed).toBe(false);
		await new Promise((r) => setTimeout(r, 30));
		expect(ydocRef.isDestroyed).toBe(true);
	});

	test('await using h = await docs.read(id) — releases on scope exit', async () => {
		const factory = makeSimpleFactory({ graceMs: 10 });
		let ydocRef: Y.Doc;
		{
			await using h = await factory.read('a');
			ydocRef = h.ydoc;
			expect(h.ydoc.isDestroyed).toBe(false);
		}
		expect(ydocRef.isDestroyed).toBe(false);
		await new Promise((r) => setTimeout(r, 30));
		expect(ydocRef.isDestroyed).toBe(true);
	});

	test('peek(id) on unopened id returns undefined', () => {
		const factory = makeSimpleFactory();
		expect(factory.peek('missing')).toBeUndefined();
	});

	test('peek(id) on open id returns snapshot without retaining', async () => {
		const factory = makeSimpleFactory({ graceMs: 10 });
		const h = factory.open('a');
		const snap = factory.peek('a');
		expect(snap).toBeDefined();
		expect(snap!.ydoc).toBe(h.ydoc);
		// peek must not increment the count — one release disposes.
		h.release();
		await new Promise((r) => setTimeout(r, 30));
		expect(h.ydoc.isDestroyed).toBe(true);
	});

	test('peek(id) snapshot has no release() or Symbol.dispose', () => {
		const factory = makeSimpleFactory();
		const h = factory.open('a');
		const snap = factory.peek('a')!;
		expect((snap as unknown as { release?: unknown }).release).toBeUndefined();
		expect(
			(snap as unknown as { [Symbol.dispose]?: unknown })[Symbol.dispose],
		).toBeUndefined();
		expect(
			(snap as unknown as { [Symbol.asyncDispose]?: unknown })[
				Symbol.asyncDispose
			],
		).toBeUndefined();
		h.release();
	});

	test('release() is idempotent per wrapper', async () => {
		const factory = makeSimpleFactory({ graceMs: 10 });
		const h1 = factory.open('a');
		const h2 = factory.open('a');
		h1.release();
		h1.release(); // double release — must not drop h2's count.
		await new Promise((r) => setTimeout(r, 30));
		expect(h1.ydoc.isDestroyed).toBe(false);
		h2.release();
		await new Promise((r) => setTimeout(r, 30));
		expect(h1.ydoc.isDestroyed).toBe(true);
	});

	test('release() on one wrapper does not affect others', async () => {
		const factory = makeSimpleFactory({ graceMs: 10 });
		const h1 = factory.open('a');
		const h2 = factory.open('a');
		h1.release();
		await new Promise((r) => setTimeout(r, 30));
		// h2 still retaining — not destroyed.
		expect(h2.ydoc.isDestroyed).toBe(false);
		// And h2 can still be used.
		h2.ydoc.getText('t').insert(0, 'ok');
		expect(h2.ydoc.getText('t').toString()).toBe('ok');
		h2.release();
	});

	test('open() during grace cancels the pending disposal', async () => {
		const factory = makeSimpleFactory({ graceMs: 20 });
		const h1 = factory.open('a');
		h1.release();
		await new Promise((r) => setTimeout(r, 5));
		const h2 = factory.open('a');
		expect(h2.ydoc).toBe(h1.ydoc);

		await new Promise((r) => setTimeout(r, 35));
		expect(h2.ydoc.isDestroyed).toBe(false);

		h2.release();
		await new Promise((r) => setTimeout(r, 35));
		expect(h2.ydoc.isDestroyed).toBe(true);
	});

	test('rapid open→release→open within the same tick does not fire stale disposal', async () => {
		// release() schedules the grace timer as a setTimeout; a synchronous
		// re-open() must cancel the pending timer before it fires.
		const factory = makeSimpleFactory({ graceMs: 0 });
		const h1 = factory.open('a');
		h1.release();
		const h2 = factory.open('a');
		// No microtask yield yet — timer hasn't had a chance to fire.
		expect(h2.ydoc.isDestroyed).toBe(false);
		h2.release();
		await new Promise((r) => setTimeout(r, 15));
		expect(h2.ydoc.isDestroyed).toBe(true);
	});

	test('close() during grace fires disposal synchronously and cancels the pending timer', async () => {
		const factory = makeSimpleFactory({ graceMs: 100 });
		const h = factory.open('a');
		h.release();
		// Grace pending. close() must fire disposal now, not later.
		await factory.close('a');
		expect(h.ydoc.isDestroyed).toBe(true);
	});

	test('release captured before close is a safe no-op after close', async () => {
		const factory = makeSimpleFactory({ graceMs: 100 });
		const h = factory.open('a');
		await factory.close('a');
		// Stale release on a disposed wrapper must not throw or resurrect.
		h.release();
		await new Promise((r) => setTimeout(r, 20));
		expect(h.ydoc.isDestroyed).toBe(true);
	});

	test('release lifecycle is per-id — releasing one doc does not affect another', async () => {
		const factory = makeSimpleFactory({ graceMs: 15 });
		const a = factory.open('a');
		const b = factory.open('b');

		a.release();
		await new Promise((r) => setTimeout(r, 25));
		expect(a.ydoc.isDestroyed).toBe(true);
		expect(b.ydoc.isDestroyed).toBe(false);

		b.release();
		await new Promise((r) => setTimeout(r, 25));
		expect(b.ydoc.isDestroyed).toBe(true);
	});

	test('open → release → dispose → open after grace produces a fresh construction', async () => {
		const factory = makeSimpleFactory({ graceMs: 5 });
		const a1 = factory.open('a');
		const ydoc1 = a1.ydoc;
		a1.release();
		await new Promise((r) => setTimeout(r, 15));
		expect(ydoc1.isDestroyed).toBe(true);

		const a2 = factory.open('a');
		expect(a2.ydoc).not.toBe(ydoc1);
		expect(a2.ydoc.isDestroyed).toBe(false);
		a2.release();
	});

	test('closeAll cancels all pending grace timers', async () => {
		const factory = makeSimpleFactory({ graceMs: 50 });
		const docs = ['a', 'b', 'c'].map((id) => {
			const h = factory.open(id);
			h.release();
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
