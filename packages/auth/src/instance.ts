import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

/**
 * A client's choice of which Epicenter star to talk to (ADR-0068: privacy is
 * which deployment runs the program). The default is the hosted cloud with no
 * token (normal OAuth); a self-hoster sets `baseURL` to their origin and a
 * `token` minted by their box.
 *
 * This is the persisted, per-client setting. How it is stored (localStorage,
 * chrome.storage) is the app's concern; the shape and its normalization
 * ({@link normalizeInstanceUrl}) live here so every client agrees on them.
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
 * Failures of {@link normalizeInstanceUrl}. Callers branch on `name` to render a
 * clear validation message.
 */
export const InstanceError = defineErrors({
	/** The text the user typed is not a usable http(s) URL. */
	InvalidUrl: ({ input }: { input: string }) => ({
		message: `"${input}" is not a valid instance URL.`,
		input,
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
