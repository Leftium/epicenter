/**
 * EVIDENCE launcher: the browser-folder OPFS acceptance page. From the
 * repository root:
 *
 *     bun packages/folder/evidence/opfs/serve.ts            # serve on 127.0.0.1:5181
 *     bun packages/folder/evidence/opfs/serve.ts --build    # compile check only
 *
 * The page opens folders through the production browser opener in this
 * origin's real OPFS and IndexedDB, under `Epicenter Dev/local/opfs-evidence-*`
 * and matching IndexedDB names, and removes them when it finishes. It uses
 * its own port, so no application origin's storage is touched. It needs local
 * port binding; `--build` does not.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, createServer, type InlineConfig } from 'vite';

const here = import.meta.dir;
const repository = join(here, '..', '..', '..', '..');

const config: InlineConfig = {
	configFile: false,
	root: here,
	server: {
		host: '127.0.0.1',
		port: Number(process.env.PORT ?? 5181),
		strictPort: true,
		fs: { allow: [repository] },
	},
	build: {
		outDir: join(tmpdir(), 'epicenter-folder-opfs-evidence'),
		emptyOutDir: true,
		target: 'esnext',
		rollupOptions: {
			input: { main: join(here, 'index.html'), peer: join(here, 'peer.html') },
		},
	},
	logLevel: 'info',
};

if (process.argv.includes('--build')) {
	await build(config);
} else {
	const server = await createServer(config);
	await server.listen();
	server.printUrls();
	const stop = async () => {
		await server.close();
		process.exit(0);
	};
	process.on('SIGINT', () => void stop());
	process.on('SIGTERM', () => void stop());
}
