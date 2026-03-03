/** WebSocket close code for unauthorized (4000-4999 reserved for application use per RFC 6455). */
export const CLOSE_UNAUTHORIZED = 4401;

/**
 * Auth configuration for the sync plugin.
 *
 * - Omit entirely for open mode (no auth, any client connects)
 * - `{ verify: fn }` for custom verification (e.g. JWT validation)
 */
export type AuthConfig = { verify: (token: string) => boolean | Promise<boolean> };

/**
 * Validate an auth token against the configured auth mode.
 *
 * - Open mode: no config provided, connection accepted
 * - Verify mode: calls the verify function with the provided token
 *
 * @returns true if the connection should be accepted, false if rejected
 */
export async function validateAuth(
	config: AuthConfig | undefined,
	token: string | undefined,
): Promise<boolean> {
	// Open mode — no auth configured, accept everyone
	if (!config) return true;

	// Token is required when auth is configured
	if (!token) return false;

	return config.verify(token);
}
