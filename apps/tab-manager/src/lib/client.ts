/**
 * Tab-manager workspace client — a single `defineDocument` closure that owns
 * the Y.Doc construction and composes every attachment inline.
 *
 * Live browser state (tabs, windows, tab groups) is NOT stored here — Chrome
 * is the sole authority for ephemeral browser state. See
 * `browser-state.svelte.ts`.
 */

import {
	attachAwareness,
	attachBroadcastChannel,
	attachIndexedDb,
	attachSync,
	defineDocument,
	toWsUrl,
} from '@epicenter/document';
import { createAuth } from '@epicenter/svelte/auth';
import {
	attachEncryptedKv,
	attachEncryptedTables,
	attachEncryption,
	dispatchAction,
} from '@epicenter/workspace';
import { actionsToAiTools } from '@epicenter/workspace/ai';
import * as Y from 'yjs';
import { getGoogleCredentials, session } from '$lib/auth';
import {
	generateDefaultDeviceName,
	getBrowserName,
	getDeviceId,
} from '$lib/device/device-id';
import { remoteServerUrl, serverUrl } from '$lib/state/settings.svelte';
import { createTabManagerActions } from './workspace/actions';
import {
	tabManagerAwarenessDefs,
	tabManagerTables,
} from './workspace/definition';

const tabManager = defineDocument(
	(id: string) => {
		const ydoc = new Y.Doc({ guid: id, gc: false });

		const encryption = attachEncryption(ydoc);
		const tables = attachEncryptedTables(ydoc, encryption, tabManagerTables);
		const kv = attachEncryptedKv(ydoc, encryption, {});
		const awareness = attachAwareness(ydoc, tabManagerAwarenessDefs);

		const batch = (fn: () => void) => ydoc.transact(fn);
		const actions = createTabManagerActions({ tables, batch });

		const idb = attachIndexedDb(ydoc);
		attachBroadcastChannel(ydoc);
		const sync = attachSync(ydoc, {
			url: (workspaceId) =>
				toWsUrl(`${serverUrl.current}/workspaces/${workspaceId}`),
			getToken: async () => auth.token,
			waitFor: idb.whenLoaded,
			awareness: awareness.raw,
			rpc: {
				dispatch: (action, input) => dispatchAction(actions, action, input),
			},
		});

		return {
			id,
			ydoc,
			tables,
			kv,
			awareness,
			encryption,
			idb,
			sync,
			actions,
			batch,
			whenReady: idb.whenLoaded,
			whenDisposed: Promise.all([
				idb.whenDisposed,
				sync.whenDisposed,
				encryption.whenDisposed,
			]).then(() => {}),
			[Symbol.dispose]() {
				ydoc.destroy();
			},
		};
	},
	{ gcTime: Number.POSITIVE_INFINITY },
);

export const workspace = tabManager.open('epicenter.tab-manager');

export const auth = createAuth({
	baseURL: () => remoteServerUrl.current,
	session,
	socialTokenProvider: async () => {
		const { idToken, nonce } = await getGoogleCredentials();
		return { provider: 'google', idToken, nonce };
	},
	onLogin(session) {
		workspace.encryption.applyKeys(session.encryptionKeys);
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
