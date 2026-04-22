/**
 * Tab-manager workspace client — a direct `openTabManager()` call that
 * owns the Y.Doc construction and composes every attachment inline.
 *
 * Live browser state (tabs, windows, tab groups) is NOT stored here — Chrome
 * is the sole authority for ephemeral browser state. See
 * `browser-state.svelte.ts`.
 */

import {
	attachAwareness,
	attachBroadcastChannel,
	attachIndexedDb,
	attachSync,
	toWsUrl,
} from '@epicenter/workspace';
import type { AuthSession } from '@epicenter/svelte/auth';
import { createAuth } from '@epicenter/svelte/auth';
import {
	attachEncryption,
	dispatchAction,
} from '@epicenter/workspace';
import { actionsToAiTools } from '@epicenter/workspace/ai';
import * as Y from 'yjs';
import { getGoogleCredentials, session } from '$lib/auth';
import {
	generateDefaultDeviceName,
	getBrowserName,
	getDeviceId,
} from '$lib/device/device-id';
import { remoteServerUrl, serverUrl } from '$lib/state/settings.svelte';
import { createTabManagerActions } from './workspace/actions';
import {
	tabManagerAwarenessDefs,
	tabManagerTables,
} from './workspace/definition';

export function openTabManager() {
	const ydoc = new Y.Doc({ guid: 'epicenter.tab-manager', gc: false });

	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(ydoc, tabManagerTables);
	const kv = encryption.attachKv(ydoc, {});
	const awareness = attachAwareness(ydoc, tabManagerAwarenessDefs);

	const batch = (fn: () => void) => ydoc.transact(fn);
	const actions = createTabManagerActions({ tables, batch });

	const idb = attachIndexedDb(ydoc);
	attachBroadcastChannel(ydoc);
	const sync = attachSync(ydoc, {
		url: (workspaceId) =>
			toWsUrl(`${serverUrl.current}/workspaces/${workspaceId}`),
		waitFor: idb.whenLoaded,
		awareness: awareness.raw,
		requiresToken: true,
		rpc: {
			dispatch: (action, input) => dispatchAction(actions, action, input),
		},
	});

	// Edge detector: only wipe IDB on a genuine logged-in → logged-out transition.
	// Cold-start-unauth (first call, `previous` still null) must be a noop so
	// anonymous data isn't destroyed at boot.
	let previousSession: AuthSession | null = null;
	async function applySession(next: AuthSession | null) {
		const wasAuthed = previousSession !== null;
		previousSession = next;
		if (next === null) {
			sync.goOffline();
			sync.setToken(null);
			if (wasAuthed) await idb.clearLocal();
			return;
		}
		encryption.applyKeys(next.encryptionKeys);
		sync.setToken(next.token);
		sync.reconnect();
		void registerDevice();
	}

	return {
		get id() {
			return ydoc.guid;
		},
		ydoc,
		tables,
		kv,
		awareness,
		encryption,
		idb,
		sync,
		actions,
		applySession,
		batch,
		whenReady: idb.whenLoaded,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};

	/**
	 * Register this browser installation as a device in the workspace.
	 *
	 * Upserts the device row — preserves existing name if present, otherwise
	 * generates a default. Called from `applySession` on every applied session
	 * (login + token rotation) so encryption keys are always active before the
	 * write reaches the Y.Doc. The upsert is idempotent, so rotation-triggered
	 * re-runs are harmless.
	 */
	async function registerDevice(): Promise<void> {
		await idb.whenLoaded;
		const deviceId = await getDeviceId();
		const { data: existing, error } = tables.devices.get(deviceId);
		const existingName = !error && existing ? existing.name : null;
		tables.devices.set({
			id: deviceId,
			name: existingName ?? (await generateDefaultDeviceName()),
			lastSeen: new Date().toISOString(),
			browser: getBrowserName(),
			_v: 1,
		});
	}
}

export const workspace = openTabManager();

export const auth = createAuth({
	baseURL: () => remoteServerUrl.current,
	session,
	socialTokenProvider: async () => {
		const { idToken, nonce } = await getGoogleCredentials();
		return { provider: 'google', idToken, nonce };
	},
});

const dispose = $effect.root(() => {
	$effect(() => {
		void workspace.applySession(auth.session);
	});
});
if (import.meta.hot) import.meta.hot.dispose(dispose);

/** AI tool representations for the tab-manager workspace. */
export const workspaceAiTools = actionsToAiTools(workspace.actions);

/** Tool array type for use in TanStack AI generics. */
export type WorkspaceTools = typeof workspaceAiTools.tools;

// Publish awareness identity after initial load
void workspace.whenReady.then(async () => {
	const deviceId = await getDeviceId();
	workspace.awareness.setLocal({ deviceId, client: 'extension' });
});
