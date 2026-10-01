/**
 * Serve the Capture folder bridge over a real directory on a loopback port,
 * the way the Epicenter host mounts it, for checking the desktop build by
 * hand before the host integration exists.
 *
 *   bun apps/capture/scripts/native-harness.ts <directory> [port]
 *
 * It answers `/_epicenter/capture/*` from the bridge and serves the files
 * built by `bun run --cwd apps/capture build:epicenter` below `/apps/capture/`.
 * Open http://127.0.0.1:<port>/apps/capture/ in a browser. That window is not
 * inside the desktop shell, so the page says quitting cannot ask it first;
 * everything about files, saving, conflicts, and history is the real thing.
 *
 * There is no session check here. The real host puts its browser session and
 * Origin checks in front of the bridge; do not expose this port.
 */
import { join } from 'node:path';
import { createCaptureBridge } from '../native/index.js';
import { BRIDGE_PATH } from '../src/lib/bridge/contract.js';

const [directory, port = '5199'] = process.argv.slice(2);
if (directory === undefined) {
	console.error(
		'Usage: bun apps/capture/scripts/native-harness.ts <directory> [port]',
	);
	process.exit(2);
}

const dist = join(import.meta.dir, '../../epicenter/dist/capture');
const bridge = createCaptureBridge({ root: directory });
const server = Bun.serve({
	hostname: '127.0.0.1',
	port: Number(port),
	async fetch(request) {
		const { pathname } = new URL(request.url);
		if (pathname.startsWith(`${BRIDGE_PATH}/`)) return bridge.fetch(request);
		if (!pathname.startsWith('/apps/capture/'))
			return Response.redirect('/apps/capture/', 302);
		const asset = Bun.file(join(dist, pathname.slice('/apps/capture/'.length)));
		if (pathname.includes('/_app/') && (await asset.exists()))
			return new Response(asset);
		return new Response(Bun.file(join(dist, 'index.html')));
	},
});
console.log(`Capture bridge over ${directory}`);
console.log(`Open ${server.url}apps/capture/`);

for (const signal of ['SIGINT', 'SIGTERM'] as const)
	process.on(signal, async () => {
		await server.stop(true);
		// Lets admitted saves and their commits finish before the lock is released.
		await bridge.close();
		process.exit(0);
	});
