import { cors } from '@elysiajs/cors';
import { openapi } from '@elysiajs/openapi';
import { createTokenGuardPlugin, listenWithFallback } from '@epicenter/server';
import { createSyncPlugin } from '@epicenter/server/sync';
import type { AnyWorkspaceClient } from '@epicenter/workspace';
import { Elysia } from 'elysia';
import * as Y from 'yjs';
import { createRemoteSessionValidator } from './auth/local-auth';
import { createWorkspacePlugin } from './workspace';
import { collectActionPaths } from './workspace/actions';

/**
 * Auth configuration for the local server.
 *
 * The local server is always a **consumer** of authentication — it never
 * issues sessions or manages user accounts. Compare with {@link RemoteAuthConfig}
 * in `@epicenter/server-remote`, which is the **source** of auth (issuing
 * sessions via Better Auth or accepting a shared token).
 *
 * Three mutually exclusive modes:
 *
 * - **`none`** — No authentication. Relies on CORS origin restrictions
 *   (default: `tauri://localhost`) as the security boundary. Use for the
 *   Tauri sidecar or local development.
 *
 * - **`token`** — A single pre-shared secret, identical to the one configured
 *   on the remote server. Everyone who knows the token can access the local
 *   server. There are no user accounts — all authenticated requests are
 *   treated as the same anonymous identity. Use for enterprise self-hosted
 *   deployments. Pairs with `RemoteAuthConfig.mode: 'token'` on the remote
 *   server — both sides share the same secret.
 *
 * - **`remote`** — Delegates authentication to the remote server by calling
 *   its `GET /auth/get-session` endpoint with the Bearer token. Results are
 *   cached with a configurable TTL. Use when the remote server runs Better
 *   Auth (`RemoteAuthConfig.mode: 'betterAuth'`) and you want per-user
 *   identity on the local server too.
 *
 * @example
 * ```typescript
 * // No auth (Tauri sidecar / development)
 * createLocalServer({ clients: [], auth: { mode: 'none' } })
 *
 * // Shared token (enterprise — matches remote server's token)
 * createLocalServer({ clients, auth: { mode: 'token', token: process.env.EPICENTER_TOKEN! } })
 *
 * // Delegate to remote server (cloud deployment)
 * createLocalServer({ clients, auth: { mode: 'remote', remoteUrl: 'https://remote.example.com' } })
 * ```
 */
export type LocalAuthConfig =
	| {
			/** No authentication — relies on CORS origin restrictions only. */
			mode: 'none';
	  }
	| {
			/**
			 * Pre-shared token authentication.
			 *
			 * The local server compares the Bearer token on each request to this
			 * value. Must match the token configured on the remote server so that
			 * the same credential works across both tiers.
			 */
			mode: 'token';

			/** The pre-shared secret. Typically set via an environment variable. */
			token: string;
	  }
	| {
			/**
			 * Delegate authentication to the remote server.
			 *
			 * The local server calls `{remoteUrl}/auth/get-session` with the
			 * Bearer token and caches the result. Use when the remote server
			 * runs Better Auth and you need per-user identity locally.
			 */
			mode: 'remote';

			/** Remote server URL (e.g. `'https://remote.example.com'`). */
			remoteUrl: string;

			/**
			 * Cache TTL in milliseconds for validated sessions.
			 *
			 * Default: 5 minutes (300000ms). The threat model is local process
			 * isolation — a 5-minute stale window is acceptable for a localhost server.
			 */
			cacheTtlMs?: number;
	  };

