/**
 * Auth Workspace Scope Tests
 *
 * Verifies the auth binding that sequences one browser client scope through
 * signed-out, signed-in, and terminal reset transitions.
 *
 * Key behaviors:
 * - Cold signed-out and signed-in identities call the supplied lifecycle hooks.
 * - Same-user identity changes apply fresh key state without reconnecting.
 * - Leaving an applied user puts the client into a resetting state and ignores later identities.
 */

import { expect, test } from 'bun:test';
import type { AuthClient, AuthIdentity, BearerSession } from '@epicenter/auth';
import { bindAuthWorkspaceScope } from './index.ts';

const keysA = [
	{
		version: 1,
		userKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
	},
] satisfies BearerSession['encryptionKeys'];

const keysB = [
	{
		version: 2,
		userKeyBase64: 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=',
	},
] satisfies BearerSession['encryptionKeys'];

function session({
	userId = 'user-1',
	token = 'token-1',
	keys = keysA,
}: {
	userId?: string;
	token?: string;
	keys?: BearerSession['encryptionKeys'];
} = {}): BearerSession {
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

function identity(input?: Parameters<typeof session>[0]): AuthIdentity {
	const { user, encryptionKeys } = session(input);
	return { user, encryptionKeys };
}

function createFakeAuth(initial: AuthIdentity | null) {
	let currentIdentity = initial;
	const listeners = new Set<(next: AuthIdentity | null) => void>();
	const auth = {
		get identity() {
			return currentIdentity;
		},
		whenReady: Promise.resolve(),
		onChange(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		signIn: async () => {
			throw new Error('unused');
		},
		signUp: async () => {
			throw new Error('unused');
		},
		signInWithIdToken: async () => {
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
		openWebSocket: () => {
			throw new Error('unused');
		},
		[Symbol.dispose]() {
			listeners.clear();
		},
	} satisfies AuthClient;

	return {
		auth,
		emit(next: AuthIdentity | null) {
			currentIdentity = next;
			for (const listener of listeners) listener(next);
		},
	};
}

function setup({
	initial = null,
	resetLocalClient = async () => {},
}: {
	initial?: AuthIdentity | null;
	resetLocalClient?: () => Promise<void>;
} = {}) {
	const fakeAuth = createFakeAuth(initial);
	const calls: string[] = [];
	const appliedIdentities: AuthIdentity[] = [];
	const unsubscribe = bindAuthWorkspaceScope({
		auth: fakeAuth.auth,
		applyAuthIdentity(identity) {
			calls.push(`apply:${identity.user.id}`);
			appliedIdentities.push(identity);
		},
		async resetLocalClient() {
			calls.push('reset');
			await resetLocalClient();
		},
	});

	return { fakeAuth, calls, appliedIdentities, unsubscribe };
}

async function tick() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

test('cold signedOut is a no-op', async () => {
	const { calls } = setup({ initial: null });
	await tick();

	expect(calls).toEqual([]);
});

test('cold signedIn applies session without reconnecting sync', async () => {
	const { calls, appliedIdentities } = setup({ initial: identity() });
	await tick();

	expect(appliedIdentities.map((applied) => applied.encryptionKeys)).toEqual([
		keysA,
	]);
	expect(calls).toEqual(['apply:user-1']);
});

test('key refresh applies identity without reconnecting sync', async () => {
	const { fakeAuth, calls, appliedIdentities } = setup({ initial: identity() });
	await tick();
	fakeAuth.emit(identity({ keys: keysB }));
	await tick();

	expect(appliedIdentities.map((applied) => applied.encryptionKeys)).toEqual([
		keysA,
		keysB,
	]);
	expect(calls).toEqual(['apply:user-1', 'apply:user-1']);
});

test('signedOut after applied user resets', async () => {
	const { fakeAuth, calls } = setup({ initial: identity() });
	await tick();
	fakeAuth.emit(null);
	await tick();

	expect(calls).toEqual(['apply:user-1', 'reset']);
});

test('user switch resets without applying the new user', async () => {
	const { fakeAuth, calls, appliedIdentities } = setup({ initial: identity() });
	await tick();
	fakeAuth.emit(identity({ userId: 'user-2', token: 'token-2', keys: keysB }));
	await tick();

	expect(appliedIdentities.map((applied) => applied.user.id)).toEqual([
		'user-1',
	]);
	expect(calls).toEqual(['apply:user-1', 'reset']);
});

test('resetLocalClient rejection is caught and queued identities are ignored', async () => {
	const { fakeAuth, calls, appliedIdentities } = setup({
		initial: identity(),
		resetLocalClient: async () => {
			throw new Error('reset failed');
		},
	});
	await tick();
	fakeAuth.emit(null);
	fakeAuth.emit(identity({ token: 'token-2', keys: keysB }));
	await tick();

	expect(appliedIdentities.map((applied) => applied.encryptionKeys)).toEqual([
		keysA,
	]);
	expect(calls).toEqual(['apply:user-1', 'reset']);
});

test('identities emitted during reset are ignored', async () => {
	const { promise, resolve } = Promise.withResolvers<void>();
	const { fakeAuth, calls, appliedIdentities } = setup({
		initial: identity(),
		resetLocalClient: () => promise,
	});
	await tick();
	fakeAuth.emit(null);
	fakeAuth.emit(identity({ userId: 'user-2', token: 'token-2', keys: keysB }));
	resolve();
	await tick();

	expect(appliedIdentities.map((applied) => applied.user.id)).toEqual([
		'user-1',
	]);
	expect(calls).toEqual(['apply:user-1', 'reset']);
});

test('unsubscribe stops later auth emissions', async () => {
	const { fakeAuth, calls, unsubscribe } = setup({
		initial: null,
	});
	await tick();
	unsubscribe();
	fakeAuth.emit(identity());
	await tick();

	expect(calls).toEqual([]);
});
