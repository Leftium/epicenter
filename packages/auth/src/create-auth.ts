import type { SessionResponse } from '@epicenter/api/types';
import { encryptionKeysFingerprint } from '@epicenter/workspace/encryption-key';
import type { BetterAuthOptions } from 'better-auth';
import { createAuthClient, InferPlugin } from 'better-auth/client';
import type { customSession } from 'better-auth/plugins';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type {
	AuthSnapshot,
	AuthSnapshotSubscriber,
	Session,
	StoredUser,
} from './auth-types.ts';
import type { MaybePromise, SessionStorage } from './session-store.ts';

export const AuthError = defineErrors({
	InvalidCredentials: () => ({
		message: 'Invalid email or password.',
	}),
	SignInFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to sign in: ${extractErrorMessage(cause)}`,
		cause,
	}),
	SignUpFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to create account: ${extractErrorMessage(cause)}`,
		cause,
	}),
	SocialSignInFailed: ({ cause }: { cause: unknown }) => ({
		message: `Social sign-in failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	SignOutFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to sign out: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type AuthError = InferErrors<typeof AuthError>;

/**
 * Payload returned by a native/extension `socialTokenProvider`. Identifies
 * which Better Auth social provider to verify the ID token against.
 */
export type SocialTokenPayload = {
	provider: string;
	idToken: string;
	nonce: string;
};

export type CreateAuthConfig = {
	/** Resolved once at construction; recreate the client if the origin changes. */
	baseURL: string;
	sessionStorage: SessionStorage;
	/**
	 * Platform-specific credential provider for social ID token sign-in.
	 *
	 * Injected at creation time so the auth client can orchestrate the full
	 * popup flow without pushing platform logic into UI components. Native
	 * apps and extensions provide this; web apps that only use redirect
	 * sign-in can omit it.
	 */
	socialTokenProvider?: () => Promise<SocialTokenPayload>;
};

export type AuthClient = {
	readonly snapshot: AuthSnapshot;
	readonly whenSessionLoaded: Promise<void>;
	subscribe(fn: AuthSnapshotSubscriber): () => void;
	signIn(input: {
		email: string;
		password: string;
	}): Promise<Result<undefined, AuthError>>;
	signUp(input: {
		email: string;
		password: string;
		name: string;
	}): Promise<Result<undefined, AuthError>>;
	signInWithSocialPopup(): Promise<Result<undefined, AuthError>>;
	signInWithSocialRedirect(input: {
		provider: string;
		callbackURL: string;
	}): Promise<Result<undefined, AuthError>>;
	signOut(): Promise<Result<undefined, AuthError>>;
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;

	[Symbol.dispose](): void;
};

export type SessionStateAdapter = {
	get(): Session | null;
	set(value: Session | null): MaybePromise<void>;
	watch(fn: (next: Session | null) => void): () => void;
	whenReady?: Promise<unknown>;
};

export type AuthWorkspaceSyncTarget = {
	goOffline(): void;
	reconnect(): void;
};

export type AuthWorkspaceTarget = {
	sync: AuthWorkspaceSyncTarget;
	idb: {
		clearLocal(): Promise<unknown>;
	};
	encryption: {
		applyKeys(keys: Session['encryptionKeys']): void;
	};
	getAuthSyncTargets?(): Iterable<AuthWorkspaceSyncTarget>;
};

export function createSessionStorageAdapter(
	state: SessionStateAdapter,
): SessionStorage {
	return {
		async load() {
			await state.whenReady;
			return state.get();
		},
		save: (value) => state.set(value),
		watch: state.watch,
	};
}

export function attachAuthSnapshotToWorkspace({
	auth,
	workspace,
	onSignedIn,
}: {
	auth: Pick<AuthClient, 'subscribe'>;
	workspace: AuthWorkspaceTarget;
	onSignedIn?: () => void;
}): () => void {
	function getSyncTargets() {
		return new Set(workspace.getAuthSyncTargets?.() ?? [workspace.sync]);
	}

	return auth.subscribe((next, previous) => {
		if (next.status === 'loading') return;

		const previousSession =
			previous.status === 'signedIn' ? previous.session : null;

		if (next.status === 'signedOut') {
			for (const sync of getSyncTargets()) sync.goOffline();
			if (previousSession !== null) void workspace.idb.clearLocal();
			return;
		}

		workspace.encryption.applyKeys(next.session.encryptionKeys);
		if (previousSession?.token !== next.session.token) {
			for (const sync of getSyncTargets()) sync.reconnect();
		}
		onSignedIn?.();
	});
}

/**
 * Compile-time bridge for Better Auth's custom session type inference.
 *
 * `customSessionClient<typeof auth>()` is the canonical pattern but drags in
 * server-only types that client packages in a monorepo can't resolve.
 * `InferPlugin<T>()` sets the same `$InferServerPlugin` property without
 * requiring a fabricated auth shape.
 */
type EpicenterCustomSessionPlugin = ReturnType<
	typeof customSession<SessionResponse, BetterAuthOptions>
>;

/**
 * Create a framework-agnostic auth client.
 *
 * Owns the Better Auth transport, response-header token rotation, storage
 * hydration, and snapshot subscription fan-out. The getter only reads the
 * in-memory snapshot.
 */
export function createAuth({
	baseURL,
	sessionStorage,
	socialTokenProvider,
}: CreateAuthConfig): AuthClient {
	let snapshot: AuthSnapshot = { status: 'loading' };
	let storageLoaded = false;
	let bufferedBetterAuthCandidate: Session | null | undefined;
	let resolveWhenSessionLoaded: () => void = () => {};
	const whenSessionLoaded = new Promise<void>((resolve) => {
		resolveWhenSessionLoaded = resolve;
	});

	const snapshotSubs = new Set<AuthSnapshotSubscriber>();

	const disposers: Array<() => void> = [];

	function safeRun(fn: () => void) {
		try {
			fn();
		} catch (error) {
			console.error('[auth] subscriber threw:', error);
		}
	}

	function sessionFromSnapshot(value: AuthSnapshot): Session | null {
		return value.status === 'signedIn' ? value.session : null;
	}

	function snapshotFromSession(session: Session | null): AuthSnapshot {
		return session === null
			? { status: 'signedOut' }
			: { status: 'signedIn', session };
	}

	function sessionsEqual(left: Session | null, right: Session | null) {
		if (left === null || right === null) return left === right;
		return (
			left.token === right.token &&
			usersEqual(left.user, right.user) &&
			encryptionKeysFingerprint(left.encryptionKeys) ===
				encryptionKeysFingerprint(right.encryptionKeys)
		);
	}

	function authSnapshotEquals(left: AuthSnapshot, right: AuthSnapshot) {
		if (left.status !== right.status) return false;
		if (left.status !== 'signedIn' || right.status !== 'signedIn') return true;
		return sessionsEqual(left.session, right.session);
	}

	function setSnapshot(next: AuthSnapshot) {
		if (authSnapshotEquals(snapshot, next)) return;
		const previous = snapshot;
		snapshot = next;
		for (const subscriber of snapshotSubs) {
			safeRun(() => subscriber(next, previous));
		}
	}

	function saveSnapshot(next: AuthSnapshot) {
		void Promise.resolve(sessionStorage.save(sessionFromSnapshot(next))).catch(
			(error) => {
				console.error('[auth] failed to save session:', error);
			},
		);
	}

	function writeLocalSnapshot(next: AuthSnapshot) {
		setSnapshot(next);
		saveSnapshot(next);
	}

	function reconcileBetterAuthCandidate(next: Session | null | undefined) {
		if (next === undefined) return;
		if (next === null) {
			if (snapshot.status !== 'loading') writeLocalSnapshot({ status: 'signedOut' });
			return;
		}

		const current = sessionFromSnapshot(snapshot);
		writeLocalSnapshot({
			status: 'signedIn',
			session: {
				token: current?.token ?? next.token,
				user: next.user,
				encryptionKeys: next.encryptionKeys,
			},
		});
	}

		function settleLoadedSession(loaded: Session | null) {
			storageLoaded = true;
			setSnapshot(snapshotFromSession(loaded));
			if (bufferedBetterAuthCandidate !== undefined) {
				reconcileBetterAuthCandidate(bufferedBetterAuthCandidate);
			}
			resolveWhenSessionLoaded();
	}

	function loadPersistedSession() {
		try {
			const loaded = sessionStorage.load();
			if (loaded instanceof Promise) {
				loaded.then(settleLoadedSession, (error) => {
					console.error('[auth] failed to load session:', error);
					settleLoadedSession(null);
				});
				return;
			}
			settleLoadedSession(loaded);
		} catch (error) {
			console.error('[auth] failed to load session:', error);
			settleLoadedSession(null);
		}
	}

	disposers.push(
		sessionStorage.watch((next) => {
			if (!storageLoaded) return;
			setSnapshot(snapshotFromSession(next));
		}),
	);

	const client = createAuthClient({
		baseURL,
		basePath: '/auth',
		plugins: [InferPlugin<EpicenterCustomSessionPlugin>()],
		fetchOptions: {
			auth: {
				type: 'Bearer',
				token: () =>
					snapshot.status === 'signedIn' ? snapshot.session.token : undefined,
			},
			onSuccess: (context) => {
				const newToken = context.response.headers.get('set-auth-token');
				if (
					newToken &&
					snapshot.status === 'signedIn' &&
					newToken !== snapshot.session.token
				) {
					writeLocalSnapshot({
						status: 'signedIn',
						session: { ...snapshot.session, token: newToken },
					});
				}
			},
		},
	});

	disposers.push(
		client.useSession.subscribe((state) => {
			if (state.isPending) return;
			const data = state.data as SessionResponse | null;
			const next = data
				? {
						token: data.session.token,
						user: normalizeUser(data.user),
						encryptionKeys: data.encryptionKeys,
					}
				: null;

			if (!storageLoaded) {
				bufferedBetterAuthCandidate = next;
				return;
			}

			if (data) {
				reconcileBetterAuthCandidate(next);
			} else if (snapshot.status === 'signedIn') {
				writeLocalSnapshot({ status: 'signedOut' });
			}
		}),
	);

	loadPersistedSession();

	return {
		get snapshot() {
			return snapshot;
		},
		whenSessionLoaded,
		subscribe(fn) {
			const current = snapshot;
			const previous =
				current.status === 'loading' ? current : ({ status: 'loading' } as const);
			safeRun(() => fn(current, previous));
			snapshotSubs.add(fn);
			return () => {
				snapshotSubs.delete(fn);
			};
		},

		async signIn(input) {
			try {
				const { error } = await client.signIn.email(input);
				if (!error) return Ok(undefined);
				if (error.status === 401 || error.status === 403)
					return AuthError.InvalidCredentials();
				return AuthError.SignInFailed({ cause: error });
			} catch (error) {
				return AuthError.SignInFailed({ cause: error });
			}
		},

		async signUp(input) {
			try {
				const { error } = await client.signUp.email(input);
				if (error) return AuthError.SignUpFailed({ cause: error });
				return Ok(undefined);
			} catch (error) {
				return AuthError.SignUpFailed({ cause: error });
			}
		},

		async signInWithSocialPopup() {
			if (!socialTokenProvider) {
				return AuthError.SocialSignInFailed({
					cause: new Error('No socialTokenProvider configured.'),
				});
			}
			try {
				const { provider, idToken, nonce } = await socialTokenProvider();
				const { error } = await client.signIn.social({
					provider,
					idToken: { token: idToken, nonce },
				});
				if (error) return AuthError.SocialSignInFailed({ cause: error });
				return Ok(undefined);
			} catch (error) {
				return AuthError.SocialSignInFailed({ cause: error });
			}
		},

		async signInWithSocialRedirect({ provider, callbackURL }) {
			try {
				await client.signIn.social({ provider, callbackURL });
				return Ok(undefined);
			} catch (error) {
				return AuthError.SocialSignInFailed({ cause: error });
			}
		},

		async signOut() {
			try {
				const { error } = await client.signOut();
				if (error) return AuthError.SignOutFailed({ cause: error });
				writeLocalSnapshot({ status: 'signedOut' });
				return Ok(undefined);
			} catch (error) {
				return AuthError.SignOutFailed({ cause: error });
			}
		},

		async fetch(input, init) {
			await whenSessionLoaded;
			const headers = new Headers(init?.headers);
			if (snapshot.status === 'signedIn') {
				headers.set('Authorization', `Bearer ${snapshot.session.token}`);
			}
			return fetch(input, { ...init, headers, credentials: 'include' });
		},

		[Symbol.dispose]() {
			for (const dispose of disposers) {
				try {
					dispose();
				} catch (error) {
					console.error('[auth] dispose error:', error);
				}
			}
			snapshotSubs.clear();
		},
	};
}

/**
 * Convert BA's `Date` fields to ISO strings for JSON-safe persistence.
 *
 * BA returns `createdAt` and `updatedAt` as `Date` objects. Persisted session
 * stores (chrome.storage, localStorage) need plain JSON, so we normalize here
 * at the boundary rather than forcing every consumer to handle it.
 */
function normalizeUser(user: {
	id: string;
	createdAt: Date;
	updatedAt: Date;
	email: string;
	emailVerified: boolean;
	name: string;
	image?: string | null;
}): StoredUser {
	return {
		id: user.id,
		createdAt: user.createdAt.toISOString(),
		updatedAt: user.updatedAt.toISOString(),
		email: user.email,
		emailVerified: user.emailVerified,
		name: user.name,
		image: user.image,
	};
}

function usersEqual(left: StoredUser, right: StoredUser) {
	return (
		left.id === right.id &&
		left.createdAt === right.createdAt &&
		left.updatedAt === right.updatedAt &&
		left.email === right.email &&
		left.emailVerified === right.emailVerified &&
		left.name === right.name &&
		left.image === right.image
	);
}
