import { createBearerAuth } from '@epicenter/auth-svelte';
import { bindAuthWorkspaceScope } from '@epicenter/auth-workspace';
import { APP_URLS } from '@epicenter/constants/vite';
import { toast } from '@epicenter/ui/sonner';
import { getOrCreateInstallationIdAsync } from '@epicenter/workspace';
import { actionsToAiTools } from '@epicenter/workspace/ai';
import { storage } from '@wxt-dev/storage';
import { extractErrorMessage } from 'wellcrafted/error';
import { session } from '$lib/auth';
import type { DeviceId } from '$lib/workspace/definition';
import { openTabManager } from './extension';

await session.whenReady;

export const auth = createBearerAuth({
	baseURL: APP_URLS.API,
	initialSession: session.get(),
	saveSession: (next) => session.set(next),
});

/**
 * Resolve the peer descriptor before constructing the workspace. `id` and
 * `name` resolve in parallel. The chrome.storage read and the platform-info
 * lookup are independent.
 *
 * Presence publishes this descriptor synchronously at attach time, so the
 * factory awaits it before returning.
 */
const peer = await Promise.all([
	getOrCreateInstallationIdAsync<DeviceId>({
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

export const tabManager = await openTabManager({ auth, peer });

/**
 * Register this browser installation as a device in the workspace.
 *
 * Upserts the device row. Preserves existing name if present, otherwise
 * uses the resolved default. Awaits idb hydration before writing.
 * Idempotent: fires on every applied identity, so `lastSeen` refreshes when
 * auth changes reconnect the workspace.
 */
async function registerDevice(): Promise<void> {
	await tabManager.whenLoaded;
	const { id, name } = tabManager.peer;
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

bindAuthWorkspaceScope({
	auth,
	syncControl: tabManager.syncControl,
	applyAuthIdentity(session) {
		tabManager.encryption.applyKeys(session.encryptionKeys);
		void registerDevice();
	},
	async resetLocalClient() {
		try {
			tabManager.ydoc.destroy();
			await tabManager.clearLocalData();
		} catch (error) {
			toast.error('Could not clear local data', {
				description: extractErrorMessage(error),
			});
		} finally {
			window.location.reload();
		}
	},
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

const capitalize = (str: string) => str.charAt(0).toUpperCase() + str.slice(1);

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
