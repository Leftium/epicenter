/**
 * Required scope for any route under the protected resource boundary
 * (`/ai/*`, `/workspaces/*`, `/documents/*`, `/api/billing/*`,
 * `/api/assets/*`). The workspace-identity endpoint enforces it for
 * key release; protected resource middleware enforces it before the
 * route handler runs.
 */
export const WORKSPACES_OPEN_SCOPE = 'workspaces:open';

/**
 * Read the `scope` claim from a verified access-token payload and
 * check whether the required scope is present. Treats anything that
 * is not a space-separated string of scopes as "no scopes granted".
 */
export function hasScope(payload: unknown, required: string): boolean {
	if (payload === null || typeof payload !== 'object') return false;
	const raw = (payload as { scope?: unknown }).scope;
	if (typeof raw !== 'string') return false;
	return raw.split(/\s+/).filter(Boolean).includes(required);
}
