import { cors } from '@elysiajs/cors';
import { openapi } from '@elysiajs/openapi';
import { createTokenGuardPlugin, listenWithFallback } from '@epicenter/server-elysia';
import { createWsSyncPlugin } from '@epicenter/server-elysia/sync';
import type { AnyWorkspaceClient } from '@epicenter/workspace';
import { Elysia } from 'elysia';
import * as Y from 'yjs';
import { createHubSessionValidator } from './auth/sidecar-auth';
import { createWorkspacePlugin } from './workspace';
import { collectActionPaths } from './workspace/actions';

/**
 * Auth configuration for the sidecar.
 *
 * The sidecar is always a **consumer** of authentication — it never
 * issues sessions or manages user accounts. Compare with {@link HubAuthConfig}
 * in `@epicenter/server-hub`, which is the **source** of auth (issuing
 * sessions via Better Auth or accepting a shared token).
 *
 * Three mutually exclusive modes:
 *
 * - **`none`** — No authentication. Relies on CORS origin restrictions
 *   (default: `tauri://localhost`) as the security boundary. Use for the
 *   Tauri sidecar or local development.
 *
 * - **`token`** — A single pre-shared secret, identical to the one configured
 *   on the hub. Everyone who knows the token can access the sidecar.
 *   There are no user accounts — all authenticated requests are
 *   treated as the same anonymous identity. Use for enterprise self-hosted
 *   deployments. Pairs with `HubAuthConfig.mode: 'token'` on the hub
 *   — both sides share the same secret.
 *
 * - **`remote`** — Delegates authentication to the hub by calling
 *   its `GET /auth/get-session` endpoint with the Bearer token. Results are
 *   cached with a configurable TTL. Use when the hub runs Better
 *   Auth (`HubAuthConfig.mode: 'betterAuth'`) and you want per-user
 *   identity on the sidecar too.
 *
 * @example
 * ```typescript
 * // No auth (Tauri sidecar / development)
 * createSidecar({ clients: [], auth: { mode: 'none' } })
 *
 * // Shared token (enterprise — matches hub's token)
 * createSidecar({ clients, auth: { mode: 'token', token: process.env.EPICENTER_TOKEN! } })
 *
 * // Delegate to hub (cloud deployment)
 * createSidecar({ clients, auth: { mode: 'remote', hubUrl: 'https://hub.example.com' } })
 * ```
 */
export type SidecarAuthConfig =
	| {
			/** No authentication — relies on CORS origin restrictions only. */
			mode: 'none';
	  }
	| {
			/**
			 * Pre-shared token authentication.
			 *
			 * The sidecar compares the Bearer token on each request to this
			 * value. Must match the token configured on the hub so that
			 * the same credential works across both tiers.
			 */
			mode: 'token';

			/** The pre-shared secret. Typically set via an environment variable. */
			token: string;
	  }
	| {
			/**
			 * Delegate authentication to the hub.
			 *
			 * The sidecar calls `{hubUrl}/auth/get-session` with the
			 * Bearer token and caches the result. Use when the hub
			 * runs Better Auth and you need per-user identity locally.
			 */
			mode: 'remote';

			/** Hub URL (e.g. `'https://hub.example.com'`). */
			hubUrl: string;

			/**
			 * Cache TTL in milliseconds for validated sessions.
			 *
			 * Default: 5 minutes (300000ms). The threat model is local process
			 * isolation — a 5-minute stale window is acceptable for a localhost server.
			 */
			cacheTtlMs?: number;
	  };

