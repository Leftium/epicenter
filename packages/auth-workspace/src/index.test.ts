/**
 * Workspace Auth Lifecycle Binding Tests
 *
 * Verifies the framework-agnostic binding between auth snapshots and workspace
 * lifecycle effects.
 *
 * Key behaviors:
 * - Bootstrap reads the current auth snapshot without listener replay
 * - Leaving an applied user clears local persistence
 * - Token, key, and user changes apply distinct workspace side effects
 * - Duplicate sync targets are deduped before lifecycle calls
 */

import { expect, test } from 'bun:test';
import type { AuthClient, AuthSnapshot, Session } from '@epicenter/auth';
import {
	bindWorkspaceAuthLifecycle,
	type WorkspaceAuthSyncTarget,
	type WorkspaceAuthTarget,
} from './index.ts';

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

function createSyncTarget(name: string) {
	const calls: string[] = [];
	return {
		target: {
			goOffline() {
				calls.push(`${name}:offline`);
			},
			reconnect() {
				calls.push(`${name}:reconnect`);
			},
		} satisfies WorkspaceAuthSyncTarget,
		calls,
	};
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

function createFakeWorkspace({
	childTargets = [],
	clearLocal = async () => {},
}: {
	childTargets?: WorkspaceAuthSyncTarget[];
	clearLocal?: () => Promise<unknown>;
} = {}) {
	const primary = createSyncTarget('primary');
	const appliedKeys: Array<Session['encryptionKeys']> = [];
	const workspace = {
		sync: primary.target,
		idb: {
			clearLocal,
		},
		encryption: {
			applyKeys(keys) {
				appliedKeys.push(keys);
			},
		},
		getAuthSyncTargets() {
			return childTargets;
		},
	} satisfies WorkspaceAuthTarget;

	return {
		workspace,
		primaryCalls: primary.calls,
		appliedKeys,
	};
}

async function tick() {
	await Promise.resolve();
	await Promise.resolve();
}

test('loading bootstrap has no side effects', () => {
	const { auth } = createFakeAuth({ status: 'loading' });
	const { workspace, primaryCalls, appliedKeys } = createFakeWorkspace();
	let cleanupErrors = 0;
	let afterCleanup = 0;
	let signedInSnapshots = 0;

	bindWorkspaceAuthLifecycle({
		auth,
		workspace,
		leavingUser: {
			onCleanupError: () => cleanupErrors++,
			afterCleanup: () => afterCleanup++,
		},
		signedIn: {
			onSnapshot: () => signedInSnapshots++,
		},
	});

	expect(primaryCalls).toEqual([]);
	expect(appliedKeys).toEqual([]);
	expect(cleanupErrors).toBe(0);
	expect(afterCleanup).toBe(0);
	expect(signedInSnapshots).toBe(0);
});

test('cold signed-out boot takes sync offline without clearing local persistence', () => {
	const { auth } = createFakeAuth({ status: 'signedOut' });
	let clearLocalCalls = 0;
	const { workspace, primaryCalls } = createFakeWorkspace({
		clearLocal: async () => {
			clearLocalCalls++;
		},
	});
	let cleanupErrors = 0;
	let afterCleanup = 0;

	bindWorkspaceAuthLifecycle({
		auth,
		workspace,
		leavingUser: {
			onCleanupError: () => cleanupErrors++,
			afterCleanup: () => afterCleanup++,
		},
	});

	expect(primaryCalls).toEqual(['primary:offline']);
	expect(clearLocalCalls).toBe(0);
	expect(cleanupErrors).toBe(0);
	expect(afterCleanup).toBe(0);
});

test('cold signed-in boot applies keys, reconnects sync, and runs signed-in policy', () => {
	const { auth } = createFakeAuth(signedIn());
	const { workspace, primaryCalls, appliedKeys } = createFakeWorkspace();
	let signedInSnapshots = 0;

	bindWorkspaceAuthLifecycle({
		auth,
		workspace,
		leavingUser: {
			onCleanupError: () => {},
		},
		signedIn: {
			onSnapshot: () => signedInSnapshots++,
		},
	});

	expect(appliedKeys).toEqual([keysA]);
	expect(primaryCalls).toEqual(['primary:reconnect']);
	expect(signedInSnapshots).toBe(1);
});

test('signed-in to signed-out clears local persistence before after-cleanup policy', async () => {
	const fakeAuth = createFakeAuth(signedIn());
	const events: string[] = [];
	const { workspace, primaryCalls } = createFakeWorkspace({
		clearLocal: async () => {
			events.push('clear');
		},
	});

	bindWorkspaceAuthLifecycle({
		auth: fakeAuth.auth,
		workspace,
		leavingUser: {
			onCleanupError: () => events.push('error'),
			afterCleanup: () => events.push('after'),
		},
	});

	fakeAuth.emit({ status: 'signedOut' });
	await tick();

	expect(primaryCalls).toEqual(['primary:reconnect', 'primary:offline']);
	expect(events).toEqual(['clear', 'after']);
});

test('cleanup failure reports error and skips after-cleanup policy', async () => {
	const cleanupError = new Error('clear failed');
	const fakeAuth = createFakeAuth(signedIn());
	const errors: unknown[] = [];
	let afterCleanup = 0;
	const { workspace } = createFakeWorkspace({
		clearLocal: async () => {
			throw cleanupError;
		},
	});

	bindWorkspaceAuthLifecycle({
		auth: fakeAuth.auth,
		workspace,
		leavingUser: {
			onCleanupError: (error) => errors.push(error),
			afterCleanup: () => afterCleanup++,
		},
	});

	fakeAuth.emit({ status: 'signedOut' });
	await tick();

	expect(errors).toEqual([cleanupError]);
	expect(afterCleanup).toBe(0);
});

test('token refresh for same user applies keys, reconnects sync, and runs signed-in policy', () => {
	const fakeAuth = createFakeAuth(signedIn());
	const { workspace, primaryCalls, appliedKeys } = createFakeWorkspace();
	let signedInSnapshots = 0;

	bindWorkspaceAuthLifecycle({
		auth: fakeAuth.auth,
		workspace,
		leavingUser: {
			onCleanupError: () => {},
		},
		signedIn: {
			onSnapshot: () => signedInSnapshots++,
		},
	});

	fakeAuth.emit(signedIn({ token: 'token-2', keys: keysB }));

	expect(appliedKeys).toEqual([keysA, keysB]);
	expect(primaryCalls).toEqual(['primary:reconnect', 'primary:reconnect']);
	expect(signedInSnapshots).toBe(2);
});

test('key refresh without token change applies keys without reconnecting sync', () => {
	const fakeAuth = createFakeAuth(signedIn());
	const { workspace, primaryCalls, appliedKeys } = createFakeWorkspace();
	let signedInSnapshots = 0;

	bindWorkspaceAuthLifecycle({
		auth: fakeAuth.auth,
		workspace,
		leavingUser: {
			onCleanupError: () => {},
		},
		signedIn: {
			onSnapshot: () => signedInSnapshots++,
		},
	});

	fakeAuth.emit(signedIn({ keys: keysB }));

	expect(appliedKeys).toEqual([keysA, keysB]);
	expect(primaryCalls).toEqual(['primary:reconnect']);
	expect(signedInSnapshots).toBe(2);
});

test('user switch clears local persistence before applying the new user', async () => {
	const fakeAuth = createFakeAuth(signedIn({ userId: 'user-1' }));
	const events: string[] = [];
	const { workspace, primaryCalls, appliedKeys } = createFakeWorkspace({
		clearLocal: async () => {
			events.push('clear');
		},
	});
	let signedInSnapshots = 0;

	bindWorkspaceAuthLifecycle({
		auth: fakeAuth.auth,
		workspace,
		leavingUser: {
			onCleanupError: () => events.push('error'),
			afterCleanup: () => events.push('after'),
		},
		signedIn: {
			onSnapshot: () => {
				events.push('signed-in');
				signedInSnapshots++;
			},
		},
	});

	fakeAuth.emit(signedIn({ userId: 'user-2', token: 'token-2', keys: keysB }));
	await tick();

	expect(primaryCalls).toEqual([
		'primary:reconnect',
		'primary:offline',
		'primary:reconnect',
	]);
	expect(appliedKeys).toEqual([keysA, keysB]);
	expect(events).toEqual(['signed-in', 'clear', 'signed-in', 'after']);
	expect(signedInSnapshots).toBe(2);
});

test('duplicate sync targets are deduped before lifecycle calls', () => {
	const child = createSyncTarget('child');
	const { auth } = createFakeAuth(signedIn());
	const { workspace, primaryCalls } = createFakeWorkspace();
	workspace.getAuthSyncTargets = () => [
		workspace.sync,
		child.target,
		child.target,
	];

	bindWorkspaceAuthLifecycle({
		auth,
		workspace,
		leavingUser: {
			onCleanupError: () => {},
		},
	});

	expect(primaryCalls).toEqual(['primary:reconnect']);
	expect(child.calls).toEqual(['child:reconnect']);
});

test('unsubscribe stops later auth emissions', () => {
	const fakeAuth = createFakeAuth({ status: 'signedOut' });
	const { workspace, primaryCalls } = createFakeWorkspace();

	const unsubscribe = bindWorkspaceAuthLifecycle({
		auth: fakeAuth.auth,
		workspace,
		leavingUser: {
			onCleanupError: () => {},
		},
	});
	unsubscribe();

	fakeAuth.emit(signedIn());

	expect(primaryCalls).toEqual(['primary:offline']);
});
