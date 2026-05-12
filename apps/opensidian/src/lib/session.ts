import { requireIdentity } from '@epicenter/auth';
import { createSession } from '@epicenter/svelte';
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
	name: 'opensidian',
	build: (identity) => {
		const userId = identity.user.id;
		const opensidian = openOpensidian({
			userId,
			peer: {
				id: getOrCreateInstallationId(localStorage),
				name: 'Opensidian',
				platform: 'web',
			},
			openWebSocket: auth.openWebSocket,
			encryptionKeys: () => requireIdentity(auth).encryptionKeys,
		});
		const editor = createEditorState();
		const files = createFilesState({ workspace: opensidian });
		const paletteSearch = createPaletteSearchState({
			files,
			workspace: opensidian,
		});
		const sidebarSearch = createSidebarSearchState({ workspace: opensidian });
		const terminal = createTerminalState({ files, workspace: opensidian });
		const skills = createSkillState({ workspace: opensidian });
		const chat = createAiChatState({
			auth,
			workspace: opensidian,
			skills,
		});
		const sampleData = createSampleDataLoader(opensidian);
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
			opensidian,
			state,
			[Symbol.dispose]() {
				chat[Symbol.dispose]();
				skills[Symbol.dispose]();
				sidebarSearch[Symbol.dispose]();
				paletteSearch[Symbol.dispose]();
				files[Symbol.dispose]();
				opensidian[Symbol.dispose]();
			},
		};
	},
});

export const { requireWorkspace } = session;

if (import.meta.hot) {
	import.meta.hot.dispose(() => session[Symbol.dispose]());
}

export async function forgetOpensidianDevice(): Promise<void> {
	const workspace = requireWorkspace();
	await workspace.opensidian.wipe();
	window.location.reload();
}
