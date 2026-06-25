import { API_ROUTES } from '@epicenter/constants/api-routes';
import type { OwnerId } from '@epicenter/identity';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
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
 * connection probe live here so every client agrees on them.
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
 * Failures of {@link normalizeInstanceUrl} and {@link probeInstance}. Callers
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
	/** The instance answered, but rejected the token. */
	InvalidToken: ({ status }: { status: 401 | 403 }) => ({
		message: `The instance rejected the token (${status}). Check the token and try again.`,
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
 * Test a connection to an instance by reading `/api/session`. With a `token` it
 * verifies that credential (the self-host case); without one it just confirms
 * the origin answers the session route. On success it returns the resolved
 * `ownerId` and the account email so a settings UI can show who it connected as.
 *
 * `baseURL` should already be normalized ({@link normalizeInstanceUrl}).
 */
export async function probeInstance({
	baseURL,
	token,
	fetch = globalThis.fetch.bind(globalThis),
}: {
	baseURL: string;
	token?: string;
	fetch?: AuthFetch;
}): Promise<Result<{ ownerId: OwnerId; email: string }, InstanceError>> {
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
			return InstanceError.InvalidToken({ status: response.status });
		}
		return InstanceError.Unexpected({ status: response.status });
	}
	const { data: session, error } = await tryAsync({
		try: async () => ApiSessionResponse.assert(await response.json()),
		catch: (cause) => InstanceError.Unexpected({ cause }),
	});
	if (error) return Err(error);
	return Ok({ ownerId: session.ownerId, email: session.user.email });
}
