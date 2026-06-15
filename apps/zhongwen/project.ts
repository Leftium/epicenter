/**
 * Zhongwen project mount.
 *
 * `zhongwen()` returns the `Mount` that a project's `epicenter.config.ts`
 * default-exports. Zhongwen has no daemon actions and no materializers today;
 * the daemon's only job is to host the Y.Doc on disk and bridge
 * sync.
 */

import { defineWorkspace } from '@epicenter/workspace';
import { defineSessionMount } from '@epicenter/workspace/daemon';
import { attachMountInfrastructure } from '@epicenter/workspace/node';
import { createZhongwen } from './zhongwen.js';

export type ZhongwenMountOptions = {
	/**
	 * Base URL of the Epicenter cloud API used for sync.
	 * Defaults to `process.env.EPICENTER_API_URL`, falling back to the hosted API.
	 */
	baseURL?: string;
};

/**
 * Mount Zhongwen in an Epicenter project daemon.
 *
 * The daemon hosts the root Y.Doc and sync bridge. Browser-only
 * transcript docs stay in `openZhongwenBrowser()`.
 */
export function zhongwen(opts: ZhongwenMountOptions = {}) {
	return defineSessionMount({
		name: 'zhongwen',
		open(ctx) {
			const baseURL =
				opts.baseURL ||
				process.env.EPICENTER_API_URL ||
				'https://api.epicenter.so';

			const workspace = createZhongwen();

			const infrastructure = attachMountInfrastructure(workspace.ydoc, ctx, {
				baseURL,
				actions: workspace.actions,
			});

			return defineWorkspace({
				...workspace,
				...infrastructure,
			});
		},
	});
}
