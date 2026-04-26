import { createAuth } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import { getOrCreateDeviceIdAsync } from '@epicenter/workspace';
import { actionsToAiTools } from '@epicenter/workspace/ai';
import { storage } from '@wxt-dev/storage';
import { getGoogleCredentials, session } from '$lib/auth';
import type { DeviceId } from '$lib/workspace/definition';
import { openTabManager } from './extension';

// Hydrate the persisted session from chrome.storage before constructing auth.
await session.whenReady;

export const auth = createAuth({
	baseURL: APP_URLS.API,
	session,
	socialTokenProvider: async () => {
		const { idToken, nonce } = await getGoogleCredentials();
		return { provider: 'google', idToken, nonce };
	},
});

/**
 * Resolve the device descriptor in the background — the factory accepts a
 * Promise and gates dependent work on `tabManager.whenReady`. No TLA at this
 * call site; the page renders immediately and `whenReady` is awaited where it
 * matters (registerDevice below, UI render gates).
 *
 * `id` and `name` resolve in parallel — the chrome.storage read and the
 * platform-info lookup are independent.
 */
const devicePromise = Promise.all([
	getOrCreateDeviceIdAsync<DeviceId>({
		getItem: (k) => storage.getItem<string>(`local:${k}`),
		setItem: async (k, v) => {
			await storage.setItem(`local:${k}`, v);
		},
	}),
	generateDefaultDeviceName(),
]).then(([id, name]) => ({
	id,
	name,
	platform: 'chrome-extension' as const,
}));

export const tabManager = openTabManager({ auth, device: devicePromise });

/**
 * Register this browser installation as a device in the workspace.
 *
 * Upserts the device row — preserves existing name if present, otherwise
 * uses the resolved default. Awaits both idb and device resolution before
 * writing. Idempotent: fires on every applied session (login + token
 * rotation), so `lastSeen` stays current.
 */
async function registerDevice(): Promise<void> {
	await tabManager.whenReady;
	const { id, name } = await tabManager.device;
	const { data: existing, error } = tabManager.tables.devices.get(id);
	const existingName = !error && existing ? existing.name : null;
	tabManager.tables.devices.set({
		id,
		name: existingName ?? name,
		lastSeen: new Date().toISOString(),
		browser: import.meta.env.BROWSER,
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
	void registerDevice();
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

// ─────────────────────────────────────────────────────────────────────────────
// Device naming
// ─────────────────────────────────────────────────────────────────────────────

const capitalize = (str: string) =>
	str.charAt(0).toUpperCase() + str.slice(1);

/** Default device label like "Chrome on macOS". */
async function generateDefaultDeviceName(): Promise<string> {
	const browserName = capitalize(import.meta.env.BROWSER);
	const platformInfo = await browser.runtime.getPlatformInfo();
	const osName = (
		{
			mac: 'macOS',
			win: 'Windows',
			linux: 'Linux',
			cros: 'ChromeOS',
			android: 'Android',
			openbsd: 'OpenBSD',
			fuchsia: 'Fuchsia',
		} satisfies Record<Browser.runtime.PlatformInfo['os'], string>
	)[platformInfo.os];
	return `${browserName} on ${osName}`;
}
