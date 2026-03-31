/** @module @epicenter/cli — Public API for the Epicenter CLI package. */

export { createCLI } from './cli';
export { type DiscoveredWorkspace } from './commands/workspace-command';
export { createAuthApi, type AuthApi } from './auth/api';
export { cacheDir, resolveEpicenterHome, workspacesDir } from './util/paths';
export { loadConfig, type LoadConfigResult } from './config/load-config';
