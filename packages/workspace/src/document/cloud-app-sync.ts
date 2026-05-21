/**
 * Cloud sync glue for one app.
 *
 * The platform primitive is `openCollaboration`, which takes a fully formed
 * WebSocket URL. Cloud sync needs two extra ingredients before that URL can
 * be built:
 *
 *   1. Resolve the user's default Cloud Workspace id via `GET /api/workspaces`.
 *   2. Translate `(workspaceId, appId, docId)` into the route URL.
 *
 * `openCloudAppSync` captures `(auth, apiUrl, appId, installationId)` once per
 * app instance, owns the workspace lookup, subscribes to auth-state changes so
 * sign-in reattaches every live handle, and exposes a single `.open(ydoc, …)`
 * verb. Apps never touch `auth.fetch`, the workspace lookup, or the route
 * shape. Doc-id validation is the server's job; the client trusts whatever
 * string the app supplies.
 */

import type { AuthClient } from '@epicenter/auth';
import type * as Y from 'yjs';
import { ACTION_KEY_PATTERN, type ActionRegistry } from '../shared/actions.js';
import {
	DispatchError,
	type DispatchRequest,
	type LiveDevice,
} from './dispatch.js';
import type { SyncStatus } from './internal/sync-supervisor.js';
import {
	type Collaboration,
	type OpenCollaborationConfig,
	openCollaboration,
} from './open-collaboration.js';
import { workspaceAppDocWsUrl } from './transport.js';

/**
 * Open an app-scoped Cloud sync runtime. Captures `(auth, apiUrl, appId,
 * installationId)` once and reuses the workspace lookup across every doc
 * opened through `.open()`. Subscribes to `auth.onStateChange` so signing in
 * after construction reattaches every live handle.
 *
 * The factory owns the auth subscription, not the docs: callers own each
 * `ydoc` passed to `.open()` and must destroy it (directly or via
 * `[Symbol.dispose]` on the returned Collaboration) before disposing the
 * factory. Disposing the factory unsubscribes auth and forgets the handle
 * set; it does not destroy any docs.
 */
export function openCloudAppSync({
	auth,
	apiUrl,
	appId,
	installationId,
}: {
	auth: AuthClient;
	apiUrl: string;
	appId: string;
	installationId: string;
}) {
	let workspaceIdPromise: Promise<string | null> | null = null;
	let disposed = false;
	const liveHandles = new Set<Collaboration>();

	function resolveWorkspaceId(): Promise<string | null> {
		if (workspaceIdPromise) return workspaceIdPromise;
		workspaceIdPromise = doResolve();
		return workspaceIdPromise;
	}

	async function doResolve(): Promise<string | null> {
		if (auth.state.status !== 'signed-in') return null;
		let response: Response;
		try {
			response = await auth.fetch('/api/workspaces');
		} catch {
			return null;
		}
		// The user may have signed out while the request was in flight; without
		// this re-check the resolved id would propagate to the original
		// attach() and the supervisor would open a socket for an unauthenticated
		// handle.
		if (auth.state.status !== 'signed-in') return null;
		if (!response.ok) return null;
		let body: { defaultWorkspaceId?: unknown };
		try {
			body = (await response.json()) as { defaultWorkspaceId?: unknown };
		} catch {
			return null;
		}
		return typeof body.defaultWorkspaceId === 'string'
			? body.defaultWorkspaceId
			: null;
	}

	const unsubscribeAuth = auth.onStateChange(() => {
		if (disposed) return;
		// Any auth transition invalidates the cached lookup. Reconnect each
		// live handle so it re-runs resolveWorkspaceId with the new state.
		workspaceIdPromise = null;
		for (const handle of liveHandles) {
			handle.reconnect();
		}
	});

	return {
		open<TActions extends ActionRegistry>(
			ydoc: Y.Doc,
			config: {
				actions: TActions;
				/**
				 * App-authored protocol name for this Y.Doc within the app
				 * namespace. Defaults to `ydoc.guid`. The server validates
				 * route shape; the client trusts whatever the app supplies.
				 */
				docId?: string;
				waitFor?: Promise<unknown>;
			},
		): Collaboration<TActions> {
			const docId = config.docId ?? ydoc.guid;

			const handle = openDeferredCollaboration<TActions>(ydoc, {
				waitFor: config.waitFor,
				openWebSocket: auth.openWebSocket,
				installationId,
				actions: config.actions,
				async resolveUrl() {
					const workspaceId = await resolveWorkspaceId();
					if (workspaceId === null) return null;
					return workspaceAppDocWsUrl(apiUrl, {
						workspaceId,
						appId,
						docId,
					});
				},
			});

			liveHandles.add(handle);
			void handle.whenDisposed.finally(() => liveHandles.delete(handle));
			return handle;
		},

		[Symbol.dispose]() {
			if (disposed) return;
			disposed = true;
			unsubscribeAuth();
			liveHandles.clear();
		},
	};
}