export type SidecarConfig = {
	/**
	 * Workspace clients to expose via REST CRUD and action endpoints.
	 *
	 * Pass an empty array for a sync-only relay (no workspace routes).
	 * Non-empty arrays mount table and action endpoints under `/workspaces/{id}`.
	 */
	clients: AnyWorkspaceClient[];

	/**
	 * Preferred port to listen on.
	 *
	 * Falls back to the `PORT` environment variable, then 3913.
	 * If the port is taken, the OS assigns an available one.
	 */
	port?: number;

	/**
	 * Authentication mode.
	 *
	 * Controls how the sidecar authenticates incoming requests.
	 * Defaults to `{ mode: 'none' }` when omitted (open mode, no auth).
	 *
	 * @see {@link SidecarAuthConfig} for the three available modes.
	 */
	auth?: SidecarAuthConfig;

	/**
	 * CORS allowed origins.
	 *
	 * Default: `['tauri://localhost']` — only the Tauri webview can call the sidecar.
	 * Add the hub origin if it needs to reach it directly.
	 */
	allowedOrigins?: string[];

	/** Sync plugin options (WebSocket rooms, auth, lifecycle hooks). */
	sync?: {
		/**
		 * Custom auth for sync endpoints. When omitted, sync auth is
		 * auto-wired from the top-level `auth` config:
		 * - `none` → no sync auth
		 * - `token` → token comparison
		 * - `remote` → delegates to hub session validation
		 */
		verifyToken?: (token: string) => boolean | Promise<boolean>;

		/** Called when a new sync room is created on demand. */
		onRoomCreated?: (roomId: string, doc: Y.Doc) => void;

		/** Called when an idle sync room is evicted after all clients disconnect. */
		onRoomEvicted?: (roomId: string, doc: Y.Doc) => void;
	};
};

/**
 * Create an Elysia plugin for auth guard based on the auth config.
 *
 * - `none`   → no-op plugin
 * - `token`  → shared {@link createTokenGuardPlugin} from `@epicenter/server-elysia`
 * - `remote` → delegates to hub session validation
 *
 * Separated into its own plugin so the type chain is not broken by conditionals.
 */
function createAuthGuardPlugin(authConfig: SidecarAuthConfig) {
	if (authConfig.mode === 'none') return new Elysia();
	if (authConfig.mode === 'token')
		return createTokenGuardPlugin(authConfig.token);

	// mode === 'remote'
	const validateSession = createHubSessionValidator({
		hubUrl: authConfig.hubUrl,
		cacheTtlMs: authConfig.cacheTtlMs,
	});
	return new Elysia().onBeforeHandle(
		{ as: 'global' },
		async ({ request, status, path }) => {
			if (path === '/') return;

			const authHeader = request.headers.get('authorization');
			if (!authHeader?.startsWith('Bearer ')) {
				return status(401, 'Unauthorized: Bearer token required');
			}

			const token = authHeader.slice(7);
			const result = await validateSession(token);

			if (!result.valid) {
				return status(401, 'Unauthorized: Invalid session token');
			}
		},
	);
}

/**
 * Create an Epicenter sidecar.
 *
 * The sidecar is the data and execution plane — one process per device
 * (embedded in the Tauri app or run standalone). It sits between the
 * SPA/webview on the same machine and the shared hub in the cloud.
 *
 *   Hub (cloud/self-hosted)
 *   +-----------------------------------------+
 *   |  Auth, AI proxy, AI streaming, Yjs relay |
 *   +-----------------------------------------+
 *          ^  cross-device Yjs sync
 *          |  AI requests
 *          |
 *   Sidecar (this process, one per device)
 *   +-----------------------------------------+
 *   |  - Workspace CRUD (REST + action routes) |
 *   |  - Extensions (filesystem projections)   |
 *   |  - Actions (per-workspace endpoints)     |
 *   |  - Persisted Y.Docs (workspace.yjs file) |
 *   |  - Local Yjs relay (SPA <-> Y.Doc)       |
 *   +-----------------------------------------+
 *          |  sub-ms WebSocket sync (same machine)
 *          v
 *   SPA / WebView (Tauri or browser)
 *
 * What the sidecar DOES:
 * - Workspace CRUD: read/write workspace configs, tables, and blobs (`/workspaces/*`)
 * - Extensions: filesystem projections exposed as workspace tables
 * - Actions: per-workspace HTTP endpoints generated from the workspace schema
 * - Persisted Y.Docs: each workspace's Y.Doc is loaded from and saved to a
 *   `workspace.yjs` file on disk. This is the authoritative source of truth
 *   for that device.
 * - Local Yjs relay: serves the `/rooms/*` WebSocket endpoint so the SPA's
 *   in-memory Y.Doc stays in sync with the server's persisted Y.Doc on the
 *   same machine (sub-millisecond round-trip).
 *
 * What the sidecar does NOT do:
 * - AI streaming: the SPA sends AI requests directly to the hub's `/ai/chat`
 *   endpoint; the sidecar is not involved.
 * - Auth issuance: sessions and JWT/JWKS are issued exclusively by the hub.
 *   The sidecar only validates tokens — either by comparing a pre-shared
 *   token or by delegating to the hub's `/auth/get-session`.
 *
 * @example
 * ```typescript
 * // No auth (Tauri sidecar / development)
 * createSidecar({ clients: [] }).start();
 *
 * // Shared token (enterprise self-hosted)
 * createSidecar({
 *   clients: [blogClient],
 *   auth: { mode: 'token', token: process.env.EPICENTER_TOKEN! },
 * }).start();
 *
 * // Delegate to hub (cloud deployment)
 * createSidecar({
 *   clients: [blogClient],
 *   auth: { mode: 'remote', hubUrl: 'https://hub.example.com' },
 *   allowedOrigins: ['tauri://localhost'],
 * }).start();
 * ```
 */
