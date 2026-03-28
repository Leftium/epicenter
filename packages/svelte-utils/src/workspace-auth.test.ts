import { describe, expect, test } from 'bun:test';
import type { AuthSession } from './auth-types.js';
import type {
	AuthClient,
	AuthRefreshResult,
	WorkspaceKeyResponse,
} from './create-auth.svelte.js';
import { createWorkspaceAuth } from './workspace-auth.svelte.js';

describe('createWorkspaceAuth.refresh', () => {
	test('adopts plaintext local data and unlocks with the fetched key', async () => {
		const workspace = createFakeWorkspace({ bootFromCacheResult: 'plaintext' });
		const auth = createFakeAuth({
			refreshResult: {
				session: authenticatedSession(),
				keyVersion: 1,
			},
			fetchWorkspaceKey: createFakeFetchWorkspaceKey(),
		});
		let reconnectCalls = 0;
		const workspaceAuth = createWorkspaceAuth({
			workspace,
			auth,
			reconnect: () => {
				reconnectCalls += 1;
			},
		});

		await workspaceAuth.refresh();

		expect(workspace.unlockWithKeyCalls).toEqual(['AQIDBA==']);
		expect(reconnectCalls).toBe(1);
	});

	test('reconnects when refresh downgrades an authenticated session to anonymous', async () => {
		const workspace = createFakeWorkspace({ bootFromCacheResult: 'unlocked' });
		const auth = createFakeAuth({
			initialSession: authenticatedSession(),
			refreshResult: { session: { status: 'anonymous' } },
		});
		let reconnectCalls = 0;
		const workspaceAuth = createWorkspaceAuth({
			workspace,
			auth,
			reconnect: () => {
				reconnectCalls += 1;
			},
		});

		await workspaceAuth.refresh();

		expect(reconnectCalls).toBe(1);
	});

	test('skips key fetch when keyVersion matches the last unlocked version', async () => {
		const workspace = createFakeWorkspace({ bootFromCacheResult: 'plaintext' });
		let fetchCalls = 0;
		const auth = createFakeAuth({
			refreshResult: {
				session: authenticatedSession(),
				keyVersion: 1,
			},
			fetchWorkspaceKey: async () => {
				fetchCalls += 1;
				return { userKeyBase64: 'AQIDBA==', keyVersion: 1 };
			},
		});
		const workspaceAuth = createWorkspaceAuth({
			workspace,
			auth,
		});

		// First refresh — version is new, should fetch key
		await workspaceAuth.refresh();
		expect(fetchCalls).toBe(1);
		expect(workspace.unlockWithKeyCalls).toEqual(['AQIDBA==']);

		// Second refresh — same version, should skip fetch
		await workspaceAuth.refresh();
		expect(fetchCalls).toBe(1);
		expect(workspace.unlockWithKeyCalls).toEqual(['AQIDBA==']);
	});

});

describe('createWorkspaceAuth.signIn', () => {
	test('returns auth failures without changing workspace state', async () => {
		const workspace = createFakeWorkspace({ bootFromCacheResult: 'plaintext' });
		const auth = createFakeAuth({
			signInResult: {
				session: { status: 'anonymous' },
				error: { message: 'boom' } as never,
			},
		});
		let reconnectCalls = 0;
		const workspaceAuth = createWorkspaceAuth({
			workspace,
			auth,
			reconnect: () => {
				reconnectCalls += 1;
			},
		});

		const result = await workspaceAuth.signIn({
			email: 'braden@example.com',
			password: 'secret',
		});

		if (!('error' in result)) {
			throw new Error('Expected sign-in failure result');
		}

		expect(result.session).toEqual({ status: 'anonymous' });
		expect(result.error.message).toBe('boom');
		expect(auth.signInCalls).toBe(1);
		expect(workspace.unlockWithKeyCalls).toEqual([]);
		expect(reconnectCalls).toBe(0);
	});
});

describe('createWorkspaceAuth.signInWithGoogle', () => {
	test('adopts workspace key from a completed Google sign-in', async () => {
		const workspace = createFakeWorkspace({ bootFromCacheResult: 'plaintext' });
		const auth = createFakeAuth({
			signInWithGoogleResult: {
				session: authenticatedSession(),
				keyVersion: 1,
			},
			fetchWorkspaceKey: createFakeFetchWorkspaceKey(),
		});
		let reconnectCalls = 0;
		const workspaceAuth = createWorkspaceAuth({
			workspace,
			auth,
			reconnect: () => {
				reconnectCalls += 1;
			},
		});

		const result = await workspaceAuth.signInWithGoogle();

		expect(result).toEqual({
			session: authenticatedSession(),
			keyVersion: 1,
		});
		expect(auth.signInWithGoogleCalls).toBe(1);
		expect(workspace.unlockWithKeyCalls).toEqual(['AQIDBA==']);
		expect(reconnectCalls).toBe(1);
	});
});

describe('createWorkspaceAuth.signOut', () => {
	test('sign-out performs a full local wipe and reconnects sync', async () => {
		const workspace = createFakeWorkspace({ bootFromCacheResult: 'unlocked' });
		const auth = createFakeAuth();
		let reconnectCalls = 0;
		const workspaceAuth = createWorkspaceAuth({
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
	signInResult = { session: initialSession },
	signUpResult = { session: initialSession },
	signInWithGoogleResult = { session: initialSession },
	fetchWorkspaceKey = createFakeFetchWorkspaceKey(),
}: {
	initialSession?: AuthSession;
	refreshResult?: AuthRefreshResult;
	signInResult?: Awaited<ReturnType<AuthClient['signIn']>>;
	signUpResult?: Awaited<ReturnType<AuthClient['signUp']>>;
	signInWithGoogleResult?: Awaited<ReturnType<AuthClient['signInWithGoogle']>>;
	fetchWorkspaceKey?: () => Promise<WorkspaceKeyResponse>;
} = {}): AuthClient & {
	signInCalls: number;
	signUpCalls: number;
	signInWithGoogleCalls: number;
	signOutCalls: number;
} {
	let session = initialSession;
	let signInCalls = 0;
	let signUpCalls = 0;
	let signInWithGoogleCalls = 0;
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
			signInCalls += 1;
			if ('session' in signInResult) session = signInResult.session;
			return signInResult;
		},
		async signUp() {
			signUpCalls += 1;
			if ('session' in signUpResult) session = signUpResult.session;
			return signUpResult;
		},
		async signInWithGoogle() {
			signInWithGoogleCalls += 1;
			if ('session' in signInWithGoogleResult) {
				session = signInWithGoogleResult.session;
			}
			return signInWithGoogleResult;
		},
		async signOut() {
			signOutCalls += 1;
			session = { status: 'anonymous' };
		},
		async fetchWorkspaceKey() {
			return await fetchWorkspaceKey();
		},
		fetch: fetch,
		get signInCalls() {
			return signInCalls;
		},
		get signUpCalls() {
			return signUpCalls;
		},
		get signInWithGoogleCalls() {
			return signInWithGoogleCalls;
		},
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

function createFakeFetchWorkspaceKey(
	response: WorkspaceKeyResponse = { userKeyBase64: 'AQIDBA==', keyVersion: 1 },
): () => Promise<WorkspaceKeyResponse> {
	return async () => response;
}
