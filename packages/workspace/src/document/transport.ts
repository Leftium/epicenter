/** Convert an HTTP(S) URL string to the matching WS(S) URL string. */
function websocketUrl(url: string): string {
	return url.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

/**
 * Build the WebSocket URL for a hosted room.
 *
 * Strips trailing slashes from `apiUrl` so callers can pass either
 * `https://api.example.com` or `https://api.example.com/`. `roomId` is
 * `encodeURIComponent`-encoded so ids containing `/`, `?`, or `#`
 * round-trip safely; Hono decodes the `:room` path param at the server.
 */
export function roomWsUrl(apiUrl: string, roomId: string): string {
	const base = apiUrl.replace(/\/+$/, '');
	return websocketUrl(`${base}/rooms/${encodeURIComponent(roomId)}`);
}

/**
 * Build the WebSocket URL for a Cloud Workspace app document under an
 * explicit `workspaceId`.
 *
 * Use this when the caller already owns a workspaceId (for example, the
 * daemon path reads its workspace from local config). For the typical
 * browser-app path where the authenticated user has a single default
 * workspace, prefer {@link defaultWorkspaceAppDocWsUrl}: the server resolves
 * the workspaceId from the auth token, so the client never names one.
 *
 * `docId = "root"` is the conventional app entry document. The API route
 * treats it like any other app-owned document id after Workspace membership
 * has been checked.
 */
export function workspaceAppDocWsUrl(
	apiUrl: string,
	params: {
		workspaceId: string;
		appId: string;
		docId: string;
	},
): string {
	const base = apiUrl.replace(/\/+$/, '');
	return websocketUrl(
		`${base}/workspaces/${encodeURIComponent(params.workspaceId)}` +
			`/apps/${encodeURIComponent(params.appId)}` +
			`/docs/${encodeURIComponent(params.docId)}`,
	);
}

/**
 * Build the WebSocket URL for the authenticated user's default-workspace
 * app document.
 *
 * Targets the `/me/apps/:appId/docs/:docId` route family. The server
 * resolves which workspaceId to use from the bearer token (the user's
 * default workspace); the client never embeds one in the URL. If the user
 * has no default workspace, the server closes the WebSocket with a
 * permanent-failure reason and the sync supervisor parks in `failed`.
 *
 * Use {@link workspaceAppDocWsUrl} instead when the caller already owns a
 * workspaceId (for example, the daemon path).
 *
 * `docId = "root"` is the conventional app entry document.
 */
export function defaultWorkspaceAppDocWsUrl(
	apiUrl: string,
	params: {
		appId: string;
		docId: string;
	},
): string {
	const base = apiUrl.replace(/\/+$/, '');
	return websocketUrl(
		`${base}/me/apps/${encodeURIComponent(params.appId)}` +
			`/docs/${encodeURIComponent(params.docId)}`,
	);
}
