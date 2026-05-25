/**
 * Node-only runtime configuration: every Epicenter env var and platform
 * path that crosses package boundaries, resolved once at module load.
 *
 * Production env vars are set by the shell or CI before the process starts
 * and do not change. Reading them eagerly matches reality and keeps this
 * module a pure value namespace.
 *
 * Single-consumer paths (daemon socket dir, auth token dir) live in their
 * owning package, not here, so this module stays a cross-package vocabulary.
 */

import envPaths from 'env-paths';
import { EPICENTER_API_URL as DEFAULT_API_URL } from './apps.js';

const paths = envPaths('epicenter', { suffix: '' });

export const epicenterEnv = {
	apiUrl: process.env.EPICENTER_API_URL ?? DEFAULT_API_URL,
	dataDir: process.env.EPICENTER_DATA_DIR ?? paths.data,
	logDir: process.env.EPICENTER_LOG_DIR ?? paths.log,
} as const;
