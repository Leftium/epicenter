import { describe, expect, test } from 'bun:test';
import type {
	AuthClient,
	AuthRefreshResult,
	GoogleAuthCommandResult,
} from './auth-session.svelte.js';
import type { AuthSession } from './auth-types.js';
import { createWorkspaceAuthBoundary } from './workspace-first-boot.svelte.js';

describe('createWorkspaceAuthBoundary.startAppBoot', () => {
	test('boots into unlocked mode from the cached key without waiting on auth', async () => {
		const workspace = createFakeWorkspace({ bootFromCacheResult: 'unlocked' });
		const auth = createFakeAuth();
		const workspaceAuth = createWorkspaceAuthBoundary({ workspace, auth });

		await workspaceAuth.startAppBoot();

		expect(workspace.bootFromCacheCalls).toBe(1);
		expect(workspace.unlockWithKeyCalls).toEqual([]);
	});

	test('refresh adopts plaintext local data and unlocks with the fetched key', async () => {
		const workspace = createFakeWorkspace({ bootFromCacheResult: 'plaintext' });
		const auth = createFakeAuth({
			refreshResult: {
				session: authenticatedSession(),
				workspaceKeyBase64: 'AQIDBA==',
			},
		});
		let reconnectCalls = 0;
		const workspaceAuth = createWorkspaceAuthBoundary({
			workspace,
			auth,
			reconnect: () => {
				reconnectCalls += 1;
			},
		});

		await workspaceAuth.startAppBoot();

		expect(workspace.unlockWithKeyCalls).toEqual(['AQIDBA==']);
		expect(reconnectCalls).toBe(1);
	});

	test('refresh to anonymous reconnects when boot started from a persisted authenticated session', async () => {
		const workspace = createFakeWorkspace({ bootFromCacheResult: 'unlocked' });
		const auth = createFakeAuth({
			initialSession: authenticatedSession(),
			refreshResult: { session: { status: 'anonymous' } },
		});
		let reconnectCalls = 0;
		const workspaceAuth = createWorkspaceAuthBoundary({
			workspace,
			auth,
			reconnect: () => {
				reconnectCalls += 1;
			},
		});

		await workspaceAuth.startAppBoot();

		expect(reconnectCalls).toBe(1);
	});
});

describe('createWorkspaceAuthBoundary.applyAuthResult', () => {
	test('ignores failed command results and redirect starts', async () => {
		const workspace = createFakeWorkspace({ bootFromCacheResult: 'plaintext' });
		let reconnectCalls = 0;
		const workspaceAuth = createWorkspaceAuthBoundary({
			workspace,
			auth: createFakeAuth(),
			reconnect: () => {
				reconnectCalls += 1;
			},
		});

		await workspaceAuth.applyAuthResult({
			session: { status: 'anonymous' },
			error: { message: 'boom' } as never,
		});
		await workspaceAuth.applyAuthResult({ status: 'redirect-started' });

		expect(workspace.unlockWithKeyCalls).toEqual([]);
		expect(reconnectCalls).toBe(0);
	});
});

describe('createWorkspaceAuthBoundary.refresh', () => {
	test('reconnects when refresh downgrades an authenticated session to anonymous', async () => {
		const workspace = createFakeWorkspace({ bootFromCacheResult: 'unlocked' });
		const auth = createFakeAuth({
			initialSession: authenticatedSession(),
			refreshResult: { session: { status: 'anonymous' } },
		});
		let reconnectCalls = 0;
		const workspaceAuth = createWorkspaceAuthBoundary({
			workspace,
			auth,
			reconnect: () => {
				reconnectCalls += 1;
			},
		});

		await workspaceAuth.refresh();

		expect(reconnectCalls).toBe(1);
	});
});

describe('createWorkspaceAuthBoundary.signOut', () => {
	test('sign-out performs a full local wipe and reconnects sync', async () => {
		const workspace = createFakeWorkspace({ bootFromCacheResult: 'unlocked' });
		const auth = createFakeAuth();
		let reconnectCalls = 0;
		const workspaceAuth = createWorkspaceAuthBoundary({
			workspace,
			auth,
			reconnect: () => {
				reconnectCalls += 1;
			},
		});

		await workspaceAuth.signOut();

		expect(auth.signOutCalls).toBe(1);
		expect(workspace.clearLocalDataCalls).toBe(1);
		expect(reconnectCalls).toBe(1);
	});
});

function createFakeAuth({
	initialSession = { status: 'anonymous' } as AuthSession,
	refreshResult = { session: initialSession } as AuthRefreshResult,
}: {
	initialSession?: AuthSession;
	refreshResult?: AuthRefreshResult;
} = {}): AuthClient & {
	signOutCalls: number;
} {
	let session = initialSession;
	let signOutCalls = 0;

	return {
		get session() {
			return session;
		},
		get operation() {
			return { status: 'idle' } as const;
		},
		get isRefreshing() {
			return false;
		},
		async refresh() {
			session = refreshResult.session;
			return refreshResult;
		},
		async signIn() {
			throw new Error('not implemented');
		},
		async signUp() {
			throw new Error('not implemented');
		},
		async signInWithGoogle(): Promise<GoogleAuthCommandResult> {
			throw new Error('not implemented');
		},
		async signOut() {
			signOutCalls += 1;
			session = { status: 'anonymous' };
		},
		fetch: fetch,
		get signOutCalls() {
			return signOutCalls;
		},
	};
}

function createFakeWorkspace({
	bootFromCacheResult,
}: {
	bootFromCacheResult: 'plaintext' | 'unlocked';
}) {
	const unlockWithKeyCalls: string[] = [];
	let clearLocalDataCalls = 0;
	let bootFromCacheCalls = 0;

	return {
		async bootFromCache() {
			bootFromCacheCalls += 1;
			return bootFromCacheResult;
		},
		async unlockWithKey(userKeyBase64: string) {
			unlockWithKeyCalls.push(userKeyBase64);
		},
		async clearLocalData() {
			clearLocalDataCalls += 1;
		},
		get unlockWithKeyCalls() {
			return unlockWithKeyCalls;
		},
		get clearLocalDataCalls() {
			return clearLocalDataCalls;
		},
		get bootFromCacheCalls() {
			return bootFromCacheCalls;
		},
	} as const;
}

function authenticatedSession(): Extract<AuthSession, { status: 'authenticated' }> {
	return {
		status: 'authenticated',
		token: 'token-1',
		user: {
			id: 'user-1',
			createdAt: '2026-03-27T00:00:00.000Z',
			updatedAt: '2026-03-27T00:00:00.000Z',
			email: 'braden@example.com',
			emailVerified: true,
			name: 'Braden',
			image: null,
		},
	};
}
