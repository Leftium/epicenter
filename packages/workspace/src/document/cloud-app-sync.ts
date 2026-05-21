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

	async function fetchWorkspaceId(): Promise<string | null> {
		if (auth.state.status !== 'signed-in') return null;
		let response: Response;
		try {
			response = await auth.fetch('/api/workspaces');
		} catch {
			return null;
		}
		if (!response.ok) return null;
		let body: { defaultWorkspaceId?: unknown };
		try {
			body = (await response.json()) as { defaultWorkspaceId?: unknown };
		} catch {
			return null;
		}
		// The user may have signed out while either await was in flight. Without
		// this guard a resolved id would propagate to the original attach() and
		// the supervisor would open a socket for an unauthenticated handle.
		if (auth.state.status !== 'signed-in') return null;
		return typeof body.defaultWorkspaceId === 'string'
			? body.defaultWorkspaceId
			: null;
	}

	const unsubscribeAuth = auth.onStateChange(() => {
		if (disposed) return;
		// Any auth transition invalidates the cached lookup. Reconnect each
		// live handle so it re-runs fetchWorkspaceId with the new state.
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
					if (!workspaceIdPromise) {
						const promise = fetchWorkspaceId();
						workspaceIdPromise = promise;
						// Don't cache transient failures: signed-out, network, non-ok,
						// or malformed body all resolve to `null`. Clear the slot on
						// `null` so the next `.open()` or `.reconnect()` retries. The
						// identity check guards against onStateChange having already
						// invalidated and replaced the cache while we awaited.
						void promise.then((result) => {
							if (result === null && workspaceIdPromise === promise) {
								workspaceIdPromise = null;
							}
						});
					}
					const workspaceId = await workspaceIdPromise;
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
	let liveDevicesUnsubscribe: (() => void) | undefined;
	let resolving = false;
	let disposed = false;
	const statusListeners = new Set<(status: SyncStatus) => void>();
	const devicesListeners = new Set<(devices: LiveDevice[]) => void>();
	const whenConnected = Promise.withResolvers<void>();
	const whenDisposed = Promise.withResolvers<void>();

	function setStatus(next: SyncStatus) {
		status = next;
		for (const listener of statusListeners) listener(next);
	}

	function finishDisposed() {
		disposed = true;
		liveStatusUnsubscribe?.();
		liveDevicesUnsubscribe?.();
		statusListeners.clear();
		devicesListeners.clear();
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
			// `live` cannot be set here: it's only assigned below in this same
			// closure, and concurrent calls are gated by `resolving`. Only the
			// dispose race matters.
			if (disposed) return;
			if (!url) {
				setStatus({ phase: 'offline' });
				return;
			}
			live = openCollaboration(ydoc, {
				...collaborationConfig,
				url,
			});
			liveStatusUnsubscribe = live.onStatusChange(setStatus);
			liveDevicesUnsubscribe = live.devices.subscribe((devices) => {
				for (const listener of devicesListeners) listener(devices);
			});
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
				// Always go through the local listener set. When `live` attaches,
				// `attach()` wires a single fan-out subscription on `live.devices`
				// that forwards into these listeners; callers who subscribe before
				// attach (e.g., a UI mounting during the offline phase) start
				// receiving updates as soon as `live` is set.
				devicesListeners.add(fn);
				return () => {
					devicesListeners.delete(fn);
				};
			},
		},
		presence: {
			// Before attach, no live collaboration exists, so we cannot have
			// received a snapshot. After attach, mirror the underlying
			// presence tracker so consumers (run-handler) see the real
			// pre-snapshot window.
			get hasSnapshot() {
				return live?.presence.hasSnapshot ?? false;
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
