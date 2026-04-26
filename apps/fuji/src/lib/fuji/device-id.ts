import { getOrCreateDeviceId } from '@epicenter/workspace';

/**
 * Per-installation deviceId for this Fuji SPA. Stored in localStorage —
 * survives reloads, scoped to this origin. Two browser tabs sharing the
 * origin share the deviceId (interchangeable runtimes); two physical
 * devices have distinct ids.
 */
export const deviceId = getOrCreateDeviceId({
	getItem: (k) => localStorage.getItem(k),
	setItem: (k, v) => localStorage.setItem(k, v),
});
