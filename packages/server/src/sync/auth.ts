/** WebSocket close code for unauthorized (4000-4999 reserved for application use per RFC 6455). */
export const CLOSE_UNAUTHORIZED = 4401;

/**
 * Auth configuration for the sync plugin.
 *
 * - `openAuth()` — open mode (no auth, any client connects)
 * - `tokenAuth(secret)` — shared token mode (direct comparison)
 * - `verifyAuth(fn)` — custom verification (e.g. JWT validation)
 */
export type AuthConfig =
	| { mode: 'open' }
	| { mode: 'token'; token: string }
	| { mode: 'verify'; verify: (token: string) => boolean | Promise<boolean> };

/** Open mode: accept all connections without any token. */
export const openAuth = (): AuthConfig => ({ mode: 'open' });

/** Token mode: accept connections that present an exact matching token. */
export const tokenAuth = (token: string): AuthConfig => ({
	mode: 'token',
	token,
});

/** Verify mode: delegate auth to a custom function (e.g. JWT validation). */
export const verifyAuth = (
	verify: (token: string) => boolean | Promise<boolean>,
): AuthConfig => ({ mode: 'verify', verify });

/**
 * Validate an auth token against the configured auth mode.
 *
 * @returns true if the connection should be accepted, false if rejected
 */
export async function validateAuth(
	config: AuthConfig,
	token: string | undefined,
): Promise<boolean> {
	switch (config.mode) {
		case 'open':
			return true;
		case 'token':
			return token !== undefined && config.token === token;
		case 'verify':
			return token !== undefined && (await config.verify(token));
		default: {
			const _exhaustive: never = config;
			throw new Error(
				`Unknown auth mode: ${(_exhaustive as AuthConfig & { mode: string }).mode}`,
			);
		}
	}
}
