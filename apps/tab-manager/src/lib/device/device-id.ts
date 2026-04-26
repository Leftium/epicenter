/**
 * Device identity for multi-device tab sync.
 *
 * `chrome.storage` is async, so the deviceId is exposed as a cached promise.
 * Resolved once at module load; every `await getDeviceId()` after that is a
 * microtask handing back the same value.
 */

import { getOrCreateDeviceIdAsync } from '@epicenter/workspace';
import { storage } from '@wxt-dev/storage';
import type { DeviceId } from '$lib/workspace';

const deviceIdPromise = getOrCreateDeviceIdAsync({
	getItem: (k) => storage.getItem<string>(`local:${k}`),
	setItem: async (k, v) => {
		await storage.setItem(`local:${k}`, v);
	},
}) as Promise<DeviceId>;

/** Stable per-installation device ID. Same value every call. */
export function getDeviceId(): Promise<DeviceId> {
	return deviceIdPromise;
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser & OS Detection
// ─────────────────────────────────────────────────────────────────────────────

/** Browser name from WXT environment. */
export function getBrowserName(): string {
	return import.meta.env.BROWSER;
}

const capitalize = (str: string) =>
	str.charAt(0).toUpperCase() + str.slice(1);

/** Default device label like "Chrome on macOS". */
export async function generateDefaultDeviceName(): Promise<string> {
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
