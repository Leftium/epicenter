import { getOrCreateDeviceId } from '@epicenter/workspace';

/** Per-installation deviceId for this Honeycrisp SPA, persisted in localStorage. */
export const deviceId = getOrCreateDeviceId({
	getItem: (k) => localStorage.getItem(k),
	setItem: (k, v) => localStorage.setItem(k, v),
});
