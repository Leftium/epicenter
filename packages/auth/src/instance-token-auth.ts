import { BEARER_SUBPROTOCOL_PREFIX } from '@epicenter/sync';
import { defineErrors } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Ok, type Result } from 'wellcrafted/result';
import type { AuthFetch, AuthState, SyncAuthClient } from './auth-contract.js';
import { AuthError } from './auth-errors.js';
import { getProfileVia, readApiSession } from './read-api-session.js';

type AuthFetchInput = Request | string | URL;

/**
 * Construction inputs for the instance-token auth client.
 *
 * `baseURL` is the self-hosted star's origin (optionally with a path prefix);
 * `token` is the operator-supplied bearer (the self-host `INSTANCE_TOKEN`, or the
 * quarantined dev `dev:<userId>` resolver's token). `fetch`, `WebSocket`, and
 * `log` exist so tests can drive the client without a DOM.
 */
export type CreateInstanceTokenAuthConfig = {
	/**
	 * Base URL of the self-hosted Epicenter server. The bearer is attached only
	 * to this origin (audience scoping, ADR-0053).
	 */
	baseURL: string;
	/**
	 * The instance bearer token. Sent verbatim as `Authorization: Bearer <token>`
	 * to `baseURL`; this client never refreshes or revokes it (it is the user's
	 * credential, not a grant this client owns).
	 */
	token: string;
	/**
	 * Fetch implementation for `/api/session` verification and authenticated
	 * resource calls. Defaults to the bound global `fetch`.
	 */
	fetch?: AuthFetch;
	/**
	 * WebSocket constructor. Tests and non-browser runtimes inject this because
	 * browsers do not allow request headers during WebSocket upgrades.
	 */
	WebSocket?: typeof WebSocket;
	/**
	 * Library logger for subscriber failures.
	 */
	log?: Logger;
};

const InstanceTokenAuthError = defineErrors({
	SubscriberThrew: ({ cause }: { cause: unknown }) => ({
		message: 'Auth state subscriber threw.',
		cause,
	}),
});

/**
 * Auth client for a prebuilt app pointed at a SELF-HOSTED Epicenter star with a
 * static instance bearer token (Wave 2 of the self-host spec).
 *
 * This is the third credential sibling of {@link createOAuthAppAuth} (PKCE
 * bearer) and {@link createSameOriginCookieAuth} (cookie): a different
 * credential model, not a mode flag on either. There is no OAuth flow, refresh,
 * launcher, or persisted grant. The token comes from the persisted Instance
 * setting and is held only in this closure for the client's lifetime:
 *
 *   - resource calls attach `Authorization: Bearer <token>`, but ONLY to
 *     `baseURL`'s origin (ADR-0053 audience scoping), so handing this `fetch` to
 *     a custom inference backend or any third party can never leak the token.
 *   - identity is resolved by reading `/api/session` once at construction (via
 *     the shared {@link readApiSession}); a 200 installs `signed-in` with the
 *     response's `ownerId`, a rejected token stays `signed-out`. `startSignIn`
 *     re-runs that check so a UI can retry a connection that was offline at boot.
 *   - `signOut` is local-only: it drops to `signed-out` without a server call,
 *     because there is no grant to revoke. Forgetting the instance itself
 *     (reverting to hosted) is an app-level concern.
 *
 * It returns a {@link SyncAuthClient} (it carries the bearer subprotocol the
 * rooms route requires), so it is a drop-in for `createSession` / cloud sync.
 */
