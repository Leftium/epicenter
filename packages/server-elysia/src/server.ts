export const DEFAULT_PORT = 3913;

/**
 * Try to listen on the preferred port. If it's taken, let the OS pick one (port 0).
 *
 * Returns the actual port the server is listening on.
 */
export function listenWithFallback(
	app: { listen: (port: number) => void; server: { port?: number } | null },
	preferredPort: number,
): number {
	try {
		app.listen(preferredPort);
	} catch {
		app.listen(0);
	}
	const port = app.server?.port;
	if (port === undefined) {
		throw new Error('Server port is not available after listen');
	}
	return port;
}
