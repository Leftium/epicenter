/**
 * Workspace client — browser-specific wiring.
 *
 * IndexedDB persistence + BroadcastChannel cross-tab sync.
 */

import { APP_URLS } from '@epicenter/constants/vite';
import { createAuth } from '@epicenter/svelte/auth';
import {
	attachBroadcastChannel,
	attachIndexedDb,
} from '@epicenter/document';
import { session } from '$lib/auth';
import { zhongwen } from './workspace/definition';

const base = zhongwen.open('epicenter.zhongwen');
const idb = attachIndexedDb(base.ydoc);
attachBroadcastChannel(base.ydoc);

export const workspace = Object.assign(base, {
	idb,
	whenReady: idb.whenLoaded,
});

export const auth = createAuth({
	baseURL: APP_URLS.API,
	session,
	onLogin(session) {
		workspace.enc.applyKeys(session.encryptionKeys);
	},
	async onLogout() {
		await workspace.idb.clearLocal();
		window.location.reload();
	},
});
