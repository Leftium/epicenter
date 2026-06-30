import { createAgentChatState } from '@epicenter/app-shell/agent-chat';
import type { InstanceSetting, SyncAuthClient } from '@epicenter/auth';
import { EPICENTER_TAB_MANAGER_OAUTH_CLIENT_ID } from '@epicenter/constants/oauth-clients';
import { createAppAuthClient, createSession } from '@epicenter/svelte/auth';
import {
	createLocalToolCatalog,
	defaultApprovalDecision,
} from '@epicenter/workspace/agent';
import { DEFAULT_MODEL } from './chat/models';
import {
	buildDeviceConstraints,
	TAB_MANAGER_SYSTEM_PROMPT,
} from './chat/system-prompt';
import { createDeviceProfile, registerDevice } from './device';
import {
	instanceSettingPromise,
	oauthLauncher,
	persistedAuthStoragePromise,
} from './platform/auth/auth';
import { createBookmarkState } from './state/bookmark-state.svelte';
import { inferenceConnections } from './state/inference-connections.svelte';
import { createSavedTabState } from './state/saved-tab-state.svelte';
import { createToolTrustState } from './state/tool-trust.svelte';
import { createUnifiedViewState } from './state/unified-view-state.svelte';
import { openTabManagerBrowser } from './tab-manager/extension';

/**
 * Deferred-init values: set exactly once when `persistedAuthStoragePromise`
 * AND the peer identity have resolved. They are plain `let`, not `$state`,
 * because nothing needs the assignment itself to drive reactivity; consumers
 * await `tabManagerSession.whenReady` before reading.
 *
 * Once storage and peer are ready, `session` is the synchronous
 * `createSession()` return value. Its `current` getter is `null` when signed
 * out and the augmented tab-manager binding (binding fields + `state`) when
 * signed in.
 */
let authClient: SyncAuthClient | undefined;
let instanceSettingValue: InstanceSetting | undefined;
let session: ReturnType<typeof buildSession> | undefined;

const whenReady = Promise.all([
	persistedAuthStoragePromise,
	instanceSettingPromise,
	createDeviceProfile(),
]).then(([persistedAuthStorage, instanceSetting, profile]) => {
	// One choke point: the persisted instance picks hosted OAuth vs a self-host
	// token (ADR-0071). The launcher is the hosted-constant extension launcher,
	// used only by the OAuth branch.
	const auth = createAppAuthClient(instanceSetting.read(), {
		clientId: EPICENTER_TAB_MANAGER_OAUTH_CLIENT_ID,
		persistedAuthStorage,
		launcher: oauthLauncher,
	});
	authClient = auth;
	instanceSettingValue = instanceSetting;
	session = buildSession(auth, profile);
});

function buildSession(
	auth: SyncAuthClient,
	profile: Awaited<ReturnType<typeof createDeviceProfile>>,
) {
	return createSession({
		auth,
		build: (signedIn) => {
			const tabManager = openTabManagerBrowser({
				signedIn,
				nodeId: profile.nodeId,
			});

			const savedTabs = createSavedTabState(tabManager);
			const bookmarks = createBookmarkState(tabManager);
			const toolTrust = createToolTrustState(tabManager);
			const unifiedView = createUnifiedViewState({ bookmarks, savedTabs });
			// The shared chat registry (ADR-0047/0059) with tab-manager's variation
			// injected: device-constraint + base prompts read per turn, its in-process
			// browser actions as the tool surface, and the "Always Allow" trust set
			// folded into the approval policy.
			const aiChat = createAgentChatState({
				table: tabManager.tables.conversations,
				whenLoaded: tabManager.idb.whenLoaded,
				connections: inferenceConnections,
				agent: {
					buildSystemPrompts: () => [
						buildDeviceConstraints(tabManager.nodeId),
						TAB_MANAGER_SYSTEM_PROMPT,
					],
					defaultModel: DEFAULT_MODEL,
					toolCatalog: createLocalToolCatalog(tabManager.actions),
					// A tool the user chose to "Always Allow" auto-approves; otherwise a
					// query runs unattended and a mutation asks (ADR-0044).
					decideApproval: (call, definition) =>
						toolTrust.shouldAutoApprove(call.toolName)
							? 'auto'
							: defaultApprovalDecision(call, definition),
				},
			});
			const state = { savedTabs, bookmarks, toolTrust, unifiedView, aiChat };

			void tabManager.idb.whenLoaded.then(() =>
				registerDevice(tabManager, profile.defaultName),
			);

			return {
				...tabManager,
				state,
				[Symbol.dispose]() {
					aiChat[Symbol.dispose]();
					tabManager[Symbol.dispose]();
				},
			};
		},
	});
}

export const tabManagerSession = {
	get auth(): SyncAuthClient {
		if (!authClient) {
			throw new Error('[tab-manager] auth read before storage readiness.');
		}
		return authClient;
	},
	get instanceSetting(): InstanceSetting {
		if (!instanceSettingValue) {
			throw new Error(
				'[tab-manager] instanceSetting read before storage readiness.',
			);
		}
		return instanceSettingValue;
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
