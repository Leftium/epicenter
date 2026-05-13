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

export type TabManagerBinding = Awaited<ReturnType<typeof openTabManager>>;
export type SessionAiTools = ReturnType<
	typeof actionsToAiTools<TabManagerBinding['collaboration']['actions']>
>;

type ReadyTabManagerApp = {
	tabManager: TabManagerBinding;
	state: {
		savedTabs: ReturnType<typeof createSavedTabState>;
		bookmarks: ReturnType<typeof createBookmarkState>;
		toolTrust: ReturnType<typeof createToolTrustState>;
		unifiedView: ReturnType<typeof createUnifiedViewState>;
		aiChat: ReturnType<typeof createAiChatState>;
	};
	sessionAiTools: SessionAiTools;
};

/**
 * Deferred-init values: set exactly once when `authSessionStorage.whenReady`
 * resolves, never reassigned afterwards. They are plain `let`, not `$state`,
 * because nothing needs the assignment itself to drive reactivity; consumers
 * await the `whenReady` promise before reading, and the reactive surfaces
 * (`auth.state`, `appSession.current`) own their own `$state` internally.
 */
let authClient: AuthClient | undefined;
let appSession: ReturnType<typeof createTabManagerSession> | undefined;

const whenReady = authSessionStorage.whenReady.then(() => {
	authClient = createOAuthAppAuth({
		baseURL: APP_URLS.API,
		clientId: EPICENTER_TAB_MANAGER_OAUTH_CLIENT_ID,
		sessionStorage: authSessionStorage,
		launcher: oauthLauncher,
	});
	appSession = createTabManagerSession(authClient);
});

function createTabManagerSession(auth: AuthClient) {
	return createSession({
		auth,
		build: (identity) => {
			const userId = identity.user.id;
			let disposed = false;
			let ready: ReadyTabManagerApp | undefined;
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
				const sessionAiTools = actionsToAiTools(
					tabManager.collaboration.actions,
				);
				const savedTabs = createSavedTabState(tabManager);
				const bookmarks = createBookmarkState(tabManager);
				const toolTrust = createToolTrustState(tabManager);
				const unifiedView = createUnifiedViewState({ bookmarks, savedTabs });
				const aiChat = createAiChatState({
					auth,
					tabManager,
					sessionAiTools,
				});

				ready = {
					tabManager,
					state: { savedTabs, bookmarks, toolTrust, unifiedView, aiChat },
					sessionAiTools,
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
				get sessionAiTools() {
					if (!ready) {
						throw new Error(
							'[tab-manager] sessionAiTools read before signed-in session readiness.',
						);
					}
					return ready.sessionAiTools;
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

export type SessionTools = SessionAiTools['tools'];

export const tabManagerSession = {
	get auth(): AuthClient {
		if (!authClient) {
			throw new Error('[tab-manager] auth read before storage readiness.');
		}
		return authClient;
	},
	get current() {
		if (!appSession) {
			throw new Error(
				'[tab-manager] tabManagerSession.current read before storage readiness.',
			);
		}
		return appSession.current;
	},
	whenReady,
	[Symbol.dispose]() {
		appSession?.[Symbol.dispose]();
		authClient?.[Symbol.dispose]();
	},
};

if (import.meta.hot) {
	import.meta.hot.dispose(() => tabManagerSession[Symbol.dispose]());
}

export function requireApp() {
	if (!appSession) {
		throw new Error(
			'[tab-manager] requireApp() called before storage readiness. ' +
				'Components must mount under `{#await tabManagerSession.whenReady}`.',
		);
	}
	return appSession.requireApp();
}

export async function forgetTabManagerDevice(): Promise<void> {
	const app = requireApp();
	await app.tabManager.wipe();
	window.location.reload();
}