export function createSidecar({
	clients,
	sync,
	auth,
	allowedOrigins,
	port,
}: SidecarConfig) {
	const workspaces: Record<string, AnyWorkspaceClient> = {};
	for (const client of clients) {
		workspaces[client.id] = client;
	}

	/** Ephemeral Y.Docs for rooms with no pre-registered workspace client. */
	const dynamicDocs = new Map<string, Y.Doc>();

	const allActionPaths = clients.flatMap((client) => {
		if (!client.actions) return [];
		return collectActionPaths(client.actions).map((p) => `${client.id}/${p}`);
	});

	const app = new Elysia()
		.use(
			cors({
				origin: allowedOrigins ?? ['tauri://localhost'],
				credentials: true,
				allowedHeaders: ['Content-Type', 'Authorization'],
			}),
		)
		.use(
			openapi({
				embedSpec: true,
				documentation: {
					info: {
						title: 'Epicenter Sidecar API',
						version: '1.0.0',
						description: 'Sidecar server — local sync relay and workspace API.',
					},
				},
			}),
		)
		.use(createAuthGuardPlugin(auth ?? { mode: 'none' }))
		.use(
			new Elysia({ prefix: '/rooms' }).use(
				createWsSyncPlugin({
					getDoc:
						clients.length > 0
							? (room) => {
									if (workspaces[room]) return workspaces[room].ydoc;

									if (!dynamicDocs.has(room)) {
										dynamicDocs.set(room, new Y.Doc());
									}
									return dynamicDocs.get(room);
								}
							: undefined,
					verifyToken: sync?.verifyToken,
					onRoomCreated: sync?.onRoomCreated,
					onRoomEvicted: sync?.onRoomEvicted,
				}),
			),
		)
		.get('/', () => ({
			name: 'Epicenter Sidecar',
			version: '1.0.0',
			mode: 'sidecar' as const,
			workspaces: Object.keys(workspaces),
			actions: allActionPaths,
		}))
		.use(
			new Elysia({ prefix: '/workspaces' }).use(createWorkspacePlugin(clients)),
		);

	const preferredPort = port ?? Number.parseInt(process.env.PORT ?? '3913', 10);

	return {
		app,

		/**
		 * Start listening on the preferred port, falling back to an OS-assigned
		 * port if it's already taken.
		 *
		 * Does not log or install signal handlers — the caller owns those concerns.
		 */
		start() {
			const actualPort = listenWithFallback(app, preferredPort);
			return { ...app.server!, port: actualPort };
		},

		/**
		 * Stop the HTTP server and destroy all workspace clients.
		 *
		 * Cleans up workspace clients, ephemeral sync documents, and the HTTP listener.
		 */
		async stop() {
			app.stop();
			await Promise.all(clients.map((c) => c.destroy()));
			for (const doc of dynamicDocs.values()) doc.destroy();
			dynamicDocs.clear();
		},
	};
}

export type SidecarApp = ReturnType<typeof createSidecar>['app'];
