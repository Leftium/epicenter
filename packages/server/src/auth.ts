import { Elysia } from 'elysia';

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

/**
 * Create an Elysia plugin that guards all routes (except `GET /`) with a
 * pre-shared Bearer token.
 *
 * Both the local and remote servers use this for `mode: 'token'` auth.
 * The health check endpoint (`GET /`) is excluded so load balancers and
 * readiness probes can reach it without credentials.
 */
export function createTokenGuardPlugin(token: string) {
	return new Elysia().onBeforeHandle(
		{ as: 'global' },
		({ request, status, path }) => {
			if (path === '/') return;
			const bearerToken = extractBearerToken(
				request.headers.get('authorization') ?? undefined,
			);
			if (bearerToken !== token) {
				return status(401, 'Unauthorized: Invalid token');
			}
		},
	);
}
