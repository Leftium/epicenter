/**
 * Tab-manager browser composition.
 *
 * Single source of truth for "how Tab Manager mounts in a browser extension."
 * Calls Tier 1 primitives inline so every line is visible top-to-bottom:
 *
 *  1. workspace root doc (encrypted tables + KV via openEncryptedDoc)
 *  2. local storage for the root (attachLocalStorage)
 *  3. actions wired against tables + Y.Doc transaction batching
 *
 * Cloud sync (openCollaboration) is opened by the session bootstrap in
 * `session.svelte.ts`, not here: the bootstrap also wires the auth-state
 * listener that drives reconnects. Live browser state (tabs, windows, tab
 * groups) is NOT stored here. Chrome is the sole authority for ephemeral
 * browser state. See `browser-state.svelte.ts`.
 *
 * The bundle's `wipe()` drops every encrypted IDB database for this subject;
 * `Symbol.dispose` tears down the root Y.Doc without touching local storage.
 */

import type { SignedIn } from '@epicenter/svelte';
import {
	attachLocalStorage,
	openEncryptedDoc,
	wipeLocalStorage,
} from '@epicenter/workspace';
import { createTabManagerActions } from '$lib/workspace/actions';
import {
	type DeviceId,
	TAB_MANAGER_ID,
	tabManagerTables,
} from '$lib/workspace/definition';

/**
 * Build the tab-manager binding. Synchronous: callers must resolve the
 * installation id before invoking (the extension's installation id comes from
 * `chrome.storage.local` via `createDeviceProfile()` in `device.ts`).
 *
 * Consumers gate UI render on `tabManager.idb.whenLoaded`.
 */
export function openTabManagerBrowser({
	signedIn,
	installationId,
}: {
	signedIn: SignedIn;
	installationId: DeviceId;
}) {
	const ws = openEncryptedDoc({
		id: TAB_MANAGER_ID,
		keyring: signedIn.keyring,
	});
	const tables = ws.attachTables(tabManagerTables);
	const kv = ws.attachKv({});
	const actions = createTabManagerActions({
		tables,
		batch: (fn) => ws.ydoc.transact(fn),
		deviceId: installationId,
	});

	const idb = attachLocalStorage(ws.ydoc, signedIn);

	return {
		installationId,
		ydoc: ws.ydoc,
		tables,
		kv,
		idb,
		actions,
		async wipe() {
			ws[Symbol.dispose]();
			await idb.whenDisposed;
			await wipeLocalStorage({ subject: signedIn.subject });
		},
		[Symbol.dispose]() {
			ws[Symbol.dispose]();
		},
	};
}

export type TabManagerBrowser = ReturnType<typeof openTabManagerBrowser>;
