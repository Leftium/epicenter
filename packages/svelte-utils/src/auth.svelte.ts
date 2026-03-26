import type { WorkspaceEncryptionController } from '@epicenter/workspace';
import { base64ToBytes } from '@epicenter/workspace/shared/crypto';
import { type } from 'arktype';
import type { User } from 'better-auth';
import { createAuthClient } from 'better-auth/client';
import { extractErrorMessage } from 'wellcrafted/error';
import { Ok, Err, tryAsync } from 'wellcrafted/result';
import { createPersistedState } from './persisted-state.svelte';

type CustomSessionFields = {
	encryptionKey: string;
};

export const StoredUser = type({
	id: 'string',
	createdAt: 'string',
	updatedAt: 'string',
	email: 'string',
	emailVerified: 'boolean',
	name: 'string',
	'image?': 'string | null | undefined',
});

export type StoredUser = typeof StoredUser.infer;

export type SessionSnapshot = {
	token: string | null;
	user: StoredUser | null;
};

export type SessionStore = {
	ready: Promise<void>;
	read(): SessionSnapshot;
	write(snapshot: SessionSnapshot): void | Promise<void>;
	clear(): void | Promise<void>;
	subscribe?(
		listener: (snapshot: SessionSnapshot) => void,
	): (() => void) | undefined;
};

export type WorkspaceAuthStatus =
	| 'bootstrapping'
	| 'checking'
	| 'signing-in'
	| 'signing-out'
	| 'signed-in'
	| 'signed-out';

export type WorkspaceAuthState = {
	status: WorkspaceAuthStatus;
	user: StoredUser | null;
	token: string | null;
	signInError?: string;
};

export type WorkspaceAuth = {
	readonly state: WorkspaceAuthState;
	readonly status: WorkspaceAuthStatus;
	readonly user: StoredUser | null;
	readonly token: string | null;
	readonly signInError?: string;
	subscribe(listener: (state: WorkspaceAuthState) => void): () => void;
	bootstrap(): Promise<StoredUser | null>;
	refreshSession(): Promise<StoredUser | null>;
	signIn(credentials: { email: string; password: string }): Promise<void>;
	signUp(credentials: {
		email: string;
		password: string;
		name: string;
	}): Promise<void>;
	signInWithGoogle(): Promise<void>;
	signOut(): Promise<void>;
	fetch: typeof fetch;
};

type EmailSignInCredentials = {
	email: string;
	password: string;
};

type EmailSignUpCredentials = {
	email: string;
	password: string;
	name: string;
};

type AuthResult = {
	user: StoredUser;
	token: string | null;
	userKeyBase64?: string | null;
};

type ReactiveCell<T> = {
	current: T;
	set?: (value: T) => Promise<void>;
	watch?: (callback: (value: T) => void) => (() => void) | undefined;
	whenReady?: Promise<void>;
};

type PendingAction =
	| 'bootstrapping'
	| 'checking'
	| 'signing-in'
	| 'signing-out'
	| null;

type TransportError = Error & {
	status?: number;
};

type BetterAuthInternalClient = ReturnType<typeof createAuthClient>;

type BetterAuthClient = {
	signIn(credentials: EmailSignInCredentials): Promise<AuthResult>;
	signUp(credentials: EmailSignUpCredentials): Promise<AuthResult>;
	signInWithGoogle(): Promise<AuthResult>;
	signOut(token: string | null): Promise<void>;
	getSession(token: string | null): Promise<AuthResult | null>;
};

class AuthFlowInterrupt extends Error {
	kind: 'redirect';

	constructor(kind: 'redirect') {
		super('Redirect started');
		this.kind = kind;
	}
}

export function createLocalSessionStore(prefix: string): SessionStore {
	const tokenState = createPersistedState({
		key: `${prefix}:authToken`,
		schema: type('string').or('null'),
		defaultValue: null,
	});
	const userState = createPersistedState({
		key: `${prefix}:authUser`,
		schema: StoredUser.or('null'),
		defaultValue: null,
	});

	return {
		ready: Promise.resolve(),
		read: () => ({
			token: tokenState.current,
			user: userState.current,
		}),
		write(snapshot) {
			tokenState.current = snapshot.token;
			userState.current = snapshot.user;
		},
		clear() {
			tokenState.current = null;
			userState.current = null;
		},
	};
}

