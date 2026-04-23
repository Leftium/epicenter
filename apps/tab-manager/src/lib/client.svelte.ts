/**
 * Tab-manager workspace client — a direct `openTabManager()` call that
 * owns the Y.Doc construction and composes every attachment inline.
 *
 * Live browser state (tabs, windows, tab groups) is NOT stored here — Chrome
 * is the sole authority for ephemeral browser state. See
 * `browser-state.svelte.ts`.
 */

import { createAuth } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachAwareness,
	attachBroadcastChannel,
	attachEncryption,
	attachIndexedDb,
	attachSync,
	dispatchAction,
	toWsUrl,
} from '@epicenter/workspace';
import { actionsToAiTools } from '@epicenter/workspace/ai';
import * as Y from 'yjs';
import { getGoogleCredentials, session } from '$lib/auth';
import {
	generateDefaultDeviceName,
	getBrowserName,
	getDeviceId,
} from '$lib/device/device-id';
import { createTabManagerActions } from './workspace/actions';
import {
	tabManagerAwarenessDefs,
	tabManagerTables,
} from './workspace/definition';

// Hydrate the persisted session from chrome.storage before constructing auth.
// After this resolves, `session.get()` is sync-authoritative; the core can
// read the real value at every call without racing chrome.storage.
await session.whenReady;

export const auth = createAuth({
	baseURL: APP_URLS.API,
	session,
	socialTokenProvider: async () => {
		const { idToken, nonce } = await getGoogleCredentials();
		return { provider: 'google', idToken, nonce };
	},
});

export function openTabManager() {
	const ydoc = new Y.Doc({ guid: 'epicenter.tab-manager', gc: false });

	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(ydoc, tabManagerTables);
	const kv = encryption.attachKv(ydoc, {});
	const awareness = attachAwareness(ydoc, tabManagerAwarenessDefs);

	const batch = (fn: () => void) => ydoc.transact(fn);
	const actions = createTabManagerActions({ tables, batch });

	const idb = attachIndexedDb(ydoc);
	attachBroadcastChannel(ydoc);
	const sync = attachSync(ydoc, {
		url: toWsUrl(`${APP_URLS.API}/workspaces/${ydoc.guid}`),
		waitFor: idb.whenLoaded,
		awareness: awareness.raw,
		requiresToken: true,
		rpc: {
			dispatch: (action, input) => dispatchAction(actions, action, input),
		},
	});

	auth.onSessionChange((next, previous) => {
		if (next === null) {
			sync.goOffline();
			sync.setToken(null);
			if (previous !== null) void idb.clearLocal();
			return;
		}
		encryption.applyKeys(next.encryptionKeys);
		sync.setToken(next.token);
		if (previous?.token !== next.token) sync.reconnect();
		if (previous === null) void registerDevice();
	});

	return {
		get id() {
			return ydoc.guid;
		},
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
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};

	/**
	 * Register this browser installation as a device in the workspace.
	 *
	 * Upserts the device row — preserves existing name if present, otherwise
	 * generates a default. Called from the auth subscription on every applied
	 * session (login + token rotation) so encryption keys are always active
	 * before the write reaches the Y.Doc. The upsert is idempotent, so
	 * rotation-triggered re-runs are harmless.
	 */
	async function registerDevice(): Promise<void> {
		await idb.whenLoaded;
		const deviceId = await getDeviceId();
		const { data: existing, error } = tables.devices.get(deviceId);
		const existingName = !error && existing ? existing.name : null;
		tables.devices.set({
			id: deviceId,
			name: existingName ?? (await generateDefaultDeviceName()),
			lastSeen: new Date().toISOString(),
			browser: getBrowserName(),
			_v: 1,
		});
	}
}

export const workspace = openTabManager();

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
	});
}

/** AI tool representations for the tab-manager workspace. */
export const workspaceAiTools = actionsToAiTools(workspace.actions);

/** Tool array type for use in TanStack AI generics. */
export type WorkspaceTools = typeof workspaceAiTools.tools;

// Publish awareness identity after initial load
void workspace.whenReady.then(async () => {
	const deviceId = await getDeviceId();
	workspace.awareness.setLocal({ deviceId, client: 'extension' });
});
