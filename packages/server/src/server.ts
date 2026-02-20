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
 * - `/workspaces/{id}/sync` - WebSocket sync endpoint (y-websocket protocol)
 *
 * @example
 * ```typescript
 * import { createWorkspace } from '@epicenter/hq/static';
 *
 * const workspace = createWorkspace(definition)
 *   .withExtension('persistence', (ctx) => setupPersistence(ctx))
 *   .withExtension('sqlite', (ctx) => sqliteProvider(ctx));
 *
 * const server = createServer(workspace, { port: 3913 });
 * server.start();
 *
 * // Access endpoints:
 * // GET  http://localhost:3913/workspaces/blog/tables/posts
 * // POST http://localhost:3913/workspaces/blog/tables/posts
 * // WS   ws://localhost:3913/workspaces/blog/sync
 * ```
 */
function createServer(
	client: AnyWorkspaceClient,
	options?: ServerOptions,
): ReturnType<typeof createServerInternal>;
function createServer(
	clients: AnyWorkspaceClient[],
	options?: ServerOptions,
): ReturnType<typeof createServerInternal>;
function createServer(
	clientOrClients: AnyWorkspaceClient | AnyWorkspaceClient[],
	options?: ServerOptions,
): ReturnType<typeof createServerInternal> {
	const clients = Array.isArray(clientOrClients)
		? clientOrClients
		: [clientOrClients];
	return createServerInternal(clients, options);
}

function createServerInternal(
	clients: AnyWorkspaceClient[],
	options?: ServerOptions,
) {
	const workspaces: Record<string, AnyWorkspaceClient> = {};
	for (const client of clients) {
		workspaces[client.id] = client;
	}

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
			createSyncPlugin({
				getDoc: (room) => workspaces[room]?.ydoc,
				auth: options?.auth,
				routePrefix: '/workspaces/:workspaceId/sync',
			}),
		)
		.use(createWorkspacePlugin(clients));

	const port =
		options?.port ??
		Number.parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);

	return {
		app,

		start() {
			console.log('Creating HTTP server...');

			// IMPORTANT: Use app.listen() instead of Bun.serve({ fetch: app.fetch }).
			// Bun.serve() with only `fetch` doesn't pass Elysia's `websocket` handler,
			// so WebSocket upgrades silently fail. app.listen() wires up both HTTP and WS.
			app.listen(port);

			console.log('\nEpicenter HTTP Server Running!\n');
			console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
			console.log(`Server: http://localhost:${port}`);
			console.log(`API Docs: http://localhost:${port}/openapi`);
			console.log(`OpenAPI Spec: http://localhost:${port}/openapi/json\n`);

			console.log('Available Workspaces:\n');
			for (const [workspaceId, client] of Object.entries(workspaces)) {
				console.log(`  ${workspaceId}`);
				for (const tableName of Object.keys(client.definitions.tables)) {
					console.log(`    tables/${tableName}`);
				}
				if (client.actions) {
					const clientActionPaths = collectActionPaths(client.actions);
					for (const actionPath of clientActionPaths) {
						console.log(`    actions/${actionPath}`);
					}
				}
				console.log(`    sync (WebSocket)`);
				console.log();
			}

			console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
			console.log('Server is running. Press Ctrl+C to stop.\n');

			let isShuttingDown = false;

			const shutdown = async (signal: string) => {
				if (isShuttingDown) return;
				isShuttingDown = true;

				console.log(`\nReceived ${signal}, shutting down...`);

				app.stop();
				await Promise.all(clients.map((c) => c.destroy()));

				console.log('Server stopped cleanly\n');
				process.exit(0);
			};

			process.on('SIGINT', () => shutdown('SIGINT'));
			process.on('SIGTERM', () => shutdown('SIGTERM'));

			return app.server;
		},

		async destroy() {
			await Promise.all(clients.map((c) => c.destroy()));
		},
	};
}

export { createServer };
