import { APP_URLS } from '@epicenter/constants/vite';
import {
	createLocalSessionStore,
	type StoredUser,
} from '@epicenter/svelte/auth';
import { createAuthClient } from 'better-auth/client';
import { extractErrorMessage } from 'wellcrafted/error';

type AuthStatus =
	| 'bootstrapping'
	| 'checking'
	| 'signing-in'
	| 'signing-out'
	| 'signed-in'
	| 'signed-out';

type SessionAuthState = {
	status: AuthStatus;
	user: StoredUser | null;
	token: string | null;
	signInError?: string;
};

type PendingAction =
	| 'bootstrapping'
	| 'checking'
	| 'signing-in'
	| 'signing-out'
	| null;

class AuthFlowInterrupt extends Error {
	kind: 'redirect';

	constructor(kind: 'redirect') {
		super('Redirect started');
		this.kind = kind;
	}
}

const store = createLocalSessionStore('zhongwen');

function createAuth() {
	let pendingAction = $state<PendingAction>('bootstrapping');
	let lastError = $state<string | undefined>(undefined);
	let bootstrapPromise: Promise<StoredUser | null> | null = null;

	const listeners = new Set<(state: SessionAuthState) => void>();
	let lastPublishedState: SessionAuthState | null = null;

	function buildClient(token: string | null) {
		let nextToken: string | null | undefined;

		const client = createAuthClient({
			baseURL: APP_URLS.API,
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

	function getStatus(): AuthStatus {
		if (pendingAction) return pendingAction;
		return store.read().user ? 'signed-in' : 'signed-out';
	}

	function getState(): SessionAuthState {
		return {
			status: getStatus(),
			user: store.read().user,
			token: store.read().token,
			signInError: getStatus() === 'signed-out' ? lastError : undefined,
		};
	}

	function statesMatch(left: SessionAuthState | null, right: SessionAuthState) {
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

	async function writeSession(user: StoredUser, token: string | null) {
		await store.write({ user, token });
		setLastError(undefined);
		notify();
	}

	async function clearSession() {
		await store.clear();
		setLastError(undefined);
		notify();
	}

	async function bootstrap() {
		if (!bootstrapPromise) {
			bootstrapPromise = (async () => {
				await store.ready;
				setPendingAction(null);
				return store.read().user;
			})();
		}

		return await bootstrapPromise;
	}

	async function refreshSession() {
		await bootstrap();
		setPendingAction('checking');

		try {
			const snapshot = store.read();
			const { client, getIssuedToken } = buildClient(snapshot.token);
			const { data, error } = await client.getSession();

			if (error) {
				const status = typeof error.status === 'number' ? error.status : undefined;
				if (status !== undefined && status < 500) {
					await clearSession();
					setPendingAction(null);
					return null;
				}

				const cachedUser = store.read().user;
				setPendingAction(null);
				return cachedUser;
			}

			if (!data) {
				await clearSession();
				setPendingAction(null);
				return null;
			}

			const user = toStoredUser(data.user);
			await writeSession(user, getIssuedToken() ?? snapshot.token);
			setPendingAction(null);
			return user;
		} catch {
			const cachedUser = store.read().user;
			setPendingAction(null);
			return cachedUser;
		}
	}

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
			return getState().signInError;
		},

		subscribe(listener: (state: SessionAuthState) => void) {
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

		async signInWithGoogle() {
			setPendingAction('signing-in');

			try {
				const { client } = buildClient(null);
				await client.signIn.social({
					provider: 'google',
					callbackURL: window.location.origin,
				});
				throw new AuthFlowInterrupt('redirect');
			} catch (error) {
				if (!(error instanceof AuthFlowInterrupt)) {
					setLastError(`Google sign-in failed: ${extractErrorMessage(error)}`);
				}
			}

			setPendingAction(null);
		},

		async signOut() {
			setPendingAction('signing-out');

			try {
				const { client } = buildClient(store.read().token);
				await client.signOut();
			} catch {}

			await clearSession();
			setPendingAction(null);
		},
	};
}

function toStoredUser(user: {
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

export const authState = createAuth();
