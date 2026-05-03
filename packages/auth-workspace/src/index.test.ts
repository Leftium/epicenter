/**
 * Auth Workspace Scope Tests
 *
 * Verifies the auth binding that sequences one browser client scope through
 * signed-out, signed-in, and terminal reset transitions.
 *
 * Key behaviors:
 * - Cold signed-out and signed-in snapshots call the supplied lifecycle hooks.
 * - Same-user snapshot changes apply fresh session state without reconnecting.
 * - Leaving an applied user marks the client terminal and ignores later snapshots.
 */

import { expect, test } from 'bun:test';
import type { AuthClient, AuthSnapshot, Session } from '@epicenter/auth';
import { bindAuthWorkspaceScope } from './index.ts';

const keysA = [
	{
		version: 1,
		userKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
	},
] satisfies Session['encryptionKeys'];

const keysB = [
	{
		version: 2,
		userKeyBase64: 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=',
	},
] satisfies Session['encryptionKeys'];

function session({
	userId = 'user-1',
	token = 'token-1',
	keys = keysA,
}: {
	userId?: string;
	token?: string;
	keys?: Session['encryptionKeys'];
} = {}): Session {
	return {
		token,
		user: {
			id: userId,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
			email: `${userId}@example.com`,
			emailVerified: true,
			name: userId,
			image: null,
		},
		encryptionKeys: keys,
	};
}

function signedIn(input?: Parameters<typeof session>[0]): AuthSnapshot {
	return { status: 'signedIn', session: session(input) };
}

function createFakeAuth(initial: AuthSnapshot) {
	let snapshot = initial;
	const listeners = new Set<(next: AuthSnapshot) => void>();
	const auth = {
		get snapshot() {
			return snapshot;
		},
		whenLoaded: Promise.resolve(),
		onSnapshotChange(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		signIn: async () => {
			throw new Error('unused');
		},
		signUp: async () => {
			throw new Error('unused');
		},
		signInWithSocialPopup: async () => {
			throw new Error('unused');
		},
		signInWithSocialRedirect: async () => {
			throw new Error('unused');
		},
		signOut: async () => {
			throw new Error('unused');
		},
		fetch: async () => {
			throw new Error('unused');
		},
		[Symbol.dispose]() {
			listeners.clear();
		},
	} satisfies AuthClient;

	return {
		auth,
		emit(next: AuthSnapshot) {
			snapshot = next;
			for (const listener of listeners) listener(next);
		},
	};
}

function setup({
	initial = { status: 'loading' },
	syncControl = true,
	resetLocalClient = async () => {},
}: {
	initial?: AuthSnapshot;
	syncControl?: boolean;
	resetLocalClient?: () => Promise<void>;
} = {}) {
	const fakeAuth = createFakeAuth(initial);
	const calls: string[] = [];
	const appliedSessions: Session[] = [];
	const unsubscribe = bindAuthWorkspaceScope({
		auth: fakeAuth.auth,
		syncControl: syncControl
			? {
					pause() {
						calls.push('pause');
					},
					reconnect() {
						calls.push('reconnect');
					},
				}
			: null,
		applyAuthSession(session) {
			calls.push(`apply:${session.user.id}:${session.token}`);
			appliedSessions.push(session);
		},
		async resetLocalClient() {
			calls.push('reset');
			await resetLocalClient();
		},
	});

	return { fakeAuth, calls, appliedSessions, unsubscribe };
}

async function tick() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

test('cold signedOut pauses sync', async () => {
	const { calls } = setup({ initial: { status: 'signedOut' } });
	await tick();

	expect(calls).toEqual(['pause']);
});

test('cold signedOut with null sync control does not throw', async () => {
	const { calls } = setup({
		initial: { status: 'signedOut' },
		syncControl: false,
	});
	await tick();

	expect(calls).toEqual([]);
});

test('cold signedIn applies session without reconnecting sync', async () => {
	const { calls, appliedSessions } = setup({ initial: signedIn() });
	await tick();

	expect(appliedSessions.map((applied) => applied.encryptionKeys)).toEqual([
		keysA,
	]);
	expect(calls).toEqual(['apply:user-1:token-1']);
});

test('token change applies session without reconnecting sync', async () => {
	const { fakeAuth, calls, appliedSessions } = setup({ initial: signedIn() });
	await tick();
	fakeAuth.emit(signedIn({ token: 'token-2', keys: keysB }));
	await tick();

	expect(appliedSessions.map((applied) => applied.encryptionKeys)).toEqual([
		keysA,
		keysB,
	]);
	expect(calls).toEqual(['apply:user-1:token-1', 'apply:user-1:token-2']);
});

test('key refresh without token change applies session without reconnecting sync', async () => {
	const { fakeAuth, calls, appliedSessions } = setup({ initial: signedIn() });
	await tick();
	fakeAuth.emit(signedIn({ keys: keysB }));
	await tick();

	expect(appliedSessions.map((applied) => applied.encryptionKeys)).toEqual([
		keysA,
		keysB,
	]);
	expect(calls).toEqual(['apply:user-1:token-1', 'apply:user-1:token-1']);
});

test('signedOut after applied user pauses and resets', async () => {
	const { fakeAuth, calls } = setup({ initial: signedIn() });
	await tick();
	fakeAuth.emit({ status: 'signedOut' });
	await tick();

	expect(calls).toEqual(['apply:user-1:token-1', 'pause', 'reset']);
});

test('user switch resets without applying the new user', async () => {
	const { fakeAuth, calls, appliedSessions } = setup({ initial: signedIn() });
	await tick();
	fakeAuth.emit(signedIn({ userId: 'user-2', token: 'token-2', keys: keysB }));
	await tick();

	expect(appliedSessions.map((applied) => applied.user.id)).toEqual(['user-1']);
	expect(calls).toEqual(['apply:user-1:token-1', 'pause', 'reset']);
});

test('resetLocalClient rejection is caught and queued snapshots are ignored', async () => {
	const { fakeAuth, calls, appliedSessions } = setup({
		initial: signedIn(),
		resetLocalClient: async () => {
			throw new Error('reset failed');
		},
	});
	await tick();
	fakeAuth.emit({ status: 'signedOut' });
	fakeAuth.emit(signedIn({ token: 'token-2', keys: keysB }));
	await tick();

	expect(appliedSessions.map((applied) => applied.encryptionKeys)).toEqual([
		keysA,
	]);
	expect(calls).toEqual(['apply:user-1:token-1', 'pause', 'reset']);
});

test('snapshots emitted during reset are ignored', async () => {
	const { promise, resolve } = Promise.withResolvers<void>();
	const { fakeAuth, calls, appliedSessions } = setup({
		initial: signedIn(),
		resetLocalClient: () => promise,
	});
	await tick();
	fakeAuth.emit({ status: 'signedOut' });
	fakeAuth.emit(signedIn({ userId: 'user-2', token: 'token-2', keys: keysB }));
	resolve();
	await tick();

	expect(appliedSessions.map((applied) => applied.user.id)).toEqual(['user-1']);
	expect(calls).toEqual(['apply:user-1:token-1', 'pause', 'reset']);
});

test('unsubscribe stops later auth emissions', async () => {
	const { fakeAuth, calls, unsubscribe } = setup({
		initial: { status: 'signedOut' },
	});
	await tick();
	unsubscribe();
	fakeAuth.emit(signedIn());
	await tick();

	expect(calls).toEqual(['pause']);
});
