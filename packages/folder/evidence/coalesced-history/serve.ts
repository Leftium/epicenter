/** Run from the repository root: bun packages/folder/evidence/coalesced-history/serve.ts. */
import { createServer } from 'vite';

const server = await createServer({
	configFile: false,
	root: import.meta.dir,
	server: {
		host: '127.0.0.1',
		port: 5197,
		strictPort: true,
		fs: { allow: [`${import.meta.dir}/../../../..`] },
	},
	esbuild: { target: 'esnext' },
});
await server.listen();
server.printUrls();
