import type { EpicenterSessionResponse } from '@epicenter/api/types';
import type { BetterAuthOptions } from 'better-auth';
import { createAuthClient } from 'better-auth/client';
import { customSessionClient } from 'better-auth/client/plugins';
import type { customSession } from 'better-auth/plugins';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import {
	type AuthSession,
	readStatusCode,
	type StoredUser,
} from './auth-types.js';

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
	RequestFailed: ({ status, cause }: { status: number; cause: unknown }) => ({
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
	function makeClient(token: string | null) {
		return createAuthClient({
			baseURL: typeof baseURL === 'function' ? baseURL() : baseURL,
			basePath: '/auth',
			plugins: [customSessionClient<EpicenterAuthPluginShape>()],
			fetchOptions: {
				auth: { type: 'Bearer', token: token ?? undefined },
			},
		});
	}

	function extractCommandToken(data: unknown): string | null {
		if (typeof data !== 'object' || data === null) return null;
		if ('token' in data && typeof data.token === 'string') {
			return data.token;
		}
		if (
			'session' in data &&
			typeof data.session === 'object' &&
			data.session !== null &&
			'token' in data.session &&
			typeof data.session.token === 'string'
		) {
			return data.session.token;
		}
		return null;
	}

	async function resolveSessionWithToken(
		authToken: string | null,
	): Promise<SessionResolution> {
		const client = makeClient(authToken);
		const { data, error } = await client.getSession();

		if (error) {
			const status = readStatusCode(error);

			return status !== undefined && status < 500
				? { status: 'anonymous' }
				: { status: 'unchanged' };
		}

		if (!data) return { status: 'anonymous' };

		const sessionToken =
			typeof data.session.token === 'string' ? data.session.token : authToken;
		if (!sessionToken) return { status: 'anonymous' };

		return {
			status: 'authenticated',
			token: sessionToken,
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

	/**
	 * Run an auth command (sign-in, sign-up, etc.) and resolve the resulting
	 * session through the canonical getSession path.
	 *
	 * Every auth command follows the same pipeline: execute → extract token →
	 * hydrate the full session. This function is that pipeline.
	 */
	async function commandThenResolve(
		command: () => Promise<{ data: unknown; error: unknown }>,
	): Promise<Result<SessionResolution, AuthTransportError>> {
		const { data, error } = await command();
		if (error) return classifyBetterAuthError(error);
		return Ok(await resolveSessionWithToken(extractCommandToken(data)));
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
		signInWithPassword(input: {
			email: string;
			password: string;
		}): Promise<Result<SessionResolution, AuthTransportError>> {
			return commandThenResolve(() => makeClient(null).signIn.email(input));
		},

		/**
		 * Create an account with email/password, then normalize the remote session.
		 */
		signUpWithPassword(input: {
			email: string;
			password: string;
			name: string;
		}): Promise<Result<SessionResolution, AuthTransportError>> {
			return commandThenResolve(() => makeClient(null).signUp.email(input));
		},

		/**
		 * Sign out the remote Better Auth session.
		 *
		 * Anonymous sessions are treated as already signed out so local sign-out
		 * flows stay idempotent.
		 */
		async signOutRemote(current: AuthSession): Promise<void> {
			if (current.status !== 'authenticated') return;

			const client = makeClient(current.token);
			const { error } = await client.signOut();
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
			const client = makeClient(null);
			await client.signIn.social({
				provider: 'google',
				callbackURL,
			});
		},

		/**
		 * Complete a Google sign-in flow that already has an ID token.
		 *
		 * This is used by the browser extension after `chrome.identity` completes
		 * and needs to re-enter the shared session resolution path.
		 */
		signInWithGoogleIdToken({
			idToken,
			nonce,
		}: {
			idToken: string;
			nonce: string;
		}): Promise<Result<SessionResolution, AuthTransportError>> {
			return commandThenResolve(() =>
				makeClient(null).signIn.social({
					provider: 'google',
					idToken: { token: idToken, nonce },
				}),
			);
		},
	};
}