export function createInstanceTokenAuth({
	baseURL,
	token,
	fetch: fetchImpl = globalThis.fetch.bind(globalThis),
	WebSocket: WebSocketImpl = globalThis.WebSocket,
	log = createLogger('auth/instance-token'),
}: CreateInstanceTokenAuthConfig): SyncAuthClient {
	const epicenterOrigin = new URL(baseURL).origin;
	let state: AuthState = { status: 'signed-out' };
	const listeners = new Set<(state: AuthState) => void>();

	function setState(next: AuthState) {
		state = next;
		for (const listener of listeners) {
			try {
				listener(next);
			} catch (cause) {
				log.error(InstanceTokenAuthError.SubscriberThrew({ cause }));
			}
		}
	}

	/**
	 * Resolve any auth-fetch input to its absolute target URL, mirroring the
	 * OAuth client's resolver: a relative `/path` resolves against `baseURL`.
	 * Returns null for an unparseable target so callers fail closed.
	 */
	function resolveTargetUrl(input: AuthFetchInput): URL | null {
		try {
			if (input instanceof Request) return new URL(input.url);
			if (input instanceof URL) return input;
			return new URL(input, baseURL);
		} catch {
			return null;
		}
	}

	/**
	 * Verify the configured token against `/api/session` and reflect the result
	 * into state. A 200 installs `signed-in` with the response's `ownerId`; a
	 * rejected token (`Rejected`) drops to `signed-out`. A network or parse
	 * failure returns the error and leaves the current state, so a transient
	 * outage does not look like a bad token.
	 *
	 * The actual `/api/session` read is the shared {@link readApiSession}; this
	 * only reflects its outcome onto state and the `AuthClient` error contract.
	 */
	async function confirmSession(): Promise<Result<undefined, AuthError>> {
		const { data: session, error } = await readApiSession({
			baseURL,
			token,
			fetch: fetchImpl,
		});
		if (error) {
			if (error.name === 'Rejected') setState({ status: 'signed-out' });
			return AuthError.StartSignInFailed({ cause: error });
		}
		setState({ status: 'signed-in', ownerId: session.ownerId });
		return Ok(undefined);
	}

	void confirmSession();

	async function authedFetch(input: AuthFetchInput, init?: RequestInit) {
		const target = resolveTargetUrl(input);
		const onEpicenter = target?.origin === epicenterOrigin;
		const headers = mergeRequestHeaders(input, init);
		if (onEpicenter) {
			headers.set('Authorization', `Bearer ${token}`);
		} else {
			headers.delete('Authorization');
		}
		// A Request carries its own method and body, so pass it through (cloned).
		// Anything else goes as its resolved absolute URL, so a relative `/path`
		// lands on baseURL.
		const normalizedInput: AuthFetchInput =
			input instanceof Request
				? (input.clone() as Request)
				: (target?.href ?? input);
		const response = await fetchImpl(normalizedInput, {
			...init,
			headers,
			credentials: 'omit',
			// A bearer-carrying request must never follow a cross-origin redirect:
			// some runtimes re-send the header to the new origin. Return the 3xx to
			// the caller instead (mirrors the OAuth client).
			...(onEpicenter ? { redirect: 'manual' as const } : {}),
		});
		// A 401 from the instance means the token is gone or revoked: go straight
		// to signed-out. There is no refresh path for a static token.
		if (
			response.status === 401 &&
			onEpicenter &&
			state.status === 'signed-in'
		) {
			setState({ status: 'signed-out' });
		}
		return response;
	}

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
		// "Sign in" for a token client is verifying the configured token; it lets a
		// signed-out screen retry a connection that was unreachable at boot.
		startSignIn: confirmSession,
		async signOut() {
			setState({ status: 'signed-out' });
			return Ok(undefined);
		},
		fetch: authedFetch,
		getProfile: () => getProfileVia(authedFetch, baseURL),
		async openWebSocket(url, protocols = []) {
			// The room URL is always built from `baseURL`, so the bearer is always
			// addressed to its own origin; attach it unconditionally.
			return new WebSocketImpl(String(url), [
				...protocols,
				`${BEARER_SUBPROTOCOL_PREFIX}${token}`,
			]);
		},
		[Symbol.dispose]() {
			listeners.clear();
		},
	};
}

/**
 * Merge Request headers with RequestInit headers using Fetch's own
 * normalization. Mirrors the OAuth client's helper: `HeadersInit` accepts
 * several runtime shapes, including iterable entries TypeScript does not always
 * model directly.
 */
function mergeRequestHeaders(input: AuthFetchInput, init?: RequestInit) {
	const headers = new Headers(
		input instanceof Request ? input.headers : undefined,
	);
	const source = init?.headers;
	if (!source) return headers;

	new Headers(source).forEach((value, key) => {
		headers.set(key, value);
	});
	return headers;
}
