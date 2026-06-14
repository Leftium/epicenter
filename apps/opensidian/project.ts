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

import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { defineWorkspace } from '@epicenter/workspace';
import { defineSessionMount } from '@epicenter/workspace/daemon';
import { attachMountInfrastructure } from '@epicenter/workspace/node';
import { createOpensidian } from './opensidian.js';

export function opensidian() {
	return defineSessionMount({
		name: 'opensidian',
		open(ctx) {
			const workspace = createOpensidian({ keyring: ctx.session.keyring });

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

export type OpensidianMount = ReturnType<typeof opensidian>;
