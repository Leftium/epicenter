import { requireSignedIn } from '@epicenter/auth';
import { createSession, type InferSignedIn } from '@epicenter/svelte';
import { getOrCreateInstallationId } from '@epicenter/workspace';
import { auth } from '$platform/auth';
import { createAiChatState } from './chat/chat-state.svelte';
import { openOpensidian } from './opensidian/browser';
import { createEditorState } from './state/editor-state.svelte';
import { createFilesState } from './state/files-state.svelte';
import { createPaletteSearchState } from './state/palette-search-state.svelte';
import { createSidebarSearchState } from './state/sidebar-search-state.svelte';
import { createSkillState } from './state/skill-state.svelte';
import { createTerminalState } from './state/terminal-state.svelte';
import { createSampleDataLoader } from './utils/load-sample-data.svelte';

type OpensidianAppState = {
	editor: ReturnType<typeof createEditorState>;
	files: ReturnType<typeof createFilesState>;
	paletteSearch: ReturnType<typeof createPaletteSearchState>;
	sidebarSearch: ReturnType<typeof createSidebarSearchState>;
	terminal: ReturnType<typeof createTerminalState>;
	skills: ReturnType<typeof createSkillState>;
	chat: ReturnType<typeof createAiChatState>;
	sampleData: ReturnType<typeof createSampleDataLoader>;
};

export const session = createSession({
	auth,
	build: (identity) => {
		const userId = identity.user.id;
		const workspace = openOpensidian({
			userId,
			peer: {
				id: getOrCreateInstallationId(localStorage),
				name: 'Opensidian',
				platform: 'web',
			},
			bearerToken: () => auth.bearerToken,
			encryptionKeys: () => requireSignedIn(auth).encryptionKeys,
		});
		const editor = createEditorState();
		const files = createFilesState({ workspace });
		const paletteSearch = createPaletteSearchState({ files, workspace });
		const sidebarSearch = createSidebarSearchState({ workspace });
		const terminal = createTerminalState({ files, workspace });
		const skills = createSkillState({ workspace });
		const chat = createAiChatState({
			auth,
			workspace,
			skills,
		});
		const sampleData = createSampleDataLoader(workspace);
		const state = {
			editor,
			files,
			paletteSearch,
			sidebarSearch,
			terminal,
			skills,
			chat,
			sampleData,
		} satisfies OpensidianAppState;

		return {
			userId,
			workspace,
			state,
			[Symbol.dispose]() {
				chat[Symbol.dispose]();
				skills[Symbol.dispose]();
				sidebarSearch[Symbol.dispose]();
				paletteSearch[Symbol.dispose]();
				files[Symbol.dispose]();
				workspace[Symbol.dispose]();
			},
		};
	},
});

export type OpensidianSignedIn = InferSignedIn<typeof session>;

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
	await current.workspace.wipe();
	window.location.reload();
}
