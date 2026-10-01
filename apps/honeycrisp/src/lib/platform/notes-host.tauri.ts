/**
 * The desktop leaf: the page was loaded from its folder host, so the notes
 * are a real directory reached over the same-origin bridge.
 *
 * The page calls no native command. The shell put the bridge token in the
 * window before any script ran; without it this window has no folder.
 */
import { createBridgeTransport } from '../bridge/folder-client.js';
import { openBridgeNotesHost } from '../bridge/notes-host.js';
import type { OpenNotesHost } from './types.js';

declare global {
	interface Window {
		__HONEYCRISP_BRIDGE__?: { readonly token: string };
	}
}

export const openNotesHost: OpenNotesHost = async () => {
	const token = window.__HONEYCRISP_BRIDGE__?.token;
	if (typeof token !== 'string' || token === '')
		throw new Error(
			'This window has no notes folder attached. Open Honeycrisp from the desktop app.',
		);
	const host = await openBridgeNotesHost(
		createBridgeTransport({ origin: '', token }),
	);
	let unavailable = false;
	return {
		...host,
		onCloseRequested(listener) {
			const stop = host.onCloseRequested(listener);
			const blocked = () => {
				unavailable = true;
				listener('unavailable');
			};
			window.addEventListener('honeycrisp:close-blocked', blocked);
			return () => {
				stop();
				window.removeEventListener('honeycrisp:close-blocked', blocked);
			};
		},
		async quit() {
			if (unavailable) {
				window.location.assign('/__honeycrisp__/quit');
				return;
			}
			await host.quit();
		},
	};
};
