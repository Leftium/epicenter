/**
 * Device identity helpers for the tab-manager extension.
 *
 * The extension's peer identity is the (id, name, platform) tuple stored
 * in `chrome.storage.local` and surfaced through the collaboration's
 * awareness + the devices table. These helpers compute it at binding-build
 * time and register the device record once IndexedDB has loaded.
 */

import { getOrCreateInstallationIdAsync } from '@epicenter/workspace';
import { storage } from '@wxt-dev/storage';
import type { TabManagerBinding } from './session.svelte';
import type { DeviceId } from './workspace/definition';

/**
 * Compute the extension's peer identity. The installation id is read from
 * (or created in) `chrome.storage.local`; the default device name combines
 * the browser brand and the host OS (e.g. "Chrome on macOS").
 */
export async function createPeer() {
	const [id, name] = await Promise.all([
		getOrCreateInstallationIdAsync<DeviceId>({
			getItem: (k) => storage.getItem<string>(`local:${k}`),
			setItem: async (k, v) => {
				await storage.setItem(`local:${k}`, v);
			},
		}),
		generateDefaultDeviceName(),
	]);
	return {
		id,
		name,
		platform: 'chrome-extension' as const,
	};
}

/**
 * Write the device record after IndexedDB loads. Preserves a previously-set
 * device name if one exists in the local doc; otherwise falls back to the
 * peer's default name.
 */
export async function registerDevice(
	tabManager: TabManagerBinding,
): Promise<void> {
	// The binding's openTabManager narrows peer.id to DeviceId at construction;
	// PeerIdentity's id field is a plain string, so cast back to the branded type.
	const id = tabManager.collaboration.identity.id as DeviceId;
	const { name } = tabManager.collaboration.identity;
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
