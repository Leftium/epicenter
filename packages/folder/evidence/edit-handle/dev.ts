/**
 * EXPERIMENT launcher for the edit-handle demo. From the repository root:
 *
 *     bun packages/folder/evidence/edit-handle/dev.ts
 *
 * One localhost port: `/api/*` goes to the demo server, everything else to
 * Vite's middleware. The server makes a fresh disposable folder under the OS
 * temp directory and removes it on reset and on exit.
 *
 * The demo toolchain is this directory's own `node_modules`, pinned by its
 * `package.json` and `bun.lock`. It is not a workspace package, and the
 * root manifest and lockfile are not touched.
 */
import { existsSync } from 'node:fs';
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from 'node:http';
import { join, relative } from 'node:path';

const here = import.meta.dir;
if (!existsSync(join(here, 'node_modules', 'vite'))) {
	console.error(
		`The demo toolchain is not installed. From the repository root, run:\n\n  bun install --cwd ${relative(process.cwd(), here) || '.'} --frozen-lockfile\n`,
	);
	process.exit(1);
}

// Loaded after the check above, so a missing toolchain gets that message.
const { createServer: createVite } = await import('vite');
const { demoViteConfig } = await import('./vite-config.js');
const { createDemoServer } = await import('./server.js');

const port = Number(process.env.PORT ?? 5179);
const demo = await createDemoServer();
const vite = await createVite({
	...demoViteConfig(),
	server: { middlewareMode: true },
	appType: 'spa',
});

/** Hand one node request to the demo server's fetch handler and stream its response back. */
async function forward(incoming: IncomingMessage, outgoing: ServerResponse) {
	const chunks: Buffer[] = [];
	for await (const chunk of incoming) chunks.push(chunk as Buffer);
	const method = incoming.method ?? 'GET';
	let response: Response;
	try {
		response = await demo.fetch(
			new Request(new URL(incoming.url ?? '/', `http://localhost:${port}`), {
				method,
				headers: { 'content-type': incoming.headers['content-type'] ?? '' },
				body:
					method === 'GET' || method === 'HEAD'
						? undefined
						: Buffer.concat(chunks),
			}),
		);
	} catch (cause) {
		response = new Response(String(cause), { status: 500 });
	}
	outgoing.writeHead(response.status, Object.fromEntries(response.headers));
	outgoing.flushHeaders();
	if (response.body === null) {
		outgoing.end();
		return;
	}
	const reader = response.body.getReader();
	// An event stream ends when the page goes away.
	outgoing.on('close', () => void reader.cancel());
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			outgoing.write(value);
		}
	} catch {
		// The client left mid-stream.
	}
	outgoing.end();
}

const server = createServer((incoming, outgoing) => {
	if (incoming.url?.startsWith('/api/')) void forward(incoming, outgoing);
	else vite.middlewares(incoming, outgoing);
});
server.listen(port, 'localhost', () => {
	console.log(`Edit handle demo: http://localhost:${port}`);
	console.log(`Disposable folder: ${demo.root}`);
});

async function stop() {
	server.close();
	await vite.close();
	await demo.close();
	process.exit(0);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