export type LocalServerConfig = {
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
	 * Controls how the local server authenticates incoming requests.
	 * Defaults to `{ mode: 'none' }` when omitted (open mode, no auth).
	 *
	 * @see {@link LocalAuthConfig} for the three available modes.
	 */
	auth?: LocalAuthConfig;

	/**
	 * CORS allowed origins.
	 *
	 * Default: `['tauri://localhost']` — only the Tauri webview can call the local server.
	 * Add the remote server origin if it needs to reach it directly.
	 */
	allowedOrigins?: string[];

	/** Sync plugin options (WebSocket rooms, auth, lifecycle hooks). */
	sync?: {
		/**
		 * Custom auth for sync endpoints. When omitted, sync auth is
		 * auto-wired from the top-level `auth` config:
		 * - `none` → no sync auth
		 * - `token` → token comparison
		 * - `remote` → delegates to remote server session validation
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
 * - `token`  → shared {@link createTokenGuardPlugin} from `@epicenter/server`
 * - `remote` → delegates to remote server session validation
 *
 * Separated into its own plugin so the type chain is not broken by conditionals.
 */
function createAuthGuardPlugin(authConfig: LocalAuthConfig) {
	if (authConfig.mode === 'none') return new Elysia();
	if (authConfig.mode === 'token')
		return createTokenGuardPlugin(authConfig.token);

	// mode === 'remote'
	const validateSession = createRemoteSessionValidator({
		remoteUrl: authConfig.remoteUrl,
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
 * Create an Epicenter local server.
 *
 * The local server is the middle tier in the three-tier topology: one sidecar
 * process per device (embedded in the Tauri app or run standalone). It sits
 * between the SPA/webview on the same machine and the shared remote server in the cloud.
 *
 *   Remote Server (cloud)
 *   +-----------------------------------------+
 *   |  Auth, AI proxy, AI streaming, Yjs relay |
 *   +-----------------------------------------+
 *          ^  cross-device Yjs sync (Phase 4)
 *          |  AI requests
 *          |
 *   Local Server (this process, one per device)
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
 * What the local server DOES:
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
 * What the local server does NOT do:
 * - AI streaming: the SPA sends AI requests directly to the remote server's `/ai/chat`
 *   endpoint; the local server is not involved.
 * - Auth issuance: sessions and JWT/JWKS are issued exclusively by the remote
 *   server. The local server only validates tokens — either by comparing a
 *   pre-shared token or by delegating to the remote server's `/auth/get-session`.
 *
 * Two sync scopes:
 * 1. Local relay (always active): SPA <-> local server on the same machine,
 *    via `/rooms/*` WebSocket. Latency is sub-millisecond.
 * 2. Remote server sync (Phase 4, not yet wired): local server <-> remote server,
 *    enabled by the `--remote` flag. Propagates persisted Y.Doc updates across
 *    devices through the remote server's ephemeral Yjs relay.
 *
 * @example
 * ```typescript
 * // No auth (Tauri sidecar / development)
 * createLocalServer({ clients: [] }).start();
 *
 * // Shared token (enterprise self-hosted)
 * createLocalServer({
 *   clients: [blogClient],
 *   auth: { mode: 'token', token: process.env.EPICENTER_TOKEN! },
 * }).start();
 *
 * // Delegate to remote server (cloud deployment)
 * createLocalServer({
 *   clients: [blogClient],
 *   auth: { mode: 'remote', remoteUrl: 'https://remote.example.com' },
 *   allowedOrigins: ['tauri://localhost'],
 * }).start();
 * ```
 */
export function createLocalServer(config: LocalServerConfig) {
	const { clients, sync } = config;

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
				origin: config.allowedOrigins ?? ['tauri://localhost'],
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
		.use(createAuthGuardPlugin(config.auth ?? { mode: 'none' }))
		.use(
			new Elysia({ prefix: '/rooms' }).use(
				createSyncPlugin({
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
			name: 'Epicenter Local',
			version: '1.0.0',
			mode: 'local' as const,
			workspaces: Object.keys(workspaces),
			actions: allActionPaths,
		}))
		.use(
			new Elysia({ prefix: '/workspaces' }).use(createWorkspacePlugin(clients)),
		);

	const preferredPort =
		config.port ?? Number.parseInt(process.env.PORT ?? '3913', 10);

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
			const server = app.server;
			if (!server) {
				throw new Error('Server not available after listen');
			}
			return { ...server, port: actualPort };
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

export type LocalApp = ReturnType<typeof createLocalServer>['app'];
