import { openapi } from '@elysiajs/openapi';
import type { AnyWorkspaceClient } from '@epicenter/hq/static';
import { Elysia } from 'elysia';
import { collectActionPaths } from './actions';
import type { AuthConfig } from './sync/auth';
import { createSyncPlugin } from './sync/plugin';
import { createWorkspacePlugin } from './workspace-plugin';

export const DEFAULT_PORT = 3913;

export type ServerOptions = {
	port?: number;
	/** Auth configuration passed through to the sync plugin. */
	auth?: AuthConfig;
};

/**
 * Create an HTTP server that exposes workspace clients as REST APIs and WebSocket sync.
 *
 * The server provides:
 * - `/` - API root with discovery info
 * - `/openapi` - Interactive API documentation (Scalar UI)
 * - `/openapi/json` - OpenAPI specification
 * - `/workspaces/{id}/tables/{table}` - RESTful table CRUD endpoints
 * - `/workspaces/{id}/actions/{action}` - Workspace action endpoints (queries via GET, mutations via POST)
 * - `/workspaces/{id}/ws` - WebSocket sync endpoint (y-websocket protocol)
 *
 * @example
 * ```typescript
 * import { createServer } from '@epicenter/server';
 *
 * const server = createServer(workspace, { port: 3913 });
 * server.start();
 *
 * // Later:
 * await server.stop();
 * ```
 */
export function createServer(
	clientOrClients: AnyWorkspaceClient | AnyWorkspaceClient[],
	options?: ServerOptions,
) {
	const clients = Array.isArray(clientOrClients)
		? clientOrClients
		: [clientOrClients];
	const workspaces: Record<string, AnyWorkspaceClient> = {};
	for (const client of clients) {
		workspaces[client.id] = client;
	}

	const allActionPaths = clients.flatMap((client) => {
		if (!client.actions) return [];
		return collectActionPaths(client.actions).map((p) => `${client.id}/${p}`);
	});

	const app = new Elysia()
		.use(
			openapi({
				embedSpec: true,
				documentation: {
					info: {
						title: 'Epicenter API',
						version: '1.0.0',
						description: 'API documentation for Epicenter workspaces',
					},
				},
			}),
		)
		.use(
			new Elysia({ prefix: '/workspaces' }).use(
				createSyncPlugin({
					getDoc: (room) => workspaces[room]?.ydoc,
					auth: options?.auth,
				}),
			),
		)
		.use(createWorkspacePlugin(clients))
		.get('/', () => ({
			name: 'Epicenter API',
			version: '1.0.0',
			workspaces: Object.keys(workspaces),
			actions: allActionPaths,
		}));

	const port =
		options?.port ??
		Number.parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);

	return {
		app,

		/**
		 * Start listening on the configured port.
		 *
		 * Does not log or install signal handlers — the caller owns those concerns.
		 */
		start() {
			app.listen(port);
			return app.server;
		},

		/**
		 * Stop the HTTP server and destroy all workspace clients.
		 */
		async stop() {
			app.stop();
			await Promise.all(clients.map((c) => c.destroy()));
		},
	};
}
