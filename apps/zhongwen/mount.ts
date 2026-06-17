/**
 * Zhongwen mount.
 *
 * `zhongwen()` returns the `Mount` that an `epicenter.config.ts`
 * default-exports. Zhongwen has no daemon actions to add and no materializers,
 * so the daemon hosts the root Y.Doc on disk and bridges cloud sync, then runs
 * the child-doc observe loop: an always-on actor (ADR-0012/0013) that hosts a
 * live replica of every conversation's transcript child doc and watches it. The
 * actor is where the doc-as-wire generation will claim and stream (V0.3); for
 * now it proves the observe loop (open + observe + dispose on row removal).
 */

import { attachChatTranscript } from '@epicenter/workspace/ai';
import {
	attachMountChildDocActor,
	nodeMountRuntime,
} from '@epicenter/workspace/node';
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
		compose({ workspace, scope }) {
			const { conversations } = workspace.tables;
			attachMountChildDocActor(scope, {
				rootDoc: workspace.ydoc,
				table: conversations,
				guidFor: conversations.docs.messages.guid,
				layout: attachChatTranscript,
			});
			return { actions: workspace.actions };
		},
	});
}
