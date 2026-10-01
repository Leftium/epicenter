import { fileURLToPath } from 'node:url';
import { APPS } from '@epicenter/constants/apps';
import { workspaceAppViteConfig } from '@epicenter/vite-config';
import { defaultClientConditions, defineConfig, mergeConfig } from 'vite';

/** The build the Epicenter desktop host serves below `/apps/capture/`. */
const isEpicenterHost = process.env.EPICENTER_HOST === '1';

export default defineConfig(
	mergeConfig(workspaceAppViteConfig(APPS.CAPTURE), {
		resolve: {
			// Build-time selection over `#platform/*` in package.json "imports".
			// The spread is load-bearing: custom conditions REPLACE Vite's defaults.
			...(isEpicenterHost && {
				conditions: ['epicenter-host', ...defaultClientConditions],
			}),
			alias: {
				// isomorphic-git and its SHA-1 dependency expect Node's Buffer.
				buffer: fileURLToPath(import.meta.resolve('buffer/')),
			},
		},
		optimizeDeps: { include: ['buffer'] },
	}),
);
