import { createAgentChatState } from '@epicenter/app-shell/agent-chat';
import { createSession } from '@epicenter/svelte/auth';
import { createNodeId } from '@epicenter/workspace';
import { createDispatchToolCatalog } from '@epicenter/workspace/agent';
import { openOpensidianBrowser } from 'opensidian/browser';
import { auth } from '$platform/auth';
import { DEFAULT_MODEL } from './chat/models';
import {
	buildGlobalSkillsPrompt,
	buildVaultSkillsPrompt,
	OPENSIDIAN_SYSTEM_PROMPT,
} from './chat/system-prompt';
import { searchParams } from './search-params.svelte';
import { createEditorState } from './state/editor-state.svelte';
import { createFilesState } from './state/files-state.svelte';
import { inferenceConnections } from './state/inference-connections.svelte';
import { createPaletteSearchState } from './state/palette-search-state.svelte';
import { createSidebarSearchState } from './state/sidebar-search-state.svelte';
import { createSkillState } from './state/skill-state.svelte';
import { createTerminalState } from './state/terminal-state.svelte';
import { createSampleDataLoader } from './utils/load-sample-data.svelte';

export const session = createSession({
	auth,
	build: (signedIn) => {
		const opensidian = openOpensidianBrowser({
			signedIn,
			nodeId: createNodeId({ storage: localStorage }),
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
		// The shared chat registry (ADR-0047/0059) with opensidian's variation
		// injected: layered vault/global skill prompts read per turn, its in-process
		// file and bash actions as the tool surface, and the URL (`?chat=`) as the
		// active-conversation source. Default approval (query runs, mutation asks).
		const chat = createAgentChatState({
			table: opensidian.tables.conversations,
			whenLoaded: opensidian.idb.whenLoaded,
			connections: inferenceConnections,
			activeConversation: {
				get current() {
					return searchParams.chat;
				},
				select(id) {
					searchParams.update({ chat: id });
				},
			},
			agent: {
				buildSystemPrompts: () =>
					[
						OPENSIDIAN_SYSTEM_PROMPT,
						buildGlobalSkillsPrompt(
							skills.globalSkills.map((skill) => ({
								name: skill.name,
								instructions: skill.instructions,
							})),
						),
						buildVaultSkillsPrompt(
							skills.vaultSkills.map((skill) => ({
								name: skill.name,
								content: skill.content,
							})),
						),
					].filter(Boolean),
				defaultModel: DEFAULT_MODEL,
				toolCatalog: createDispatchToolCatalog(opensidian.collaboration, {
					localActions: opensidian.actions,
				}),
			},
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
		};

		void opensidian.idb.whenLoaded.then(() => skills.loadAllSkills());

		return {
			...opensidian,
			state,
			[Symbol.dispose]() {
				chat[Symbol.dispose]();
				skills[Symbol.dispose]();
				sidebarSearch[Symbol.dispose]();
				paletteSearch[Symbol.dispose]();
				opensidian[Symbol.dispose]();
			},
		};
	},
});

export const requireOpensidian = session.require;

if (import.meta.hot) {
	import.meta.hot.dispose(() => session[Symbol.dispose]());
}
