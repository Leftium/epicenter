import { API_ROUTES } from '@epicenter/constants/api-routes';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { AuthFetch } from './auth-contract.js';
import { ApiSessionResponse } from './auth-types.js';

/**
 * A client's choice of which Epicenter star to talk to (ADR-0062: privacy is
 * which deployment runs the program). The default is the hosted cloud with no
 * token (normal OAuth); a self-hoster sets `baseURL` to their origin and a
 * `token` minted by their box.
 *
 * This is the persisted, per-client setting. How it is stored (localStorage,
 * chrome.storage) is the app's concern; the shape, normalization, and the
 * session check ({@link getSession}) live here so every client agrees on them.
 */
export type Instance = {
	/**
	 * Base URL of the Epicenter server: an origin, optionally with a path prefix,
	 * never a trailing slash. Run it through {@link normalizeInstanceUrl} before
	 * persisting.
	 */
	baseURL: string;
	/**
	 * Instance bearer token. When present, the client authenticates with it
	 * (self-host, via {@link createInstanceTokenAuth}) instead of the hosted
	 * OAuth flow. Absent for the hosted default.
	 */
	token?: string;
};

/**
 * Failures of {@link normalizeInstanceUrl} and {@link getSession}. Callers
 * branch on `name` to render a clear connected/failed state.
 */
export const InstanceError = defineErrors({
	/** The text the user typed is not a usable http(s) URL. */
	InvalidUrl: ({ input }: { input: string }) => ({
		message: `"${input}" is not a valid instance URL.`,
		input,
	}),
	/** The instance origin could not be reached (network, DNS, CORS, offline). */
	Unreachable: ({ baseURL, cause }: { baseURL: string; cause: unknown }) => ({
		message: `Could not reach ${baseURL}: ${extractErrorMessage(cause)}`,
		baseURL,
		cause,
	}),
	/** A token was sent and the instance rejected it. */
	InvalidToken: ({ status }: { status: 401 | 403 }) => ({
		message: `The instance rejected the token (${status}). Check the token and try again.`,
		status,
	}),
	/**
	 * The instance is reachable but no credential was sent, and it requires one.
	 * Not a failure of a token (none was given): the expected answer when the
	 * user means to sign in with OAuth (or a reverse-proxy resolver is absent).
	 */
	Unauthenticated: ({ status }: { status: 401 | 403 }) => ({
		message:
			'The instance is reachable but needs a credential. Paste an instance token, or save and sign in with Epicenter.',
		status,
	}),
	/** The instance answered with an unexpected status or an unreadable body. */
	Unexpected: ({ status, cause }: { status?: number; cause?: unknown }) => ({
		message:
			status === undefined
				? `The instance returned an unexpected response: ${extractErrorMessage(cause)}`
				: `The instance returned an unexpected response (${status}).`,
		status,
		cause,
	}),
});
export type InstanceError = InferErrors<typeof InstanceError>;

/**
 * Normalize user-entered instance text into a canonical `baseURL`: trim, default
 * a missing scheme to `https://`, require http(s), and drop any query, hash, and
 * trailing slash while preserving a path prefix (the route builders concatenate
 * `${baseURL}/api/...`, so a prefix like `https://host/epicenter` is honored).
 *
 * `http://` is allowed on purpose so a homelabber can point at
 * `http://localhost:8788`; the room transport rewrites the ws scheme to match.
 */
export function normalizeInstanceUrl(
	raw: string,
): Result<string, InstanceError> {
	const trimmed = raw.trim();
	if (trimmed === '') return InstanceError.InvalidUrl({ input: raw });
	// A present scheme must be http(s); a bare host defaults to https. This
	// rejects `ftp://…` up front rather than prepending https to garbage.
	const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
	if (hasScheme && !/^https?:\/\//i.test(trimmed)) {
		return InstanceError.InvalidUrl({ input: raw });
	}
	const withScheme = hasScheme ? trimmed : `https://${trimmed}`;
	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		return InstanceError.InvalidUrl({ input: raw });
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return InstanceError.InvalidUrl({ input: raw });
	}
	if (url.hostname === '') return InstanceError.InvalidUrl({ input: raw });
	return Ok(`${url.origin}${url.pathname}`.replace(/\/+$/, ''));
}

/**
 * Read `/api/session` from an instance to learn who the caller is. With a
 * `token` it verifies that credential (the self-host case); without one it
 * reports whether the origin already authenticates the request (a reverse-proxy
 * resolver returns a session) or is reachable-but-gated (`Unauthenticated`).
 *
 * Returns the validated session ({@link ApiSessionResponse}) so a settings UI
 * can show who it connected as (`session.user.email`) and the token client can
 * install state (`session.ownerId`). This is the one `/api/session` read both
 * the pre-save connection test and the client's boot verification share; it is
 * distinct from {@link AuthClient.getProfile}, which reads the same route
 * through the live, audience-scoped client transport.
 *
 * `baseURL` should already be normalized ({@link normalizeInstanceUrl}).
 */
export async function getSession({
	baseURL,
	token,
	fetch = globalThis.fetch.bind(globalThis),
}: {
	baseURL: string;
	token?: string;
	fetch?: AuthFetch;
}): Promise<Result<ApiSessionResponse, InstanceError>> {
	let response: Response;
	try {
		response = await fetch(API_ROUTES.session.url(baseURL), {
			headers: token ? { Authorization: `Bearer ${token}` } : undefined,
			credentials: 'omit',
		});
	} catch (cause) {
		return InstanceError.Unreachable({ baseURL, cause });
	}
	if (!response.ok) {
		if (response.status === 401 || response.status === 403) {
			// A token was sent and bounced means the token is bad; no token sent
			// means the origin simply requires one (the expected OAuth answer).
			return token
				? InstanceError.InvalidToken({ status: response.status })
				: InstanceError.Unauthenticated({ status: response.status });
		}
		return InstanceError.Unexpected({ status: response.status });
	}
	return tryAsync({
		try: async () => ApiSessionResponse.assert(await response.json()),
		catch: (cause) => InstanceError.Unexpected({ cause }),
	});
}
