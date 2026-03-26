import type {
	WorkspaceEncryption,
	WorkspaceEncryptionWithCache,
} from '@epicenter/workspace';
import { base64ToBytes } from '@epicenter/workspace/shared/crypto';
import { type } from 'arktype';
import type { User } from 'better-auth';
import { createAuthClient } from 'better-auth/client';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, tryAsync } from 'wellcrafted/result';
import { createPersistedState } from './persisted-state.svelte';

type CustomSessionFields = {
	encryptionKey: string;
};

const WorkspaceAuthError = defineErrors({
	MissingUserKeyBase64: () => ({
		message: 'Authenticated session is missing userKeyBase64',
	}),
});

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

type SessionFieldState<T> = {
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

type WorkspaceAuthHandle = {
	encryption: WorkspaceEncryption | WorkspaceEncryptionWithCache;
	clearLocalData(): Promise<void>;
};

class AuthFlowInterrupt extends Error {
	kind: 'redirect';

	constructor(kind: 'redirect') {
		super('Redirect started');
		this.kind = kind;
	}
}

function hasTryUnlock(
	encryption: WorkspaceAuthHandle['encryption'],
): encryption is WorkspaceEncryptionWithCache {
	return 'tryUnlock' in encryption;
}

export function createLocalSessionFields(prefix: string) {
	const token = createPersistedState({
		key: `${prefix}:authToken`,
		schema: type('string').or('null'),
		defaultValue: null,
	});
	const user = createPersistedState({
		key: `${prefix}:authUser`,
		schema: StoredUser.or('null'),
		defaultValue: null,
	});

	return {
		token,
		user,
	};
}

export function createWorkspaceAuth({
	baseURL,
	token,
	user,
	workspace,
	signInWithGoogle,
}: {
	baseURL: string | (() => string);
	token: SessionFieldState<string | null>;
	user: SessionFieldState<StoredUser | null>;
	workspace: WorkspaceAuthHandle;
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
	let hasExternalSession = $state(Boolean(user.current));
	let isApplyingLocalSessionChange = false;
	let bootstrapPromise: Promise<StoredUser | null> | null = null;
	let lastPublishedState: WorkspaceAuthState | null = null;

	const listeners = new Set<(state: WorkspaceAuthState) => void>();

	function readSession() {
		return {
			token: token.current,
			user: user.current,
		};
	}

	async function writeField<T>(field: SessionFieldState<T>, value: T) {
		if (field.set) {
			await field.set(value);
			return;
		}
		field.current = value;
	}

	async function writeSession(next: {
		token: string | null;
		user: StoredUser | null;
	}) {
		await writeField(token, next.token);
		await writeField(user, next.user);
	}

	async function clearStoredSession() {
		await writeField(token, null);
		await writeField(user, null);
	}

	function getStatus(): WorkspaceAuthStatus {
		if (pendingAction) return pendingAction;
		return user.current ? 'signed-in' : 'signed-out';
	}

	function getState(): WorkspaceAuthState {
		const snapshot = readSession();
		return {
			status: getStatus(),
			user: snapshot.user,
			token: snapshot.token,
			signInError: getStatus() === 'signed-out' ? lastError : undefined,
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
			hasExternalSession = Boolean(user.current);
			notify();
		}
	}

	async function writeAuthenticatedSession(result: AuthResult) {
		if (!result.userKeyBase64) {
			return WorkspaceAuthError.MissingUserKeyBase64();
		}

		await workspace.encryption.unlock(base64ToBytes(result.userKeyBase64));
		await applyLocalSessionChange(async () => {
			await writeSession({ user: result.user, token: result.token });
		});
		setLastError(undefined);
		return Ok(undefined);
	}

	async function clearSession() {
		await workspace.clearLocalData();
		await applyLocalSessionChange(async () => {
			await clearStoredSession();
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
				const { error: writeError } = await writeAuthenticatedSession(result);
				if (writeError) return Err(writeError);
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

	async function bootstrap() {
		if (!bootstrapPromise) {
			bootstrapPromise = (async () => {
				await Promise.all([token.whenReady, user.whenReady].filter(Boolean));

				const snapshot = readSession();
				if (snapshot.user && hasTryUnlock(workspace.encryption)) {
					await workspace.encryption.tryUnlock();
					setLastError(undefined);
				}

				setPendingAction(null);
				return snapshot.user;
			})();
		}

		return await bootstrapPromise;
	}

	async function refreshSession() {
		await bootstrap();
		setPendingAction('checking');

		const snapshot = readSession();
		const { data: result, error } = await tryAsync({
			try: () => client.getSession(snapshot.token),
			catch: (error) => Err(toTransportError(error)),
		});

		if (error) {
			const isAuthRejection = error.status !== undefined && error.status < 500;
			if (isAuthRejection) {
				await clearSession();
				setPendingAction(null);
				return null;
			}

			const cachedUser = user.current;
			setPendingAction(null);
			return cachedUser;
		}

		if (!result) {
			await clearSession();
			setPendingAction(null);
			return null;
		}

		const { error: writeError } = await writeAuthenticatedSession(result);
		if (writeError) {
			await clearSession();
			setLastError(`Session refresh failed: ${writeError.message}`);
			setPendingAction(null);
			return null;
		}
		setPendingAction(null);
		return result.user;
	}

	const handleExternalSessionChange = () => {
		if (isApplyingLocalSessionChange) return;

		const wasSignedIn = hasExternalSession;
		const isSignedIn = Boolean(user.current);
		hasExternalSession = isSignedIn;

		setPendingAction(null);

		if (!isSignedIn && wasSignedIn) {
			setLastError(undefined);
			void workspace.clearLocalData();
		} else if (
			isSignedIn &&
			!wasSignedIn &&
			hasTryUnlock(workspace.encryption)
		) {
			setLastError(undefined);
			void workspace.encryption.tryUnlock();
		}

		notify();
	};

	token.watch?.(() => {
		handleExternalSessionChange();
	});
	user.watch?.(() => {
		handleExternalSessionChange();
	});

	return {
		get state() {
			return getState();
		},

		get status() {
			return getStatus();
		},

		get user() {
			return user.current;
		},

		get token() {
			return token.current;
		},

		get signInError() {
			return getState().signInError;
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
			const authToken = token.current;
			if (authToken) {
				headers.set('Authorization', `Bearer ${authToken}`);
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
				try: () => client.signOut(token.current),
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
			return toAuthResult(customData, getIssuedToken() ?? token);
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
