/**
 * Zhongwen project mount.
 *
 * `zhongwen()` returns the `Mount` that a project's `epicenter.config.ts`
 * default-exports. Zhongwen has no daemon actions and no materializers today;
 * the daemon's only job is to host the encrypted Y.Doc on disk and bridge
 * sync.
 */

import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { defineWorkspace } from '@epicenter/workspace';
import { defineSessionMount } from '@epicenter/workspace/daemon';
import { attachMountInfrastructure } from '@epicenter/workspace/node';
import { createZhongwen } from './zhongwen.js';

export function zhongwen() {
	return defineSessionMount({
		name: 'zhongwen',
		open(ctx) {
			const workspace = createZhongwen({ keyring: ctx.session.keyring });

			const infrastructure = attachMountInfrastructure(workspace.ydoc, ctx, {
				baseURL: EPICENTER_API_URL,
				actions: workspace.actions,
			});

			return defineWorkspace({
				...workspace,
				...infrastructure,
			});
		},
	});
}

export type ZhongwenMount = ReturnType<typeof zhongwen>;
