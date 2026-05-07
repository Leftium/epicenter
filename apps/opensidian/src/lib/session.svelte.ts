import { requireSignedIn } from '@epicenter/auth';
import { createSession, type InferSignedIn } from '@epicenter/svelte';
import { getOrCreateInstallationId } from '@epicenter/workspace';
import { actionsToAiTools } from '@epicenter/workspace/ai';
import { auth } from './auth';
import { createAiChatState } from './chat/chat-state.svelte';
import { openOpensidian } from './opensidian/browser';
import { createFsState } from './state/fs-state.svelte';
import { createSearchState } from './state/search-state.svelte';
import { createSidebarSearchState } from './state/sidebar-search-state.svelte';
import { createSkillState } from './state/skill-state.svelte';
import { createTerminalState } from './state/terminal-state.svelte';
import { createSampleDataLoader } from './utils/load-sample-data.svelte';

export type OpensidianWorkspace = ReturnType<typeof openOpensidian>;
export type WorkspaceAiTools = ReturnType<
	typeof actionsToAiTools<OpensidianWorkspace['actions']>
>;

type OpensidianSignedInPayload = OpensidianWorkspace & {
	state: {
		fs: ReturnType<typeof createFsState>;
		search: ReturnType<typeof createSearchState>;
		sidebarSearch: ReturnType<typeof createSidebarSearchState>;
		terminal: ReturnType<typeof createTerminalState>;
		skills: ReturnType<typeof createSkillState>;
		chat: ReturnType<typeof createAiChatState>;
		sampleData: ReturnType<typeof createSampleDataLoader>;
	};
};

export const session = createSession({
	auth,
	build: (identity) => {
		const userId = identity.user.id;
		const opensidian = openOpensidian({
			userId,
			peer: {
				id: getOrCreateInstallationId(localStorage),
				name: 'Opensidian',
				platform: 'web',
			},
			bearerToken: () => auth.bearerToken,
			encryptionKeys: () => requireSignedIn(auth).encryptionKeys,
		});
		const workspaceAiTools = actionsToAiTools(opensidian.actions);
		const fs = createFsState({ opensidian });
		const search = createSearchState({ fs, opensidian });
		const sidebarSearch = createSidebarSearchState({ opensidian });
		const terminal = createTerminalState({ fs, opensidian });
		const skills = createSkillState({ opensidian });
		const chat = createAiChatState({
			auth,
			opensidian,
			skills,
			workspaceAiTools,
		});
		const sampleData = createSampleDataLoader(opensidian);

		return {
			userId,
			opensidian: Object.assign(opensidian, {
				state: {
					fs,
					search,
					sidebarSearch,
					terminal,
					skills,
					chat,
					sampleData,
				},
			}) satisfies OpensidianSignedInPayload,
			workspaceAiTools,
			[Symbol.dispose]() {
				chat[Symbol.dispose]();
				skills[Symbol.dispose]();
				sidebarSearch[Symbol.dispose]();
				search[Symbol.dispose]();
				fs[Symbol.dispose]();
				opensidian[Symbol.dispose]();
			},
		};
	},
});

export type OpensidianSignedIn = InferSignedIn<typeof session>;
export type WorkspaceTools = OpensidianSignedIn['workspaceAiTools']['tools'];

if (import.meta.hot) {
	import.meta.hot.dispose(() => session[Symbol.dispose]());
}

/**
 * Returns the live signed-in session for this app.
 *
 * Throws if invoked outside the signed-in branch. The typical caller is a
 * route or component mounted under the layout's signed-in gate.
 */
export function getSignedInSession(): OpensidianSignedIn {
	const c = session.current;
	if (c.status !== 'signed-in') {
		throw new Error(
			'[opensidian] getSignedInSession() called outside the signed-in branch. ' +
				'This indicates a route or component mounted without the layout gate, ' +
				'or a callback firing after the workspace was disposed.',
		);
	}
	return c.signedIn;
}

export async function forgetOpensidianDevice(): Promise<void> {
	const current = getSignedInSession();
	await current.opensidian.wipe();
	window.location.reload();
}
