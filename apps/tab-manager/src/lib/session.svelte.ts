import type { AuthClient } from '@epicenter/auth';
import { requireIdentity } from '@epicenter/auth';
import { createOAuthAppAuth } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import { createSession } from '@epicenter/svelte';
import { actionsToAiTools } from '@epicenter/workspace/ai';
import { EPICENTER_TAB_MANAGER_OAUTH_CLIENT_ID } from '@epicenter/constants/oauth';
import { authSessionStorage, oauthLauncher } from './platform/auth/auth';
import { createAiChatState } from './chat/chat-state.svelte';
import { createPeer, registerDevice } from './device';
import { createBookmarkState } from './state/bookmark-state.svelte';
import { createSavedTabState } from './state/saved-tab-state.svelte';
import { createToolTrustState } from './state/tool-trust.svelte';
import { createUnifiedViewState } from './state/unified-view-state.svelte';
import { openTabManager } from './tab-manager/extension';

export type TabManagerWorkspace = Awaited<ReturnType<typeof openTabManager>>;
export type WorkspaceAiTools = ReturnType<
	typeof actionsToAiTools<TabManagerWorkspace['actions']>
>;

type ReadyTabManagerSession = {
	tabManager: TabManagerWorkspace;
	state: {
		savedTabs: ReturnType<typeof createSavedTabState>;
		bookmarks: ReturnType<typeof createBookmarkState>;
		toolTrust: ReturnType<typeof createToolTrustState>;
		unifiedView: ReturnType<typeof createUnifiedViewState>;
		aiChat: ReturnType<typeof createAiChatState>;
	};
	workspaceAiTools: WorkspaceAiTools;
};

/**
 * Deferred-init values: set exactly once when `authSessionStorage.whenReady`
 * resolves, never reassigned afterwards. They are plain `let`, not `$state`,
 * because nothing needs the assignment itself to drive reactivity; consumers
 * await the `whenReady` promise before reading, and the reactive surfaces
 * (`auth.state`, `workspaceSession.current`) own their own `$state` internally.
 */
let authClient: AuthClient | undefined;
let workspaceSession: ReturnType<typeof createWorkspaceSession> | undefined;

const whenReady = authSessionStorage.whenReady.then(() => {
	authClient = createOAuthAppAuth({
		baseURL: APP_URLS.API,
		clientId: EPICENTER_TAB_MANAGER_OAUTH_CLIENT_ID,
		sessionStorage: authSessionStorage,
		launcher: oauthLauncher,
	});
	workspaceSession = createWorkspaceSession(authClient);
});

function createWorkspaceSession(auth: AuthClient) {
	return createSession({
		auth,
		build: (identity) => {
			const userId = identity.user.id;
			let disposed = false;
			let ready: ReadyTabManagerSession | undefined;
			const whenReady = openTabManager({
				userId,
				peer: createPeer(),
				openWebSocket: auth.openWebSocket,
				encryptionKeys: () => requireIdentity(auth).encryptionKeys,
			}).then((tabManager) => {
				if (disposed) {
					tabManager[Symbol.dispose]();
					return;
				}
				const workspaceAiTools = actionsToAiTools(tabManager.actions);
				const savedTabs = createSavedTabState(tabManager);
				const bookmarks = createBookmarkState(tabManager);
				const toolTrust = createToolTrustState(tabManager);
				const unifiedView = createUnifiedViewState({ bookmarks, savedTabs });
				const aiChat = createAiChatState({
					auth,
					tabManager,
					workspaceAiTools,
				});

				ready = {
					tabManager,
					state: { savedTabs, bookmarks, toolTrust, unifiedView, aiChat },
					workspaceAiTools,
				};
				void tabManager.idb.whenLoaded.then(() => registerDevice(tabManager));
			});

			return {
				userId,
				get whenReady() {
					return whenReady;
				},
				get tabManager() {
					if (!ready) {
						throw new Error(
							'[tab-manager] tabManager read before signed-in session readiness.',
						);
					}
					return ready.tabManager;
				},
				get state() {
					if (!ready) {
						throw new Error(
							'[tab-manager] state read before signed-in session readiness.',
						);
					}
					return ready.state;
				},
				get workspaceAiTools() {
					if (!ready) {
						throw new Error(
							'[tab-manager] workspaceAiTools read before signed-in session readiness.',
						);
					}
					return ready.workspaceAiTools;
				},
				[Symbol.dispose]() {
					disposed = true;
					ready?.state.aiChat[Symbol.dispose]();
					ready?.state.toolTrust[Symbol.dispose]();
					ready?.state.bookmarks[Symbol.dispose]();
					ready?.state.savedTabs[Symbol.dispose]();
					ready?.tabManager[Symbol.dispose]();
				},
			};
		},
	});
}

export type WorkspaceTools = WorkspaceAiTools['tools'];

export const tabManagerSession = {
	get auth(): AuthClient {
		if (!authClient) {
			throw new Error('[tab-manager] auth read before storage readiness.');
		}
		return authClient;
	},
	get current() {
		if (!workspaceSession) {
			throw new Error(
				'[tab-manager] tabManagerSession.current read before storage readiness.',
			);
		}
		return workspaceSession.current;
	},
	whenReady,
	[Symbol.dispose]() {
		workspaceSession?.[Symbol.dispose]();
		authClient?.[Symbol.dispose]();
	},
};

if (import.meta.hot) {
	import.meta.hot.dispose(() => tabManagerSession[Symbol.dispose]());
}

export function requireWorkspace() {
	if (!workspaceSession) {
		throw new Error(
			'[tab-manager] requireWorkspace() called before storage readiness. ' +
				'Components must mount under `{#await tabManagerSession.whenReady}`.',
		);
	}
	return workspaceSession.requireWorkspace();
}

export async function forgetTabManagerDevice(): Promise<void> {
	const workspace = requireWorkspace();
	await workspace.tabManager.wipe();
	window.location.reload();
}
