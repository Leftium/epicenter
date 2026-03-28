import type { BetterAuthOptions } from 'better-auth';
import { createAuthClient } from 'better-auth/client';
import { customSessionClient } from 'better-auth/client/plugins';
import type { customSession } from 'better-auth/plugins';
import type { EpicenterSessionResponse } from '@epicenter/api/types';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { type AuthSession, type StoredUser, readStatusCode } from './auth-types.js';

/**
 * Typed errors for the auth transport layer.
 *
 * These wrap Better Auth's raw `BetterFetchError` at the transport boundary so
 * callers can match on named variants instead of doing structural reads on
 * unknown error objects.
 */
export const AuthTransportError = defineErrors({
	InvalidCredentials: ({ cause }: { cause: unknown }) => ({
		message: `Invalid email or password: ${extractErrorMessage(cause)}`,
		cause,
	}),
	RequestFailed: ({
		status,
		cause,
	}: {
		status: number;
		cause: unknown;
	}) => ({
		message: `Auth request failed (${status}): ${extractErrorMessage(cause)}`,
		status,
		cause,
	}),
	UnexpectedError: ({ cause }: { cause: unknown }) => ({
		message: `Unexpected auth error: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type AuthTransportError = InferErrors<typeof AuthTransportError>;

/**
 * Classify a raw Better Auth / better-fetch error into a typed transport error.
 *
 * Uses `readStatusCode` internally — the only place this structural read is
 * needed. Callers get typed `AuthTransportError` variants instead.
 */
function classifyBetterAuthError(error: unknown) {
	const status = readStatusCode(error);
	if (status === 401 || status === 403) {
		return AuthTransportError.InvalidCredentials({ cause: error });
	}
	if (status !== undefined) {
		return AuthTransportError.RequestFailed({ status, cause: error });
	}
	return AuthTransportError.UnexpectedError({ cause: error });
}

/**
 * Compile-time bridge for `customSessionClient<T>()`.
 *
 * Better Auth's canonical pattern is `customSessionClient<typeof auth>()`, but
 * `typeof auth` drags in server-only types (Drizzle, Cloudflare.Env) that client
 * packages can't resolve. Instead we reconstruct the minimum type that
 * `InferServerPlugin` actually inspects: an `options.plugins` array containing a
 * plugin with `id: "custom-session"`. The plugin's return type is derived from
 * `EpicenterSessionResponse`—the portable contract in `@epicenter/api/types`—so
 * this adapter stays server-decoupled while producing the same type inference.
 */
type EpicenterCustomSessionPlugin = ReturnType<
	typeof customSession<EpicenterSessionResponse, BetterAuthOptions>
>;
type EpicenterAuthPluginShape = {
	options: { plugins: EpicenterCustomSessionPlugin[] };
};

type BaseURL = string | (() => string);

/**
 * Local auth resolution result used by app state.
 *
 * The canonical remote `/auth/get-session` contract is owned by the API. This
 * union is a separate layer that adds client flow states the API never returns
 * directly: anonymous and unchanged.
 */
export type SessionResolution =
	| {
			status: 'authenticated';
			token: string;
			user: StoredUser;
			userKeyBase64: string;
	  }
	| { status: 'anonymous' }
	| { status: 'unchanged' };

export type ResolveSession = (
	current: AuthSession,
) => Promise<SessionResolution>;
/**
 * Create the shared Better Auth transport used by Epicenter apps.
 *
 * Mental model:
 *
 * - Better Auth commands establish auth state
 * - `/auth/get-session` is the canonical remote session query
 * - bearer tokens are transport, not session data
 *
 * The transport keeps those concerns separate. Command methods sign in or sign
 * up, then immediately re-hydrate through `getSession()` so every client flow
 * converges on the same API-owned session contract.
 */
export function createAuthTransport({ baseURL }: { baseURL: BaseURL }) {
	/**
	 * Wrap Better Auth's client with Epicenter's bearer-token transport rules.
	 *
	 * This factory owns the protocol weirdness so the outer transport can read in
	 * domain terms: sign in, then resolve the canonical session. The only state it
	 * tracks is "what bearer token should the next request send?"
	 */
	function createBetterAuthSessionClient(authToken: string | null) {
		const bearerToken = createBearerTokenState(authToken);
		const client = createAuthClient({
			baseURL: typeof baseURL === 'function' ? baseURL() : baseURL,
			basePath: '/auth',
			plugins: [customSessionClient<EpicenterAuthPluginShape>()],
			fetchOptions: {
				auth: {
					type: 'Bearer',
					token: () => bearerToken.getCurrentToken() ?? undefined,
				},
				onSuccess: ({ response }) => {
					bearerToken.rememberTokenFromHeaders(response);
				},
			},
		});

		return {
			getCurrentToken() {
				return bearerToken.getCurrentToken();
			},
			requireAuthenticatedToken() {
				return bearerToken.requireAuthenticatedToken();
			},
			async getSession() {
				const result = await client.getSession();
				if (result.data) {
					bearerToken.rememberTokenFromSessionPayload(result.data);
				}

				return result;
			},
			async signInWithPassword(input: { email: string; password: string }) {
				const result = await client.signIn.email(input);
				bearerToken.rememberTokenFromAuthCommand(result.data);
				return result;
			},
			async signUpWithPassword(input: {
				email: string;
				password: string;
				name: string;
			}) {
				const result = await client.signUp.email(input);
				bearerToken.rememberTokenFromAuthCommand(result.data);
				return result;
			},
			async signOut() {
				return await client.signOut();
			},
			async startGoogleSignInRedirect({
				callbackURL,
			}: {
				callbackURL: string;
			}) {
				await client.signIn.social({
					provider: 'google',
					callbackURL,
				});
			},
			async signInWithGoogleIdToken({
				idToken,
				nonce,
			}: {
				idToken: string;
				nonce: string;
			}) {
				const result = await client.signIn.social({
					provider: 'google',
					idToken: { token: idToken, nonce },
				});
				if (result.data && 'token' in result.data && 'user' in result.data) {
					bearerToken.rememberTokenFromAuthCommand(result.data);
				}

				return result;
			},
		};
	}

	async function resolveSessionWithToken(
		authToken: string | null,
	): Promise<SessionResolution> {
		const sessionClient = createBetterAuthSessionClient(authToken);
		const { data, error } = await sessionClient.getSession();

		if (error) {
			const status = readStatusCode(error);

			return status !== undefined && status < 500
				? { status: 'anonymous' }
				: { status: 'unchanged' };
		}

		if (!data) return { status: 'anonymous' };

		return {
			status: 'authenticated',
			token: sessionClient.requireAuthenticatedToken(),
			user: {
				id: data.user.id,
				createdAt: data.user.createdAt.toISOString(),
				updatedAt: data.user.updatedAt.toISOString(),
				email: data.user.email,
				emailVerified: data.user.emailVerified,
				name: data.user.name,
				image: data.user.image,
			} satisfies StoredUser,
			userKeyBase64: data.userKeyBase64,
		};
	}

	return {
		/**
		 * Refresh the remote auth session using the caller's current local token
		 * when one exists.
		 */
		resolveSession(current: AuthSession): Promise<SessionResolution> {
			return resolveSessionWithToken(
				current.status === 'authenticated' ? current.token : null,
			);
		},

		/**
		 * Sign in with email/password, then normalize the remote session using the
		 * same resolution path as boot and refresh.
		 */
		async signInWithPassword(input: {
			email: string;
			password: string;
		}): Promise<Result<SessionResolution, AuthTransportError>> {
			const sessionClient = createBetterAuthSessionClient(null);
			const { error } = await sessionClient.signInWithPassword(input);
			if (error) return classifyBetterAuthError(error);

			return Ok(
				await resolveSessionWithToken(sessionClient.getCurrentToken()),
			);
		},

		/**
		 * Create an account with email/password, then normalize the remote session.
		 */
		async signUpWithPassword(input: {
			email: string;
			password: string;
			name: string;
		}): Promise<Result<SessionResolution, AuthTransportError>> {
			const sessionClient = createBetterAuthSessionClient(null);
			const { error } = await sessionClient.signUpWithPassword(input);
			if (error) return classifyBetterAuthError(error);

			return Ok(
				await resolveSessionWithToken(sessionClient.getCurrentToken()),
			);
		},

		/**
		 * Sign out the remote Better Auth session.
		 *
		 * Anonymous sessions are treated as already signed out so local sign-out
		 * flows stay idempotent.
		 */
		async signOutRemote(current: AuthSession): Promise<void> {
			if (current.status !== 'authenticated') return;

			const sessionClient = createBetterAuthSessionClient(current.token);
			const { error } = await sessionClient.signOut();
			if (error) {
				throw error;
			}
		},

		/**
		 * Start a Google OAuth redirect in browser-based clients.
		 *
		 * The browser extension uses a custom `chrome.identity` entrypoint instead,
		 * then rejoins the shared session resolution flow afterwards.
		 */
		async startGoogleSignInRedirect({
			callbackURL,
		}: {
			callbackURL: string;
		}): Promise<void> {
			const sessionClient = createBetterAuthSessionClient(null);
			await sessionClient.startGoogleSignInRedirect({ callbackURL });
		},

		/**
		 * Complete a Google sign-in flow that already has an ID token.
		 *
		 * This is used by the browser extension after `chrome.identity` completes
		 * and needs to re-enter the shared session resolution path.
		 */
		async signInWithGoogleIdToken({
			idToken,
			nonce,
		}: {
			idToken: string;
			nonce: string;
		}): Promise<Result<SessionResolution, AuthTransportError>> {
			const sessionClient = createBetterAuthSessionClient(null);
			const { data, error } = await sessionClient.signInWithGoogleIdToken({
				idToken,
				nonce,
			});
			if (error) return classifyBetterAuthError(error);
			if (!data || !('token' in data) || !('user' in data)) {
				return AuthTransportError.UnexpectedError({
					cause: new Error('Google sign-in response missing token or user'),
				});
			}

			return Ok(
				await resolveSessionWithToken(sessionClient.getCurrentToken()),
			);
		},
	};
}

/**
 * Track the freshest bearer token known to this client instance.
 *
 * Better Auth's bearer plugin can update the token through response headers,
 * while session reads expose the same session through the canonical
 * `/auth/get-session` payload. This factory keeps that transport state in one
 * place instead of spreading header and payload reconciliation through the auth
 * flows.
 */
function createBearerTokenState(authToken: string | null) {
	let currentToken: string | null | undefined;

	function getCurrentToken() {
		return currentToken === undefined ? authToken : currentToken;
	}

	return {
		getCurrentToken,
		rememberTokenFromHeaders(response: Response) {
			const nextToken = response.headers.get('set-auth-token');
			if (nextToken !== null) {
				currentToken = nextToken || null;
			}
		},
		rememberTokenFromSessionPayload(data: { session: { token: string } }) {
			currentToken = data.session.token;
		},
		rememberTokenFromAuthCommand(data: unknown) {
			if (
				typeof data === 'object' &&
				data !== null &&
				'token' in data &&
				typeof data.token === 'string'
			) {
				currentToken = data.token;
			}
		},
		requireAuthenticatedToken() {
			const token = getCurrentToken();
			if (!token) {
				throw new Error('Authenticated session is missing bearer token');
			}

			return token;
		},
	};
}

