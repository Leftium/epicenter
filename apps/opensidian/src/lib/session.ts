import { createAgentChatState } from '@epicenter/app-shell/agent-chat';
import { createSession } from '@epicenter/svelte/auth';
import { createNodeId } from '@epicenter/workspace';
import {
	composeToolCatalogs,
	createDispatchToolCatalog,
} from '@epicenter/workspace/agent';
import { openOpensidianBrowser } from 'opensidian/browser';
import { auth } from '$platform/auth';
import { DEFAULT_MODEL } from './chat/models';
import {
	buildGlobalSkillsPrompt,
	buildVaultSkillsPrompt,
	OPENSIDIAN_SYSTEM_PROMPT,
} from './chat/system-prompt';
import { searchParams } from './search-params.svelte';
import { createCrossDeviceToolsState } from './state/cross-device-tools.svelte';
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
		const nodeId = createNodeId({ storage: localStorage });
		const opensidian = openOpensidianBrowser({ signedIn, nodeId });
		// The relay floor's home in the browser: this device's own account-room
		// connection (the per-user fleet room the daemon also joins) plus a
		// single-active cross-device tool catalog. Reaching a tool on another of the
		// user's devices rides this, not the in-room dispatch path (ADR-0073).
		const crossDevice = createCrossDeviceToolsState({ ...signedIn, nodeId });
		const editor = createEditorState();
		const files = createFilesState({ workspace: opensidian });
		const paletteSearch = createPaletteSearchState({
			files,
			workspace: opensidian,
		});
		const sidebarSearch = createSidebarSearchState({ workspace: opensidian });
		const terminal = createTerminalState({ files, workspace: opensidian });
		const skills = createSkillState({ workspace: opensidian });
		// Opensidian's own file and bash actions, resolved in-process with no relay.
		const localCatalog = createDispatchToolCatalog(opensidian.collaboration, {
			localActions: opensidian.actions,
		});
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
				// The local in-process catalog plus, when the user has picked one, the
				// cross-device gateway catalog over the relay floor. Local-first so a
				// local action shadows a same-named remote tool. The getter is read live
				// each step, so connecting or disconnecting a device tracks with no
				// re-wiring of the loop.
				toolCatalog: composeToolCatalogs(() => [
					localCatalog,
					...crossDevice.catalogs(),
				]),
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
			crossDevice,
			sampleData,
		};

		void opensidian.idb.whenLoaded.then(() => skills.loadAllSkills());

		return {
			...opensidian,
			state,
			[Symbol.dispose]() {
				// Tear the relay floor down first: its channels and transport ride the
				// account-room socket, so close them before the rest. Async, so
				// fire-and-forget from this sync disposer.
				void crossDevice[Symbol.asyncDispose]();
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
