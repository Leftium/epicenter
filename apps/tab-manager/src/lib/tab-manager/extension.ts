/**
 * Tab-manager browser composition.
 *
 * Single source of truth for "how Tab Manager mounts in a browser extension."
 * Calls Tier 1 primitives inline so every line is visible top-to-bottom:
 *
 *  1. workspace root doc (encrypted tables + KV via createTabManager)
 *  2. local storage for the root (attachLocalStorage)
 *  3. actions wired against tables + Y.Doc transaction batching
 *
 * Cloud sync (openCollaboration) is opened by the session bootstrap in
 * `session.svelte.ts`, not here: the bootstrap also wires the auth-state
 * listener that drives reconnects. Live browser state (tabs, windows, tab
 * groups) is NOT stored here. Chrome is the sole authority for ephemeral
 * browser state. See `browser-state.svelte.ts`.
 *
 * The bundle's `wipe()` drops every encrypted IDB database for this owner;
 * `Symbol.dispose` tears down the root Y.Doc without touching local storage.
 */

import type { SignedIn } from '@epicenter/svelte';
import { attachLocalStorage, wipeLocalStorage } from '@epicenter/workspace';
import { createTabManagerActions } from '$lib/workspace/actions';
import { createTabManager, type DeviceId } from '$lib/workspace/definition';

/**
 * Build the tab-manager binding. Synchronous: callers must resolve the
 * device id before invoking (the extension's device id comes from
 * `chrome.storage.local` via `createDeviceProfile()` in `device.ts`).
 *
 * Consumers gate UI render on `tabManager.idb.whenLoaded`.
 */
export function openTabManagerBrowser({
	signedIn,
	deviceId,
}: {
	signedIn: SignedIn;
	deviceId: DeviceId;
}) {
	const workspace = createTabManager({ keyring: signedIn.keyring });
	const actions = createTabManagerActions({
		tables: workspace.tables,
		batch: (fn) => workspace.ydoc.transact(fn),
		deviceId,
	});

	const idb = attachLocalStorage(workspace.ydoc, {
		server: signedIn.server,
		ownerId: signedIn.ownerId,
		keyring: signedIn.keyring,
	});

	return {
		deviceId,
		...workspace,
		idb,
		actions,
		async wipe() {
			workspace[Symbol.dispose]();
			await idb.whenDisposed;
			await wipeLocalStorage({
				server: signedIn.server,
				ownerId: signedIn.ownerId,
			});
		},
	};
}

export type TabManagerBrowser = ReturnType<typeof openTabManagerBrowser>;
