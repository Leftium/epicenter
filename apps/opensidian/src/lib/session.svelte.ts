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

if (import.meta.hot) {
	import.meta.hot.dispose(() => session[Symbol.dispose]());
}

/**
 * Returns the live workspace payload for this app.
 *
 * Throws when `session.current` is null (no authenticated identity). The
 * typical caller is a route or component mounted under the layout's
 * `{#if current}` gate. The return type is inferred from the `createSession`
 * build factory above; the pre-existing `OpensidianWorkspace` type in
 * `$lib/opensidian/browser` refers to the doc handle (one level deeper).
 */
export function requireWorkspace() {
	const c = session.current;
	if (!c) {
		throw new Error(
			'[opensidian] requireWorkspace() called without an authenticated session. ' +
				'This indicates a route or component mounted without the layout gate, ' +
				'or a callback firing after the workspace was disposed.',
		);
	}
	return c.workspace;
}

export async function forgetOpensidianDevice(): Promise<void> {
	const current = requireWorkspace();
	await current.opensidian.wipe();
	window.location.reload();
}
