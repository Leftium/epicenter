/**
 * Tests for the pure session lifecycle. Asserts the invariants that the
 * Svelte-facing `createSession` wrapper depends on:
 *
 *   - signed-in → reauth-required → signed-in preserves the same
 *     `SessionPayload` instance (object identity).
 *   - signed-in (user A) → signed-in (user B) disposes and triggers the
 *     different-user escape hatch.
 *   - signed-out disposes and clears the payload.
 */

import { expect, mock, test } from 'bun:test';
import type { AuthClient, AuthState, WorkspaceIdentity } from '@epicenter/auth';
import type { AppBase, SessionPayload } from './session.svelte.js';
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

type TestApp = AppBase & {
	id: number;
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

function makeHolder<T extends AppBase>() {
	let payload: SessionPayload<T> | null = null;
	return {
		getPayload: () => payload,
		setPayload: (next: SessionPayload<T> | null) => {
			payload = next;
		},
	};
}

test('signed-in → reauth-required → signed-in preserves the same SessionPayload', () => {
	const auth = makeAuth({
		status: 'signed-in',
		identity: makeIdentity(),
	});
	const { build, built } = makeBuild();
	const holder = makeHolder<TestApp>();
	const onDifferentUser = mock(() => {});

	using _lifecycle = createSessionLifecycle({
		auth,
		build,
		getPayload: holder.getPayload,
		setPayload: holder.setPayload,
		onDifferentUser,
	});

	const initial = holder.getPayload();
	expect(initial).not.toBeNull();
	expect(built).toHaveLength(1);
	expect(initial!.app).toBe(built[0]!);
	expect(initial!.app.disposed).toBe(false);

	auth.setState({ status: 'reauth-required', identity: makeIdentity() });
	expect(holder.getPayload()).toBe(initial);
	expect(built).toHaveLength(1);
	expect(initial!.app.disposed).toBe(false);

	auth.setState({ status: 'signed-in', identity: makeIdentity() });
	expect(holder.getPayload()).toBe(initial);
	expect(built).toHaveLength(1);
	expect(initial!.app.disposed).toBe(false);
	expect(onDifferentUser).not.toHaveBeenCalled();
});

test('signed-in (user A) → signed-in (user B) disposes and triggers different-user escape', () => {
	const auth = makeAuth({
		status: 'signed-in',
		identity: makeIdentity({ userId: 'user-A' }),
	});
	const { build, built } = makeBuild();
	const holder = makeHolder<TestApp>();
	const onDifferentUser = mock(() => {});

	using _lifecycle = createSessionLifecycle({
		auth,
		build,
		getPayload: holder.getPayload,
		setPayload: holder.setPayload,
		onDifferentUser,
	});

	const initial = holder.getPayload()!;
	expect(initial.app.userId).toBe('user-A');

	auth.setState({
		status: 'signed-in',
		identity: makeIdentity({ userId: 'user-B' }),
	});

	expect(initial.app.disposed).toBe(true);
	expect(holder.getPayload()).toBeNull();
	expect(onDifferentUser).toHaveBeenCalledTimes(1);
});

test('signed-out disposes the app and clears the payload', () => {
	const auth = makeAuth({
		status: 'signed-in',
		identity: makeIdentity(),
	});
	const { build, built } = makeBuild();
	const holder = makeHolder<TestApp>();
	const onDifferentUser = mock(() => {});

	using _lifecycle = createSessionLifecycle({
		auth,
		build,
		getPayload: holder.getPayload,
		setPayload: holder.setPayload,
		onDifferentUser,
	});

	const initial = holder.getPayload()!;
	auth.setState({ status: 'signed-out' });

	expect(initial.app.disposed).toBe(true);
	expect(holder.getPayload()).toBeNull();
	expect(onDifferentUser).not.toHaveBeenCalled();
});

test('cold boot in reauth-required builds the app from identity', () => {
	const auth = makeAuth({
		status: 'reauth-required',
		identity: makeIdentity(),
	});
	const { build, built } = makeBuild();
	const holder = makeHolder<TestApp>();
	const onDifferentUser = mock(() => {});

	using _lifecycle = createSessionLifecycle({
		auth,
		build,
		getPayload: holder.getPayload,
		setPayload: holder.setPayload,
		onDifferentUser,
	});

	const payload = holder.getPayload();
	expect(payload).not.toBeNull();
	expect(built).toHaveLength(1);
	expect(payload!.app).toBe(built[0]!);
});

test('lifecycle disposal clears the payload after disposing the app', () => {
	const auth = makeAuth({
		status: 'signed-in',
		identity: makeIdentity(),
	});
	const { build } = makeBuild();
	const holder = makeHolder<TestApp>();
	const onDifferentUser = mock(() => {});

	const lifecycle = createSessionLifecycle({
		auth,
		build,
		getPayload: holder.getPayload,
		setPayload: holder.setPayload,
		onDifferentUser,
	});

	const initial = holder.getPayload()!;
	lifecycle[Symbol.dispose]();

	expect(initial.app.disposed).toBe(true);
	expect(holder.getPayload()).toBeNull();
});
