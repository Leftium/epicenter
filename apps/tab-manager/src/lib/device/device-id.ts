/**
 * Device identity for multi-device tab sync.
 *
 * Provides stable device identification using browser storage.
 * Each browser installation gets a unique NanoID on first access,
 * persisted in storage.local across sessions.
 */

import { generateId } from '@epicenter/hq/dynamic';
import { storage } from '@wxt-dev/storage';

// ─────────────────────────────────────────────────────────────────────────────
// Device ID Storage
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Device ID storage item.
 * Auto-generates a NanoID on first access if not already set.
 */
const deviceIdItem = storage.defineItem<string>('local:deviceId', {
	init: () => generateId(),
});

/**
 * In-memory cache for device ID to avoid repeated storage lookups.
 * Reset on browser restart (null initially).
 */
let cachedDeviceId: string | null = null;

/**
 * Get the stable device ID for this browser installation.
 * Generated once on first install, persisted in storage.local.
 * Cached in memory after first access to avoid repeated storage calls.
 */
export async function getDeviceId(): Promise<string> {
	// Return cached value if available
	if (cachedDeviceId !== null) {
		return cachedDeviceId;
	}

	// getValue() can technically return null if storage fails, but our init
	// function ensures a value is always generated. Assert non-null here.
	const deviceId = await deviceIdItem.getValue();
	if (!deviceId) {
		throw new Error('Device ID not found - storage may have failed');
	}

	// Cache for future calls
	cachedDeviceId = deviceId;
	return deviceId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser & OS Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the current browser name from WXT environment.
 */
export function getBrowserName(): string {
	return import.meta.env.BROWSER; // 'chrome' | 'firefox' | 'safari' | 'edge' | 'opera'
}

/**
 * Capitalize first letter of a string.
 */
function capitalize(str: string): string {
	return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Generate a default device name like "Chrome on macOS".
 */
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