/**
 * Returns a `Collaboration` synchronously and attaches the underlying
 * `openCollaboration` asynchronously once `resolveUrl()` produces a URL.
 *
 * - `resolveUrl()` returning `null` keeps the handle in `phase: 'offline'`.
 * - `reconnect()` re-runs `resolveUrl()` if no live collaboration exists yet.
 * - `dispatch()` resolves to `DispatchError.NetworkFailed` while detached.
 * - Y.Doc destroy cascades into both the deferred handle and the live one.
 */
function openDeferredCollaboration<TActions extends ActionRegistry>(
	ydoc: Y.Doc,
	{
		resolveUrl,
		...collaborationConfig
	}: Omit<OpenCollaborationConfig<TActions>, 'url'> & {
		resolveUrl: () => Promise<string | null>;
	},
): Collaboration<TActions> {
	for (const key of Object.keys(collaborationConfig.actions)) {
		if (!ACTION_KEY_PATTERN.test(key)) {
			throw new Error(
				`Invalid action key "${key}". Action keys must match ${ACTION_KEY_PATTERN.source} (snake_case ASCII, starting with a letter, max 64 chars).`,
			);
		}
	}

	let status: SyncStatus = { phase: 'offline' };
	let live: Collaboration<TActions> | undefined;
	let liveStatusUnsubscribe: (() => void) | undefined;
	let resolving = false;
	let disposed = false;
	const statusListeners = new Set<(status: SyncStatus) => void>();
	const whenConnected = Promise.withResolvers<void>();
	const whenDisposed = Promise.withResolvers<void>();

	function setStatus(next: SyncStatus) {
		status = next;
		for (const listener of statusListeners) listener(next);
	}

	function finishDisposed() {
		disposed = true;
		liveStatusUnsubscribe?.();
		statusListeners.clear();
		whenDisposed.resolve();
	}

	ydoc.once('destroy', () => {
		if (live) {
			void live.whenDisposed.finally(finishDisposed);
			return;
		}
		finishDisposed();
	});

	async function attach() {
		if (disposed || live || resolving) return;
		resolving = true;
		setStatus({ phase: 'connecting', retries: 0 });
		try {
			const url = await resolveUrl();
			if (disposed || live) return;
			if (!url) {
				setStatus({ phase: 'offline' });
				return;
			}
			live = openCollaboration(ydoc, {
				...collaborationConfig,
				url,
			});
			liveStatusUnsubscribe = live.onStatusChange(setStatus);
			setStatus(live.status);
			void live.whenConnected.then(
				() => whenConnected.resolve(),
				(error) => whenConnected.reject(error),
			);
			void live.whenDisposed.then(() => {
				if (disposed) finishDisposed();
			});
		} catch {
			setStatus({ phase: 'offline' });
		} finally {
			resolving = false;
		}
	}

	void attach();

	return {
		installationId: collaborationConfig.installationId,
		actions: collaborationConfig.actions,
		get status() {
			return live?.status ?? status;
		},
		whenConnected: whenConnected.promise,
		whenDisposed: whenDisposed.promise,
		onStatusChange(listener) {
			statusListeners.add(listener);
			return () => {
				statusListeners.delete(listener);
			};
		},
		reconnect() {
			if (live) {
				live.reconnect();
				return;
			}
			void attach();
		},
		devices: {
			list(): LiveDevice[] {
				return live?.devices.list() ?? [];
			},
			subscribe(fn: (devices: LiveDevice[]) => void) {
				if (live) return live.devices.subscribe(fn);
				return () => {};
			},
		},
		dispatch(req: DispatchRequest) {
			if (live) return live.dispatch(req);
			return Promise.resolve(
				DispatchError.NetworkFailed({
					cause: new Error('Cloud collaboration is not attached.'),
				}),
			);
		},
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}
