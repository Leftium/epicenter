import { extractBearerToken } from '@epicenter/sync-core';
import { Elysia } from 'elysia';

export { extractBearerToken };

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
