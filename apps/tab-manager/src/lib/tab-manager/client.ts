import { createAuth } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import { actionsToAiTools } from '@epicenter/workspace/ai';
import { getGoogleCredentials, session } from '$lib/auth';
import {
	generateDefaultDeviceName,
	getBrowserName,
	getDeviceId,
} from '$lib/device/device-id';
import { openTabManager } from './extension';

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

export const tabManager = openTabManager({ auth });

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
	await tabManager.idb.whenLoaded;
	const deviceId = await getDeviceId();
	const { data: existing, error } = tabManager.tables.devices.get(deviceId);
	const existingName = !error && existing ? existing.name : null;
	tabManager.tables.devices.set({
		id: deviceId,
		name: existingName ?? (await generateDefaultDeviceName()),
		lastSeen: new Date().toISOString(),
		browser: getBrowserName(),
		_v: 1,
	});
}

auth.onSessionChange((next, previous) => {
	if (next === null) {
		tabManager.sync.goOffline();
		if (previous !== null) void tabManager.idb.clearLocal();
		return;
	}
	tabManager.encryption.applyKeys(next.encryptionKeys);
	if (previous?.token !== next.token) tabManager.sync.reconnect();
	if (previous === null) void registerDevice();
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		auth[Symbol.dispose]();
	});
}

/** AI tool representations for the tab-manager workspace. */
export const workspaceAiTools = actionsToAiTools(tabManager.actions);

/** Tool array type for use in TanStack AI generics. */
export type WorkspaceTools = typeof workspaceAiTools.tools;

// Publish awareness identity after initial load
void tabManager.whenReady.then(async () => {
	const deviceId = await getDeviceId();
	tabManager.awareness.setLocal({ deviceId, client: 'extension' });
});
