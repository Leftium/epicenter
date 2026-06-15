/**
 * Opensidian project mount.
 *
 * `opensidian()` returns the `Mount` that a project's `epicenter.config.ts`
 * default-exports.
 *
 * The shared workspace currently exposes no daemon actions. Opensidian's file
 * and shell actions need browser services (Yjs filesystem, in-browser SQLite,
 * just-bash) and are added only by the browser runtime.
 */

import { defineWorkspaceBundle } from '@epicenter/workspace';
import { defineSessionMount } from '@epicenter/workspace/daemon';
import { attachMountInfrastructure } from '@epicenter/workspace/node';
import { opensidianWorkspace } from './opensidian.js';

export type OpensidianMountOptions = {
	/**
	 * Base URL of the Epicenter cloud API used for sync.
	 * Defaults to `process.env.EPICENTER_API_URL`, falling back to the hosted API.
	 */
	baseURL?: string;
};

export function opensidian(opts: OpensidianMountOptions = {}) {
	return defineSessionMount({
		name: 'opensidian',
		open(ctx) {
			const baseURL =
				opts.baseURL ||
				process.env.EPICENTER_API_URL ||
				'https://api.epicenter.so';

			const workspace = opensidianWorkspace.open();

			const infrastructure = attachMountInfrastructure(workspace.ydoc, ctx, {
				baseURL,
				actions: workspace.actions,
			});

			return defineWorkspaceBundle({
				...workspace,
				...infrastructure,
			});
		},
	});
}
