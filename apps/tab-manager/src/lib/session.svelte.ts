import type { AuthClient } from '@epicenter/auth';
import { createOAuthAppAuth } from '@epicenter/auth-svelte';
import { EPICENTER_TAB_MANAGER_OAUTH_CLIENT_ID } from '@epicenter/constants/oauth';
import { APP_URLS } from '@epicenter/constants/vite';
import { createSession } from '@epicenter/svelte';
import { actionsToAiTools } from '@epicenter/workspace/ai';
import { createAiChatState } from './chat/chat-state.svelte';
import { createDeviceProfile, registerDevice } from './device';
import { oauthLauncher, persistedAuthStorage } from './platform/auth/auth';
import { createBookmarkState } from './state/bookmark-state.svelte';
import { createSavedTabState } from './state/saved-tab-state.svelte';
import { createToolTrustState } from './state/tool-trust.svelte';
import { createUnifiedViewState } from './state/unified-view-state.svelte';
import type { TabManagerBrowser } from './tab-manager/extension';
import { openTabManagerBrowser } from './tab-manager/extension';

export type SessionAiTools = ReturnType<
	typeof actionsToAiTools<TabManagerBrowser['collaboration']['actions']>
>;
export type SessionTools = SessionAiTools['tools'];

/**
 * Deferred-init values: set exactly once when `persistedAuthStorage.whenReady`
 * AND the peer identity have resolved. They are plain `let`, not `$state`,
 * because nothing needs the assignment itself to drive reactivity; consumers
 * await `tabManagerSession.whenReady` before reading.
 *
 * Once storage and peer are ready, `session` is the synchronous
 * `createSession()` return value. Its `current` getter is `null` when signed
 * out and the augmented tab-manager binding (binding fields + `state` +
 * `sessionAiTools`) when signed in.
 */
let authClient: AuthClient | undefined;
let session: ReturnType<typeof buildSession> | undefined;

const whenReady = Promise.all([
	persistedAuthStorage.whenReady,
	createDeviceProfile(),
]).then(([, profile]) => {
	const auth = createOAuthAppAuth({
		baseURL: APP_URLS.API,
		clientId: EPICENTER_TAB_MANAGER_OAUTH_CLIENT_ID,
		persistedAuthStorage,
		launcher: oauthLauncher,
	});
	authClient = auth;
	return resolveDefaultWorkspaceId(auth).then((defaultWorkspaceId) => {
		session = buildSession(auth, profile, defaultWorkspaceId);
	});
});

async function resolveDefaultWorkspaceId(auth: AuthClient) {
	if (auth.state.status === 'signed-out') return;
	try {
		const response = await auth.fetch('/api/workspaces');
		if (!response.ok) return undefined;
		const body = (await response.json()) as { defaultWorkspaceId?: unknown };
		return typeof body.defaultWorkspaceId === 'string'
			? body.defaultWorkspaceId
			: undefined;
	} catch {
		// Local workspace data can still open while offline or reauth is needed.
		return undefined;
	}
}

function buildSession(
	auth: AuthClient,
	profile: Awaited<ReturnType<typeof createDeviceProfile>>,
	initialDefaultWorkspaceId: string | undefined,
) {
	let defaultWorkspaceId = initialDefaultWorkspaceId;
	let hasInitialWorkspaceResolution = auth.state.status !== 'signed-out';

	return createSession({
		auth,
		async prepare() {
			if (hasInitialWorkspaceResolution) {
				hasInitialWorkspaceResolution = false;
				return;
			}
			defaultWorkspaceId = await resolveDefaultWorkspaceId(auth);
		},
		build: ({ owner }) => {
			const tabManager = openTabManagerBrowser({
				owner,
				installationId: profile.installationId,
				openWebSocket: auth.openWebSocket,
				defaultWorkspaceId,
			});
			const sessionAiTools = actionsToAiTools(tabManager.collaboration.actions);
			const savedTabs = createSavedTabState(tabManager);
			const bookmarks = createBookmarkState(tabManager);
			const toolTrust = createToolTrustState(tabManager);
			const unifiedView = createUnifiedViewState({ bookmarks, savedTabs });
			const aiChat = createAiChatState({ auth, tabManager, sessionAiTools });
			const state = { savedTabs, bookmarks, toolTrust, unifiedView, aiChat };

			void tabManager.idb.whenLoaded.then(() =>
				registerDevice(tabManager, profile.defaultName),
			);

			return {
				...tabManager,
				state,
				sessionAiTools,
				[Symbol.dispose]() {
					aiChat[Symbol.dispose]();
					toolTrust[Symbol.dispose]();
					bookmarks[Symbol.dispose]();
					savedTabs[Symbol.dispose]();
					tabManager[Symbol.dispose]();
				},
			};
		},
	});
}

export const tabManagerSession = {
	get auth(): AuthClient {
		if (!authClient) {
			throw new Error('[tab-manager] auth read before storage readiness.');
		}
		return authClient;
	},
	get current() {
		if (!session) {
			throw new Error(
				'[tab-manager] tabManagerSession.current read before storage readiness.',
			);
		}
		return session.current;
	},
	whenReady,
	[Symbol.dispose]() {
		session?.[Symbol.dispose]();
		authClient?.[Symbol.dispose]();
	},
};

if (import.meta.hot) {
	import.meta.hot.dispose(() => tabManagerSession[Symbol.dispose]());
}

export function requireTabManager() {
	if (!session) {
		throw new Error(
			'[tab-manager] requireTabManager() called before storage readiness. ' +
				'Components must mount under `{#await tabManagerSession.whenReady}`.',
		);
	}
	return session.require();
}
