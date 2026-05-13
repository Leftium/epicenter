/**
 * Tests for the pure session lifecycle. Asserts the invariants the
 * Svelte-facing `createSession` wrapper depends on:
 *
 *   - signed-in -> reauth-required -> signed-in preserves the same payload
 *     instance (object identity).
 *   - signed-out disposes the payload and clears the slot.
 *   - cold boot in reauth-required builds from the preserved identity.
 *   - lifecycle disposal disposes the payload and clears the slot.
 *
 * The lifecycle does not test a user-switch transition. OAuth session storage
 * is single-user by structure, so two consecutive identity-bearing states are
 * guaranteed to carry the same user; the lifecycle trusts that invariant.
 */

import { expect, test } from 'bun:test';
import type { AuthClient, AuthState, WorkspaceIdentity } from '@epicenter/auth';
import { createSessionLifecycle } from './session-lifecycle.js';

function makeIdentity({
	userId = 'user-1',
}: {
	userId?: string;
} = {}): WorkspaceIdentity {
	return {
		user: { id: userId, email: `${userId}@example.com` },
		encryptionKeys: [
			{
				version: 1,
				userKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
			},
		],
	};
}

type Listener = (state: AuthState) => void;

function makeAuth(initial: AuthState) {
	let state = initial;
	const listeners = new Set<Listener>();
	const auth = {
		get state() {
			return state;
		},
		onStateChange(listener: Listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		setState(next: AuthState) {
			state = next;
			for (const listener of listeners) listener(next);
		},
	};
	return auth as typeof auth & AuthClient;
}

type TestApp = Disposable & {
	id: number;
	userId: string;
	disposed: boolean;
};

let appCounter = 0;
function makeBuild() {
	const built: TestApp[] = [];
	const build = (identity: WorkspaceIdentity): TestApp => {
		const app: TestApp = {
			id: ++appCounter,
			userId: identity.user.id,
			disposed: false,
			[Symbol.dispose]() {
				app.disposed = true;
			},
		};
		built.push(app);
		return app;
	};
	return { build, built };
}

function makeHolder<T extends Disposable>() {
	let payload: T | null = null;
	return {
		getPayload: () => payload,
		setPayload: (next: T | null) => {
			payload = next;
		},
	};
}

test('signed-in -> reauth-required -> signed-in preserves the same payload', () => {
	const auth = makeAuth({
		status: 'signed-in',
		identity: makeIdentity(),
	});
	const { build, built } = makeBuild();
	const holder = makeHolder<TestApp>();

	using _lifecycle = createSessionLifecycle({
		auth,
		build,
		getPayload: holder.getPayload,
		setPayload: holder.setPayload,
	});

	const initial = holder.getPayload();
	expect(initial).not.toBeNull();
	expect(built).toHaveLength(1);
	expect(initial).toBe(built[0]!);
	expect(initial!.disposed).toBe(false);

	auth.setState({ status: 'reauth-required', identity: makeIdentity() });
	expect(holder.getPayload()).toBe(initial);
	expect(built).toHaveLength(1);
	expect(initial!.disposed).toBe(false);

	auth.setState({ status: 'signed-in', identity: makeIdentity() });
	expect(holder.getPayload()).toBe(initial);
	expect(built).toHaveLength(1);
	expect(initial!.disposed).toBe(false);
});

test('signed-out disposes the payload and clears the slot', () => {
	const auth = makeAuth({
		status: 'signed-in',
		identity: makeIdentity(),
	});
	const { build } = makeBuild();
	const holder = makeHolder<TestApp>();

	using _lifecycle = createSessionLifecycle({
		auth,
		build,
		getPayload: holder.getPayload,
		setPayload: holder.setPayload,
	});

	const initial = holder.getPayload()!;
	auth.setState({ status: 'signed-out' });

	expect(initial.disposed).toBe(true);
	expect(holder.getPayload()).toBeNull();
});

test('cold boot in reauth-required builds the payload from identity', () => {
	const auth = makeAuth({
		status: 'reauth-required',
		identity: makeIdentity(),
	});
	const { build, built } = makeBuild();
	const holder = makeHolder<TestApp>();

	using _lifecycle = createSessionLifecycle({
		auth,
		build,
		getPayload: holder.getPayload,
		setPayload: holder.setPayload,
	});

	const payload = holder.getPayload();
	expect(payload).not.toBeNull();
	expect(built).toHaveLength(1);
	expect(payload).toBe(built[0]!);
});

test('lifecycle disposal disposes the payload and clears the slot', () => {
	const auth = makeAuth({
		status: 'signed-in',
		identity: makeIdentity(),
	});
	const { build } = makeBuild();
	const holder = makeHolder<TestApp>();

	const lifecycle = createSessionLifecycle({
		auth,
		build,
		getPayload: holder.getPayload,
		setPayload: holder.setPayload,
	});

	const initial = holder.getPayload()!;
	lifecycle[Symbol.dispose]();

	expect(initial.disposed).toBe(true);
	expect(holder.getPayload()).toBeNull();
});
