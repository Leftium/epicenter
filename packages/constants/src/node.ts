/**
 * Node-only runtime configuration: every Epicenter env var and platform
 * path, resolved through one named singleton.
 *
 * Most fields are eager. They read `process.env` and the env-paths defaults
 * once at module load, which matches how production runs: env vars are set
 * by the shell or CI before the process starts and do not change.
 *
 * `runtimeDir` is the one lazy getter. The in-process tests in
 * `packages/cli/src/commands/up.test.ts` mutate `XDG_RUNTIME_DIR` between
 * tests to give each test its own socket directory, and that mutation has
 * to be visible at access time. Production callers see the same value
 * either way because they read it once at boot.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import envPaths from 'env-paths';
import { EPICENTER_API_URL as DEFAULT_API_URL } from './apps.js';

const paths = envPaths('epicenter', { suffix: '' });

export const epicenterEnv = {
	apiUrl: process.env.EPICENTER_API_URL ?? DEFAULT_API_URL,
	dataDir: process.env.EPICENTER_DATA_DIR ?? paths.data,
	logDir: process.env.EPICENTER_LOG_DIR ?? paths.log,
	get runtimeDir(): string {
		return join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), 'epicenter');
	},
} as const;
