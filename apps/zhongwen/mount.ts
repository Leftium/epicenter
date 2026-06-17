/**
 * Zhongwen mount.
 *
 * `zhongwen()` returns the `Mount` that an `epicenter.config.ts`
 * default-exports. Zhongwen has no daemon actions to add and no materializers,
 * so the daemon hosts the root Y.Doc on disk and bridges cloud sync, then runs
 * one child-doc actor: an always-on observe loop (ADR-0012/0013) over the
 * `conversations.messages` transcripts. Registering the field is all the app
 * declares; the table, the guid, and the layout come from the schema. The
 * factory is the behavior seam: V0.3 fills `onChange` with claim -> stream ->
 * finish, so for now it just hosts and observes.
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

export function zhongwen({ baseURL }: ZhongwenMountOptions = {}) {
	return zhongwenWorkspace.mount({
		baseURL,
		runtime: nodeMountRuntime(),
		actors: {
			conversations: {
				// V0.3 returns { onChange } here to claim the unanswered turn and
				// stream the reply into the transcript handle.
				messages: () => ({}),
			},
		},
	});
}
