/**
 * Device identity helpers for the tab-manager extension.
 *
 * The extension publishes a `replica` descriptor in awareness (install-stable
 * id + platform) and seeds a row in the local `devices` table with a
 * human-readable name. Replica is the wire concept; the device row is the
 * app's product concept (display name, last seen, browser kind).
 */

import { createReplicaIdAsync } from '@epicenter/workspace';
import { storage } from '@wxt-dev/storage';
import type { TabManagerBrowser } from './tab-manager/extension';
import type { DeviceId } from './workspace/definition';

/**
 * Compute the extension's replica descriptor + the default device label.
 *
 * Replica.id is read from (or created in) `chrome.storage.local`. The
 * default name combines the browser brand and the host OS (e.g.
 * "Chrome on macOS") and is used to seed the device row when no row exists
 * yet; subsequent renames live on the row, not the replica.
 */
export async function createDeviceProfile() {
	const [id, defaultName] = await Promise.all([
		createReplicaIdAsync({
			storage: {
				getItem: (k) => storage.getItem<string>(`local:${k}`),
				setItem: async (k, v) => {
					await storage.setItem(`local:${k}`, v);
				},
			},
		}),
		generateDefaultDeviceName(),
	]);
	return {
		replica: { id: id as DeviceId, platform: 'chrome-extension' as const },
		defaultName,
	};
}

/**
 * Write the device record after IndexedDB loads. Preserves a previously-set
 * device name if one exists in the local doc; otherwise seeds with the
 * default label captured at boot.
 */
export async function registerDevice(
	tabManager: TabManagerBrowser,
	defaultName: string,
): Promise<void> {
	// openTabManagerBrowser narrows replica.id to DeviceId at construction; the
	// schema-validated Replica type carries plain strings, so cast back.
	const id = tabManager.collaboration.replica.id as DeviceId;
	const { data: existing, error } = tabManager.tables.devices.get(id);
	const existingName = !error && existing ? existing.name : null;
	tabManager.tables.devices.set({
		id,
		name: existingName ?? defaultName,
		lastSeen: new Date().toISOString(),
		browser: import.meta.env.BROWSER,
		_v: 1,
	});
}

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
