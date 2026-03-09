import type { Hono } from 'hono';

export const DEFAULT_PORT = 3913;

/**
 * Start a Hono app with Bun.serve, trying the preferred port first.
 * Falls back to port 0 (OS-assigned) if the preferred port is taken.
 */
export function serve(
	app: Hono,
	preferredPort: number,
	websocket?: Record<string, unknown>,
): { server: ReturnType<typeof Bun.serve>; port: number } {
	function start(port: number) {
		// biome-ignore lint/suspicious/noExplicitAny: Bun.serve overload types are complex
		const options: any = { port, fetch: app.fetch };
		if (websocket) options.websocket = websocket;
		return Bun.serve(options);
	}

	let server: ReturnType<typeof Bun.serve>;
	try {
		server = start(preferredPort);
	} catch {
		server = start(0);
	}

	const port = server.port;
	if (port === undefined) {
		throw new Error('Server port is not available after listen');
	}
	return { server, port };
}