export function createChromeSessionStore({
	token,
	user,
	ready,
}: {
	token: ReactiveCell<string | null>;
	user: ReactiveCell<StoredUser | null>;
	ready?: Promise<void>;
}): SessionStore {
	const resolvedReady = (ready ??
		Promise.all([token.whenReady, user.whenReady].filter(Boolean)).then(
			() => undefined,
		)) as Promise<void>;

	async function writeCell<T>(cell: ReactiveCell<T>, value: T) {
		if (cell.set) {
			await cell.set(value);
			return;
		}
		cell.current = value;
	}

	return {
		ready: resolvedReady,
		read: () => ({
			token: token.current,
			user: user.current,
		}),
		async write(snapshot) {
			await writeCell(token, snapshot.token);
			await writeCell(user, snapshot.user);
		},
		async clear() {
			await writeCell(token, null);
			await writeCell(user, null);
		},
		subscribe(listener) {
			const notify = () => {
				listener({
					token: token.current,
					user: user.current,
				});
			};
			const unsubscribeToken = token.watch?.(() => {
				notify();
			});
			const unsubscribeUser = user.watch?.(() => {
				notify();
			});
			return () => {
				unsubscribeToken?.();
				unsubscribeUser?.();
			};
		},
	};
}

export function createWorkspaceAuth({
	baseURL,
	store,
	encryption,
	signInWithGoogle,
}: {
	baseURL: string | (() => string);
	store: SessionStore;
	encryption: WorkspaceEncryptionController;
	signInWithGoogle?: (
		client: BetterAuthInternalClient,
	) => Promise<{ user: User } & Partial<CustomSessionFields>>;
}): WorkspaceAuth {
	const client = createBetterAuthClient({
		baseURL,
		signInWithGoogle,
	});

	let pendingAction = $state<PendingAction>('bootstrapping');
	let lastError = $state<string | undefined>(undefined);
	let hasExternalSession = $state(Boolean(store.read().user));
	let isApplyingLocalSessionChange = false;
	let bootstrapPromise: Promise<StoredUser | null> | null = null;
	let lastPublishedState: WorkspaceAuthState | null = null;

	const listeners = new Set<(state: WorkspaceAuthState) => void>();

	function getStatus(): WorkspaceAuthStatus {
		if (pendingAction) return pendingAction;
		return store.read().user ? 'signed-in' : 'signed-out';
	}

	function getSignInError() {
		return getStatus() === 'signed-out' ? lastError : undefined;
	}

	function getState(): WorkspaceAuthState {
		return {
			status: getStatus(),
			user: store.read().user,
			token: store.read().token,
			signInError: getSignInError(),
		};
	}

	function statesMatch(
		left: WorkspaceAuthState | null,
		right: WorkspaceAuthState,
	) {
		return (
			left?.status === right.status &&
			left?.user === right.user &&
			left?.token === right.token &&
			left?.signInError === right.signInError
		);
	}

	function notify() {
		const nextState = getState();
		if (statesMatch(lastPublishedState, nextState)) return;
		lastPublishedState = nextState;
		for (const listener of listeners) {
			listener(nextState);
		}
	}

	function setPendingAction(next: PendingAction) {
		if (pendingAction === next) return;
		pendingAction = next;
		notify();
	}

	function setLastError(next: string | undefined) {
		if (lastError === next) return;
		lastError = next;
		notify();
	}

	async function applyLocalSessionChange(
		run: () => void | Promise<void>,
	): Promise<void> {
		isApplyingLocalSessionChange = true;
		try {
			await run();
		} finally {
			isApplyingLocalSessionChange = false;
			hasExternalSession = Boolean(store.read().user);
			notify();
		}
	}

	function requireUserKeyBase64(result: AuthResult) {
		if (result.userKeyBase64) return result.userKeyBase64;
		throw new Error('Workspace auth requires userKeyBase64');
	}

	async function writeAuthenticatedSession(result: AuthResult) {
		await encryption.activate(base64ToBytes(requireUserKeyBase64(result)));
		await applyLocalSessionChange(async () => {
			await store.write({ user: result.user, token: result.token });
		});
		setLastError(undefined);
	}

	async function clearSession() {
		await encryption.deactivate();
		await applyLocalSessionChange(async () => {
			await store.clear();
		});
		setLastError(undefined);
	}

	async function authenticate(
		run: () => Promise<AuthResult>,
		errorPrefix: string,
	) {
		setPendingAction('signing-in');

		const { error } = await tryAsync({
			try: async () => {
				const result = await run();
				await writeAuthenticatedSession(result);
			},
			catch: (error) => Err(error),
		});

		if (error) {
			if (isRedirectInterrupt(error)) {
				setPendingAction(null);
				return;
			}

			setLastError(
				isCancelledError(error)
					? undefined
					: `${errorPrefix}: ${extractErrorMessage(error)}`,
			);
		}

		setPendingAction(null);
	}

	async function runBootstrap() {
		await store.ready;

		const snapshot = store.read();
		if (snapshot.user) {
			await encryption.restoreEncryptionFromCache();
			setLastError(undefined);
		}

		setPendingAction(null);
		return snapshot.user;
	}

	async function bootstrap() {
		if (!bootstrapPromise) {
			bootstrapPromise = runBootstrap();
		}

		return await bootstrapPromise;
	}

	async function refreshSession() {
		await bootstrap();
		setPendingAction('checking');

		const snapshot = store.read();
		const { data: result, error } = await tryAsync({
			try: () => client.getSession(snapshot.token),
			catch: (error) => Err(toTransportError(error)),
		});

		if (error) {
			const isAuthRejection =
				error.status !== undefined && error.status < 500;
			if (isAuthRejection) {
				await clearSession();
				setPendingAction(null);
				return null;
			}

			const cachedUser = store.read().user;
			setPendingAction(null);
			return cachedUser;
		}

		if (!result) {
			await clearSession();
			setPendingAction(null);
			return null;
		}

		if (!result.userKeyBase64) {
			await clearSession();
			setLastError('Session refresh failed: missing userKeyBase64');
			setPendingAction(null);
			return null;
		}

		await writeAuthenticatedSession(result);
		setPendingAction(null);
		return result.user;
	}

	store.subscribe?.((snapshot) => {
		if (isApplyingLocalSessionChange) return;

		const wasSignedIn = hasExternalSession;
		const isSignedIn = Boolean(snapshot.user);
		hasExternalSession = isSignedIn;

		setPendingAction(null);

		if (!isSignedIn && wasSignedIn) {
			setLastError(undefined);
			void encryption.deactivate();
		} else if (isSignedIn && !wasSignedIn) {
			setLastError(undefined);
			void encryption.restoreEncryptionFromCache();
		}

		notify();
	});

	return {
		get state() {
			return getState();
		},

		get status() {
			return getStatus();
		},

		get user() {
			return store.read().user;
		},

		get token() {
			return store.read().token;
		},

		get signInError() {
			return getSignInError();
		},

		subscribe(listener) {
			listeners.add(listener);
			listener(getState());
			return () => {
				listeners.delete(listener);
			};
		},

		bootstrap,
		refreshSession,

		fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			const token = store.read().token;
			if (token) {
				headers.set('Authorization', `Bearer ${token}`);
			}
			return fetch(input, {
				...init,
				headers,
				credentials: 'include',
			});
		}) as typeof fetch,

		async signIn(credentials) {
			await authenticate(() => client.signIn(credentials), 'Sign-in failed');
		},

		async signUp(credentials) {
			await authenticate(() => client.signUp(credentials), 'Sign-up failed');
		},

		async signInWithGoogle() {
			await authenticate(
				() => client.signInWithGoogle(),
				'Google sign-in failed',
			);
		},

		async signOut() {
			setPendingAction('signing-out');
			await tryAsync({
				try: () => client.signOut(store.read().token),
				catch: () => Ok(undefined),
			});
			await clearSession();
			setPendingAction(null);
		},
	};
}

