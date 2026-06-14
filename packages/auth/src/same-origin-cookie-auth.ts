import { defineErrors } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { Err, Ok, tryAsync } from 'wellcrafted/result';
import type { AuthClient, AuthFetch, AuthState } from './auth-contract.js';
import { AuthError } from './auth-errors.js';
import { ApiSessionResponse } from './auth-types.js';
import { API_ROUTES } from './routes.js';

/**
 * Construction inputs for the same-origin cookie auth client.
 *
 * Only `baseURL` is required. `fetch` and `navigate` exist so tests can drive
 * the client without a DOM (and so the browser defaults bind correctly);
 * `callbackURL` lets a caller override where the hosted sign-in returns.
 */
export type CreateSameOriginCookieAuthConfig = {
	/**
	 * Same-origin API base URL. For a browser app the API itself serves (the
	 * dashboard at `api.epicenter.so/dashboard`), this is `window.location.origin`.
	 */
	baseURL: string;
	/**
	 * Relative path the hosted sign-in returns to once the cookie is set. The
	 * page only honors a path starting with `/`. Defaults to the current
	 * `location.pathname`.
	 */
	callbackURL?: string;
	/**
	 * Fetch implementation. The browser default is bound to `globalThis` because
	 * an unbound `fetch` throws "Illegal invocation".
	 */
	fetch?: AuthFetch;
	/**
	 * Browser navigation used by `startSignIn`. Defaults to `location.assign`.
	 */
	navigate?: (url: string) => void;
};

const SIGN_IN_PATH = '/sign-in';
const SIGN_OUT_PATH = '/auth/sign-out';

const SameOriginAuthError = defineErrors({
	SubscriberThrew: ({ cause }: { cause: unknown }) => ({
		message: 'Auth state subscriber threw.',
		cause,
	}),
});

/**
 * Auth client for a browser app served from the SAME ORIGIN as the API (the
 * billing dashboard at `api.epicenter.so/dashboard`).
 *
 * After Google sign-in such an app already holds a first-party Better Auth
 * session cookie, so running PKCE against its own origin to mint a bearer is
 * redundant (and mints an `offline_access` refresh token it never uses). This
 * client uses the cookie directly:
 *
 *   - resource calls go out same-origin with `credentials: 'include'` and no
 *     `Authorization` header; `requireCookieOrBearerUser` resolves the user from
 *     the cookie and `requireOriginForCookieMutations` guards CSRF.
 *   - `startSignIn` navigates to the hosted `/sign-in` page (Google sign-in sets
 *     the cookie), then returns to `callbackURL`.
 *   - `signOut` hits Better Auth's `/auth/sign-out`.
 *
 * There is no OAuth grant, refresh token, or persisted cell: the browser owns
 * the cookie. Because the httpOnly cookie is invisible to JS, the client cannot
 * know synchronously whether it is signed in; it reads `/api/session` once at
 * construction to confirm, and that response also supplies the `ownerId` and
 * `keyring` the public `AuthState` carries.
 *
 * This is the cookie-credential sibling of {@link createOAuthAppAuth}, not a
 * mode flag on it: the two are different credential models. Cross-origin and
 * native clients (web app, extension, Tauri, CLI) keep using `createOAuthAppAuth`
 * and PKCE.
 *
 * It returns a plain {@link AuthClient}, NOT a `SyncAuthClient`: a same-origin
 * cookie cannot carry the bearer subprotocol the rooms route requires, so this
 * client has no `openWebSocket`, and passing it where workspace sync is needed
 * is a compile error rather than a runtime throw. The only consumer (the
 * dashboard) is a billing surface with no sync.
 */
export function createSameOriginCookieAuth({
	baseURL,
	callbackURL,
	fetch: fetchImpl = globalThis.fetch.bind(globalThis),
	navigate = (url) => globalThis.location.assign(url),
}: CreateSameOriginCookieAuthConfig): AuthClient {
	const log = createLogger('auth/same-origin-cookie');
	let state: AuthState = { status: 'signed-out' };
	const listeners = new Set<(state: AuthState) => void>();

	function setState(next: AuthState) {
		state = next;
		for (const listener of listeners) {
			try {
				listener(next);
			} catch (cause) {
				log.error(SameOriginAuthError.SubscriberThrew({ cause }));
			}
		}
	}

	/**
	 * Confirm the session by reading `/api/session` with the cookie. A 401/403 is
	 * signed-out; a 200 installs `signed-in` with the response's `ownerId` and
	 * `keyring`. Network or parse failures leave the current state, so an offline
	 * load keeps the last known projection.
	 */
	async function confirmSession() {
		let response: Response;
		try {
			response = await fetchImpl(API_ROUTES.session.url(baseURL), {
				credentials: 'include',
			});
		} catch {
			return;
		}
		if (!response.ok) {
			if (response.status === 401 || response.status === 403) {
				setState({ status: 'signed-out' });
			}
			return;
		}
		try {
			const session = ApiSessionResponse.assert(await response.json());
			setState({
				status: 'signed-in',
				ownerId: session.ownerId,
				keyring: session.keyring,
			});
		} catch {
			// Malformed body: leave the current state rather than guessing.
		}
	}

	void confirmSession();

	return {
		get state() {
			return state;
		},
		baseURL,
		onStateChange(fn) {
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		},
		async startSignIn() {
			const target = callbackURL ?? globalThis.location.pathname;
			navigate(
				`${baseURL}${SIGN_IN_PATH}?callbackURL=${encodeURIComponent(target)}`,
			);
			return Ok(undefined);
		},
		async signOut() {
			const { error } = await tryAsync({
				try: () =>
					fetchImpl(`${baseURL}${SIGN_OUT_PATH}`, {
						method: 'POST',
						credentials: 'include',
					}),
				catch: (cause) => AuthError.SignOutFailed({ cause }),
			});
			// Local sign-out must not depend on the network call succeeding.
			setState({ status: 'signed-out' });
			return error ? Err(error) : Ok(undefined);
		},
		async fetch(input, init) {
			const target =
				typeof input === 'string' && input.startsWith('/')
					? new URL(input, baseURL).toString()
					: input;
			const response = await fetchImpl(target, {
				...init,
				credentials: 'include',
			});
			// A 401 means the cookie is gone or expired: go straight to signed-out.
			// This client never emits `reauth-required`; that state exists to keep a
			// workspace keyring mounted while an OAuth grant re-authenticates, and a
			// cookie surface has no keyring to preserve and no separate "reconnect"
			// path (re-auth is the same hosted sign-in as a fresh login).
			if (response.status === 401 && state.status === 'signed-in') {
				setState({ status: 'signed-out' });
			}
			return response;
		},
		[Symbol.dispose]() {
			listeners.clear();
		},
	};
}
