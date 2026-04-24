import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { createDocumentFactory } from './document.js';
import { onLocalUpdate } from './on-local-update.js';

/**
 * Build a factory whose closure returns a minimal bundle
 * `{ ydoc, [Symbol.dispose] }` plus any extras the test provides.
 */
function makeSimpleFactory(opts?: { gcTime?: number }) {
	return createDocumentFactory(
		(id: string) => {
			const ydoc = new Y.Doc({ guid: id });
			return {
				ydoc,
				[Symbol.dispose]() {
					ydoc.destroy();
				},
			};
		},
		{ gcTime: opts?.gcTime },
	);
}

// ════════════════════════════════════════════════════════════════════════════
// open / cache identity
// ════════════════════════════════════════════════════════════════════════════

describe('open / cache identity', () => {
	test('same id shares ydoc across handles; different ids get separate ydocs', () => {
		const factory = makeSimpleFactory();
		const [a1, a2, a3] = [
			factory.open('a'),
			factory.open('a'),
			factory.open('a'),
		];
		const b = factory.open('b');

		expect(a1).not.toBe(a2);
		expect(a1.ydoc).toBe(a2.ydoc);
		expect(a2.ydoc).toBe(a3.ydoc);
		expect(b.ydoc).not.toBe(a1.ydoc);
		expect(b.ydoc.guid).toBe('b');

		a1.dispose();
		a2.dispose();
		a3.dispose();
		b.dispose();
	});

	test('build closure runs without coupling to a parent workspace', () => {
		const factory = createDocumentFactory((id: string) => {
			const ydoc = new Y.Doc({ guid: id });
			return {
				ydoc,
				createdAt: Date.now(),
				[Symbol.dispose]() {
					ydoc.destroy();
				},
			};
		});
		const handle = factory.open('solo');
		expect(handle.ydoc).toBeInstanceOf(Y.Doc);
		expect(typeof handle.createdAt).toBe('number');
		handle.dispose();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Minimal bundle type — regression pin for reduced generic bound
// ════════════════════════════════════════════════════════════════════════════

describe('minimal bundle type', () => {
	test('createDocumentFactory compiles and runs with a bundle of just { ydoc, [Symbol.dispose] }', () => {
		// No whenReady, no whenDisposed, no extra fields. This pins the
		// contract: Document requires nothing beyond ydoc and a sync
		// disposer.
		const factory = createDocumentFactory((id: string) => {
			const ydoc = new Y.Doc({ guid: id });
			return {
				ydoc,
				[Symbol.dispose]() {
					ydoc.destroy();
				},
			};
		});
		const h = factory.open('minimal');
		expect(h.ydoc).toBeInstanceOf(Y.Doc);
		expect(typeof h.dispose).toBe('function');
		h.dispose();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Throwing closure doesn't poison the cache
// ════════════════════════════════════════════════════════════════════════════

describe('throwing build closure', () => {
	test('error propagates and the cache does not store the id', () => {
		let calls = 0;
		const factory = createDocumentFactory((id: string) => {
			calls++;
			if (calls === 1) throw new Error('boom');
			const ydoc = new Y.Doc({ guid: id });
			return {
				ydoc,
				[Symbol.dispose]() {
					ydoc.destroy();
				},
			};
		});

		expect(() => factory.open('foo')).toThrow('boom');
		// The second attempt must run the closure again, not hit a poisoned cache entry.
		const handle = factory.open('foo');
		expect(calls).toBe(2);
		expect(handle.ydoc.guid).toBe('foo');
		handle.dispose();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Guid stability
// ════════════════════════════════════════════════════════════════════════════

describe('guid stability', () => {
	test('stable guids reconstruct; drifting guid throws on reconstruction', () => {
		let seed = 0;
		let stable = false;
		const factory = createDocumentFactory((id: string) => {
			const ydoc = new Y.Doc({
				guid: stable ? `stable-${id}` : `${id}-${seed++}`,
			});
			return {
				ydoc,
				[Symbol.dispose]() {
					ydoc.destroy();
				},
			};
		});

		// Stable branch: same guid across reconstructions is accepted.
		stable = true;
		const h1 = factory.open('stable');
		const guid1 = h1.ydoc.guid;
		h1.dispose();
		factory.close('stable');
		const h2 = factory.open('stable');
		expect(h2.ydoc.guid).toBe(guid1);
		expect(h2.ydoc).not.toBe(h1.ydoc); // fresh ydoc after close
		h2.dispose();

		// Drift branch: guid changes across reconstructions and the factory throws.
		stable = false;
		const drift1 = factory.open('drift');
		expect(drift1.ydoc.guid).toBe('drift-0');
		drift1.dispose();
		factory.close('drift');
		expect(() => factory.open('drift')).toThrow(/guid instability/);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// whenReady — typed optional field on Document, composed by the builder
// ════════════════════════════════════════════════════════════════════════════

describe('whenReady as builder convention', () => {
	test('resolves immediately when the bundle exposes a pre-resolved whenReady', async () => {
		const factory = createDocumentFactory((id: string) => {
			const ydoc = new Y.Doc({ guid: id });
			return {
				ydoc,
				whenReady: Promise.resolve(),
				[Symbol.dispose]() {
					ydoc.destroy();
				},
			};
		});
		const handle = factory.open('a');
		await handle.whenReady; // should not hang
		expect(true).toBe(true);
		handle.dispose();
	});

	test('composes multiple attachment ready-promises inside the builder', async () => {
		let resolveA!: () => void;
		let resolveB!: () => void;
		const factory = createDocumentFactory((id: string) => {
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
			return {
				ydoc,
				idbLike,
				syncLike,
				whenReady: Promise.all([idbLike.whenLoaded, syncLike.whenLoaded]),
				[Symbol.dispose]() {
					ydoc.destroy();
				},
			};
		});

		const handle = factory.open('a');
		let resolved = false;
		void handle.whenReady.then(() => {
			resolved = true;
		});

		await new Promise((r) => setTimeout(r, 5));
		expect(resolved).toBe(false);

		resolveA();
		await new Promise((r) => setTimeout(r, 5));
		expect(resolved).toBe(false); // still waiting on B

		resolveB();
		await handle.whenReady;
		expect(resolved).toBe(true);
		handle.dispose();
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
		handle.dispose();
	});

	test('skips applyUpdate with symbol origin (transport)', () => {
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
		handle.dispose();
	});

	test('skips applyUpdate with no origin (IndexedDB-style replay)', () => {
		// tx.local is false for any applyUpdate regardless of origin shape,
		// so IDB hydration (which uses an instance origin, not a symbol) is
		// correctly filtered — this is the bug the old symbol-shape filter
		// missed.
		const factory = makeSimpleFactory();
		const handle = factory.open('a');
		let calls = 0;
		onLocalUpdate(handle.ydoc, () => calls++);

		const remote = new Y.Doc({ guid: 'remote' });
		remote.getText('content').insert(0, 'replay');
		const update = Y.encodeStateAsUpdate(remote);
		Y.applyUpdate(handle.ydoc, update);

		expect(calls).toBe(0);
		remote.destroy();
		handle.dispose();
	});

	test('skips applyUpdate with instance origin (IndexedDB provider shape)', () => {
		const factory = makeSimpleFactory();
		const handle = factory.open('a');
		let calls = 0;
		onLocalUpdate(handle.ydoc, () => calls++);

		const remote = new Y.Doc({ guid: 'remote' });
		remote.getText('content').insert(0, 'replay');
		const update = Y.encodeStateAsUpdate(remote);
		// y-indexeddb passes its persistence instance as origin, not a symbol.
		const fakeProvider = { kind: 'indexeddb' };
		Y.applyUpdate(handle.ydoc, update, fakeProvider);

		expect(calls).toBe(0);
		remote.destroy();
		handle.dispose();
	});

	test('throwing callback is isolated and does not crash caller', () => {
		const factory = makeSimpleFactory();
		const handle = factory.open('a');
		const prevError = console.error;
		console.error = () => {};
		try {
			onLocalUpdate(handle.ydoc, () => {
				throw new Error('listener boom');
			});
			expect(() => {
				handle.ydoc.getText('content').insert(0, 'x');
			}).not.toThrow();
		} finally {
			console.error = prevError;
		}
		handle.dispose();
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
		handle.dispose();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// close / closeAll
// ════════════════════════════════════════════════════════════════════════════

describe('close / closeAll', () => {
	test('close evicts the entry; next .open() constructs fresh', () => {
		const factory = makeSimpleFactory();
		const h1 = factory.open('a');
		const ydoc1 = h1.ydoc;
		factory.close('a');
		const h2 = factory.open('a');
		expect(h2.ydoc).not.toBe(ydoc1);
		h2.dispose();
	});

	test('close on unknown id is a no-op', () => {
		const factory = makeSimpleFactory();
		factory.close('nobody');
	});

	test('close destroys the ydoc synchronously', () => {
		const factory = makeSimpleFactory();
		const handle = factory.open('a');
		let destroyed = false;
		handle.ydoc.once('destroy', () => {
			destroyed = true;
		});
		factory.close('a');
		expect(destroyed).toBe(true);
	});

	test('sync-close cascade: close(id) fires [Symbol.dispose] synchronously, attachment listeners observe destroy before close() returns', async () => {
		// The framework is now honest about sync teardown: [Symbol.dispose]()
		// runs inside close(), which calls ydoc.destroy(), which fires the
		// 'destroy' event synchronously. Attachments wire their teardown
		// inside that event handler. This test pins that cascade.
		let resolveSentinel!: () => void;
		const sentinel = new Promise<void>((r) => {
			resolveSentinel = r;
		});

		const factory = createDocumentFactory((id: string) => {
			const ydoc = new Y.Doc({ guid: id });
			// Attachment-style hook: listen on destroy, resolve sentinel.
			ydoc.on('destroy', () => {
				resolveSentinel();
			});
			return {
				ydoc,
				[Symbol.dispose]() {
					ydoc.destroy();
				},
			};
		});
		factory.open('a');

		// No await — close returns void and cascades synchronously.
		factory.close('a');

		await sentinel;
	});

	test('closeAll disposes every open entry and re-open creates fresh ydocs', () => {
		const factory = makeSimpleFactory();
		const a1 = factory.open('a');
		const b1 = factory.open('b');
		const ydocA = a1.ydoc;
		const ydocB = b1.ydoc;
		factory.closeAll();
		const a2 = factory.open('a');
		const b2 = factory.open('b');
		expect(a2.ydoc).not.toBe(ydocA);
		expect(b2.ydoc).not.toBe(ydocB);
		a2.dispose();
		b2.dispose();
	});

	test('a throwing [Symbol.dispose] does not propagate out of close() and evicts the cache', () => {
		let calls = 0;
		const factory = createDocumentFactory((id: string) => {
			calls++;
			const ydoc = new Y.Doc({ guid: id });
			return {
				ydoc,
				[Symbol.dispose]() {
					ydoc.destroy();
					throw new Error('dispose boom');
				},
			};
		});

		const prevError = console.error;
		console.error = () => {};
		try {
			factory.open('a');
			expect(() => factory.close('a')).not.toThrow();
			const h2 = factory.open('a');
			expect(calls).toBe(2);
			h2.dispose();
		} finally {
			console.error = prevError;
		}
	});
});

// ════════════════════════════════════════════════════════════════════════════
// open / dispose — ref-count, grace-period disposal, disposable protocol
// ════════════════════════════════════════════════════════════════════════════

describe('open / dispose', () => {
	test('ref-count: two opens require two disposes before grace timer starts', async () => {
		const factory = makeSimpleFactory({ gcTime: 15 });
		const h1 = factory.open('a');
		const h2 = factory.open('a');
		h1.dispose();
		await new Promise((r) => setTimeout(r, 30));
		expect(h1.ydoc.isDestroyed).toBe(false);
		h2.dispose();
		await new Promise((r) => setTimeout(r, 30));
		expect(h1.ydoc.isDestroyed).toBe(true);
	});

	test('dispose() is idempotent per handle', async () => {
		const factory = makeSimpleFactory({ gcTime: 10 });
		const h1 = factory.open('a');
		const h2 = factory.open('a');
		h1.dispose();
		h1.dispose();
		await new Promise((r) => setTimeout(r, 30));
		expect(h1.ydoc.isDestroyed).toBe(false);
		h2.dispose();
		await new Promise((r) => setTimeout(r, 30));
		expect(h1.ydoc.isDestroyed).toBe(true);
	});

	test('using h = docs.open(id) — disposes on scope exit', async () => {
		const factory = makeSimpleFactory({ gcTime: 10 });
		let ydocRef: Y.Doc;
		{
			using h = factory.open('a');
			ydocRef = h.ydoc;
			expect(h.ydoc.isDestroyed).toBe(false);
		}
		expect(ydocRef.isDestroyed).toBe(false);
		await new Promise((r) => setTimeout(r, 30));
		expect(ydocRef.isDestroyed).toBe(true);
	});

	test('open() during grace cancels the pending disposal', async () => {
		const factory = makeSimpleFactory({ gcTime: 20 });
		const h1 = factory.open('a');
		h1.dispose();
		await new Promise((r) => setTimeout(r, 5));
		const h2 = factory.open('a');
		expect(h2.ydoc).toBe(h1.ydoc);

		await new Promise((r) => setTimeout(r, 35));
		expect(h2.ydoc.isDestroyed).toBe(false);

		h2.dispose();
		await new Promise((r) => setTimeout(r, 35));
		expect(h2.ydoc.isDestroyed).toBe(true);
	});

	test('close() during grace fires disposal synchronously', () => {
		const factory = makeSimpleFactory({ gcTime: 100 });
		const h = factory.open('a');
		h.dispose();
		factory.close('a');
		expect(h.ydoc.isDestroyed).toBe(true);
	});

	test('dispose captured before close is a safe no-op after close', async () => {
		const factory = makeSimpleFactory({ gcTime: 100 });
		const h = factory.open('a');
		factory.close('a');
		h.dispose();
		await new Promise((r) => setTimeout(r, 20));
		expect(h.ydoc.isDestroyed).toBe(true);
	});

	test('closeAll cancels all pending grace timers', async () => {
		const factory = makeSimpleFactory({ gcTime: 50 });
		const docs = ['a', 'b', 'c'].map((id) => {
			const h = factory.open(id);
			h.dispose();
			return h;
		});

		factory.closeAll();
		for (const h of docs) expect(h.ydoc.isDestroyed).toBe(true);

		await new Promise((r) => setTimeout(r, 80));
		for (const h of docs) expect(h.ydoc.isDestroyed).toBe(true);
	});

	test('gcTime: 0 — last dispose tears down synchronously', () => {
		const factory = makeSimpleFactory({ gcTime: 0 });
		const h1 = factory.open('a');
		const h2 = factory.open('a');
		h1.dispose();
		expect(h1.ydoc.isDestroyed).toBe(false);
		h2.dispose();
		expect(h1.ydoc.isDestroyed).toBe(true);
	});

	test('gcTime: Infinity — entry stays live indefinitely; close() forces teardown', async () => {
		const factory = makeSimpleFactory({ gcTime: Infinity });
		const h = factory.open('a');
		const ydoc = h.ydoc;
		h.dispose();
		await new Promise((r) => setTimeout(r, 50));
		expect(ydoc.isDestroyed).toBe(false);

		const h2 = factory.open('a');
		expect(h2.ydoc).toBe(ydoc);
		h2.dispose();

		factory.close('a');
		expect(ydoc.isDestroyed).toBe(true);
	});
});
