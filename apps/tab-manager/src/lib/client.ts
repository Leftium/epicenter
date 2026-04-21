/**
 * Workspace client — browser-specific wiring and AI-callable actions.
 *
 * Imports the definition from `workspace/definition.ts`, attaches IndexedDB
 * persistence and WebSocket sync with RPC dispatch and awareness, and layers
 * action handlers that call Chrome extension APIs.
 *
 * Live browser state (tabs, windows, tab groups) is NOT stored here — Chrome
 * is the sole authority for ephemeral browser state. See
 * `browser-state.svelte.ts`.
 */

import {
	attachBroadcastChannel,
	attachIndexedDb,
	attachSync,
	toWsUrl,
} from '@epicenter/document';
import { createAuth } from '@epicenter/svelte/auth';
import { dispatchAction } from '@epicenter/workspace';
import { actionsToAiTools } from '@epicenter/workspace/ai';
import { getGoogleCredentials, session } from '$lib/auth';
import {
	generateDefaultDeviceName,
	getBrowserName,
	getDeviceId,
} from '$lib/device/device-id';
import { remoteServerUrl, serverUrl } from '$lib/state/settings.svelte';
import { createTabManagerActions } from './workspace/actions';
import { tabManager } from './workspace/definition';

const base = tabManager.open('epicenter.tab-manager');
const idb = attachIndexedDb(base.ydoc);
attachBroadcastChannel(base.ydoc);
const actions = createTabManagerActions({
	tables: base.tables,
	batch: base.batch,
});
const sync = attachSync(base.ydoc, {
	url: (workspaceId) =>
		toWsUrl(`${serverUrl.current}/workspaces/${workspaceId}`),
	getToken: async () => auth.token,
	waitFor: idb.whenLoaded,
	awareness: base.awareness.raw,
	rpc: {
		dispatch: (action, input) => dispatchAction(actions, action, input),
	},
});

export const workspace = Object.assign(base, {
	idb,
	sync,
	actions,
	whenReady: idb.whenLoaded,
});

export const auth = createAuth({
	baseURL: () => remoteServerUrl.current,
	session,
	socialTokenProvider: async () => {
		const { idToken, nonce } = await getGoogleCredentials();
		return { provider: 'google', idToken, nonce };
	},
	onLogin(session) {
		workspace.enc.applyKeys(session.encryptionKeys);
		workspace.sync.reconnect();
		void registerDevice();
	},
	async onLogout() {
		await workspace.idb.clearLocal();
		window.location.reload();
	},
});

/** AI tool representations for the tab-manager workspace. */
export const workspaceAiTools = actionsToAiTools(workspace.actions);

/** Tool array type for use in TanStack AI generics. */
export type WorkspaceTools = typeof workspaceAiTools.tools;

/**
 * Register this browser installation as a device in the workspace.
 *
 * Upserts the device row — preserves existing name if present, otherwise
 * generates a default. Called from `onLogin` so encryption keys are always
 * active before the write reaches the Y.Doc.
 */
async function registerDevice(): Promise<void> {
	await workspace.whenReady;
	const id = await getDeviceId();
	const existing = workspace.tables.devices.get(id);
	const existingName = existing.status === 'valid' ? existing.row.name : null;
	workspace.tables.devices.set({
		id,
		name: existingName ?? (await generateDefaultDeviceName()),
		lastSeen: new Date().toISOString(),
		browser: getBrowserName(),
		_v: 1,
	});
}

// Publish awareness identity after initial load
void workspace.whenReady.then(async () => {
	const deviceId = await getDeviceId();
	workspace.awareness.setLocal({ deviceId, client: 'extension' });
});
