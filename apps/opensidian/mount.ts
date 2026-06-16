/**
 * Opensidian mount.
 *
 * `opensidian()` returns the `Mount` that an `epicenter.config.ts`
 * default-exports.
 *
 * The shared workspace currently exposes no daemon actions and no materializers,
 * so `.mount()` runs with no `compose` and serves the workspace's base actions.
 * Opensidian's file and shell actions need browser services (Yjs filesystem,
 * in-browser SQLite, just-bash) and are added only by the browser runtime.
 */

import { nodeMountRuntime } from '@epicenter/workspace/node';
import { opensidianWorkspace } from './opensidian.js';

export type OpensidianMountOptions = {
	/**
	 * Base URL of the Epicenter cloud API used for sync.
	 * Defaults to `process.env.EPICENTER_API_URL`, falling back to the hosted API.
	 */
	baseURL?: string;
};

export function opensidian(opts: OpensidianMountOptions = {}) {
	return opensidianWorkspace.mount({
		baseURL: opts.baseURL,
		runtime: nodeMountRuntime(),
	});
}
