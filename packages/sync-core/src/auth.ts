/**
 * Extract a Bearer token from an Authorization header value.
 *
 * @returns The token string, or undefined if the header is missing or malformed.
 */
export function extractBearerToken(
	authorization: string | undefined,
): string | undefined {
	if (!authorization?.startsWith('Bearer ')) return undefined;
	return authorization.slice(7);
}

/** Token verification function. Adapters wire this into their middleware. */
export type TokenVerifier = (token: string) => boolean | Promise<boolean>;
