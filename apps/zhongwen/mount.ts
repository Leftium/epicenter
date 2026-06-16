/**
 * Zhongwen mount.
 *
 * `zhongwen()` returns the `Mount` that an `epicenter.config.ts`
 * default-exports. Zhongwen has no daemon actions to add and no materializers;
 * the daemon's only job is to host the root Y.Doc on disk and bridge cloud
 * sync, so `.mount()` runs with no `compose` and serves the workspace's base
 * actions. Transcript child docs are opened on demand by browser UI or server
 * generation actors.
 */

import { nodeMountRuntime } from '@epicenter/workspace/node';
import { zhongwenWorkspace } from './zhongwen.js';

export type ZhongwenMountOptions = {
	/**
	 * Base URL of the Epicenter cloud API used for sync.
	 * Defaults to `process.env.EPICENTER_API_URL`, falling back to the hosted API.
	 */
	baseURL?: string;
};

export function zhongwen(opts: ZhongwenMountOptions = {}) {
	return zhongwenWorkspace.mount({
		baseURL: opts.baseURL,
		runtime: nodeMountRuntime(),
	});
}