function createBetterAuthClient({
	baseURL,
	signInWithGoogle,
}: {
	baseURL: string | (() => string);
	signInWithGoogle?: (
		client: BetterAuthInternalClient,
	) => Promise<{ user: User } & Partial<CustomSessionFields>>;
}): BetterAuthClient {
	const resolveBaseUrl =
		typeof baseURL === 'function' ? baseURL : () => baseURL;

	function buildClient(token: string | null) {
		let nextToken: string | null | undefined;

		const client = createAuthClient({
			baseURL: resolveBaseUrl(),
			basePath: '/auth',
			fetchOptions: {
				auth: {
					type: 'Bearer',
					token: () => token ?? undefined,
				},
				onSuccess: ({ response }) => {
					const issuedToken = response.headers.get('set-auth-token');
					if (issuedToken) nextToken = issuedToken;
				},
			},
		});

		return {
			client,
			getIssuedToken: () => nextToken,
		};
	}

	async function runGoogleSignIn(client: BetterAuthInternalClient) {
		if (signInWithGoogle) {
			return await signInWithGoogle(client);
		}

		await client.signIn.social({
			provider: 'google',
			callbackURL: window.location.origin,
		});
		throw new AuthFlowInterrupt('redirect');
	}

	return {
		async signIn(credentials) {
			const { client, getIssuedToken } = buildClient(null);
			const { data, error } = await client.signIn.email(credentials);
			if (error) throw toTransportError(error);
			return toAuthResult(data, getIssuedToken());
		},

		async signUp(credentials) {
			const { client, getIssuedToken } = buildClient(null);
			const { data, error } = await client.signUp.email(credentials);
			if (error) throw toTransportError(error);
			return toAuthResult(data, getIssuedToken());
		},

		async signInWithGoogle() {
			const { client, getIssuedToken } = buildClient(null);
			const data = await runGoogleSignIn(client);
			return toAuthResult(data, getIssuedToken());
		},

		async signOut(token) {
			const { client } = buildClient(token);
			const { error } = await client.signOut();
			if (error) throw toTransportError(error);
		},

		async getSession(token) {
			const { client, getIssuedToken } = buildClient(token);
			const { data, error } = await client.getSession();
			if (error) throw toTransportError(error);
			if (!data) return null;

			const customData = data as typeof data & Partial<CustomSessionFields>;
			return {
				user: toStoredUser(customData.user),
				token: getIssuedToken() ?? token,
				userKeyBase64: customData.encryptionKey ?? null,
			};
		},
	};
}

function toAuthResult(
	data: { user: User } & Partial<CustomSessionFields>,
	token: string | null | undefined,
): AuthResult {
	return {
		user: toStoredUser(data.user),
		token: token ?? null,
		userKeyBase64: data.encryptionKey ?? null,
	};
}

function toStoredUser(raw: User): StoredUser {
	return {
		id: raw.id,
		createdAt: raw.createdAt.toISOString(),
		updatedAt: raw.updatedAt.toISOString(),
		email: raw.email,
		emailVerified: raw.emailVerified,
		name: raw.name,
		image: raw.image,
	};
}

function toTransportError(error: unknown): TransportError {
	const next = new Error(extractErrorMessage(error)) as TransportError;
	if (
		typeof error === 'object' &&
		error !== null &&
		'status' in error &&
		typeof error.status === 'number'
	) {
		next.status = error.status;
	}
	return next;
}

function isCancelledError(cause: unknown) {
	const message = cause instanceof Error ? cause.message : '';
	return message.includes('canceled') || message.includes('cancelled');
}

function isRedirectInterrupt(cause: unknown) {
	return cause instanceof AuthFlowInterrupt && cause.kind === 'redirect';
}
