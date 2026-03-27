import { describe, expect, test } from 'bun:test';
import { bytesToBase64 } from '@epicenter/workspace/shared/crypto';
import type {
	AuthSessionCommit,
	AuthSessionStore,
} from './auth-session.svelte.js';
import type { AuthSession } from './auth-types.js';
import { installWorkspaceFirstBoot } from './workspace-first-boot.svelte.js';

type FakeAuth = AuthSessionStore & {
	emit(commit: AuthSessionCommit): Promise<void>;
};

describe('installWorkspaceFirstBoot', () => {
	test('boots into unlocked mode from the cached key without waiting on auth', async () => {
		const workspace = createFakeWorkspace({ tryUnlockResult: true });
		const auth = createFakeAuth();
		const cleanup = installWorkspaceFirstBoot({ workspace, auth });

		await Promise.resolve();
		await Promise.resolve();

		expect(workspace.tryUnlockCalls).toBe(1);
		expect(workspace.isUnlocked).toBe(true);
		cleanup();
	});

	test('login adopts plaintext local data and unlocks with the fetched key', async () => {
		const workspace = createFakeWorkspace({ tryUnlockResult: false });
		const auth = createFakeAuth();
		const cleanup = installWorkspaceFirstBoot({ workspace, auth });
		const userKey = new Uint8Array([1, 2, 3, 4]);

		await Promise.resolve();
		await Promise.resolve();
		await auth.emit({
			previous: { status: 'anonymous' },
			current: {
				status: 'authenticated',
				token: 'token-1',
				user: createUser(),
			},
			reason: 'sign-in',
			userKeyBase64: bytesToBase64(userKey),
		});

		expect(workspace.clearLocalDataCalls).toBe(0);
		expect(workspace.unlockCalls).toEqual([[1, 2, 3, 4]]);
		expect(workspace.isUnlocked).toBe(true);
		cleanup();
	});

	test('sign-out performs a full local wipe and returns to plaintext mode', async () => {
		const workspace = createFakeWorkspace({ tryUnlockResult: true });
		const auth = createFakeAuth({
			initialSession: {
				status: 'authenticated',
				token: 'token-1',
				user: createUser(),
			},
		});
		const cleanup = installWorkspaceFirstBoot({ workspace, auth });

		await Promise.resolve();
		await Promise.resolve();
		await auth.emit({
			previous: {
				status: 'authenticated',
				token: 'token-1',
				user: createUser(),
			},
			current: { status: 'anonymous' },
			reason: 'sign-out',
		});

		expect(workspace.clearLocalDataCalls).toBe(1);
		expect(workspace.isUnlocked).toBe(false);
		cleanup();
	});

	test('cleanup unsubscribes from later auth commits', async () => {
		const workspace = createFakeWorkspace({ tryUnlockResult: false });
		const auth = createFakeAuth();
		const cleanup = installWorkspaceFirstBoot({ workspace, auth });

		cleanup();
		await auth.emit({
			previous: { status: 'anonymous' },
			current: {
				status: 'authenticated',
				token: 'token-1',
				user: createUser(),
			},
			reason: 'sign-in',
			userKeyBase64: bytesToBase64(new Uint8Array([9, 9, 9, 9])),
		});

		expect(workspace.unlockCalls).toEqual([]);
	});
});

function createFakeAuth({
	initialSession = { status: 'anonymous' } as AuthSession,
}: {
	initialSession?: AuthSession;
} = {}): FakeAuth {
	let session = initialSession;
	const commitListeners = new Set<
		(commit: AuthSessionCommit) => void | Promise<void>
	>();

	return {
		get whenReady() {
			return Promise.resolve();
		},
		get session() {
			return session;
		},
		get operation() {
			return { status: 'idle' } as const;
		},
		get isAuthenticated() {
			return session.status === 'authenticated';
		},
		get user() {
			return session.status === 'authenticated' ? session.user : null;
		},
		get token() {
			return session.status === 'authenticated' ? session.token : null;
		},
		async refresh() {},
		async signIn() {
			throw new Error('not implemented');
		},
		async signUp() {
			throw new Error('not implemented');
		},
		async signInWithGoogle() {
			throw new Error('not implemented');
		},
		async signOut() {
			throw new Error('not implemented');
		},
		onSessionChange() {
			return () => {};
		},
		onSessionCommit(listener) {
			commitListeners.add(listener);
			return () => {
				commitListeners.delete(listener);
			};
		},
		onTokenChange() {
			return () => {};
		},
		fetch: fetch,
		async emit(commit) {
			session = commit.current;
			for (const listener of commitListeners) {
				await listener(commit);
			}
		},
	};
}

function createFakeWorkspace({
	tryUnlockResult,
}: {
	tryUnlockResult: boolean;
}) {
	let isUnlocked = false;
	const unlockCalls: number[][] = [];
	let clearLocalDataCalls = 0;
	let tryUnlockCalls = 0;

	return {
		whenReady: Promise.resolve(),
		encryption: {
			get isUnlocked() {
				return isUnlocked;
			},
			async tryUnlock() {
				tryUnlockCalls += 1;
				isUnlocked = tryUnlockResult;
				return tryUnlockResult;
			},
			async unlock(userKey: Uint8Array) {
				unlockCalls.push([...userKey]);
				isUnlocked = true;
			},
			lock() {
				isUnlocked = false;
			},
		},
		async clearLocalData() {
			clearLocalDataCalls += 1;
			isUnlocked = false;
		},
		get unlockCalls() {
			return unlockCalls;
		},
		get isUnlocked() {
			return isUnlocked;
		},
		get clearLocalDataCalls() {
			return clearLocalDataCalls;
		},
		get tryUnlockCalls() {
			return tryUnlockCalls;
		},
	} as const;
}

function createUser() {
	return {
		id: 'user-1',
		createdAt: '2026-03-27T00:00:00.000Z',
		updatedAt: '2026-03-27T00:00:00.000Z',
		email: 'braden@example.com',
		emailVerified: true,
		name: 'Braden',
		image: null,
	};
}
