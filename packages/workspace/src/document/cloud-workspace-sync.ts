/**
 * Cloud Workspace sync glue.
 *
 * The platform primitive is `openCollaboration`, which takes a fully formed
 * WebSocket URL. Cloud sync needs two extra ingredients before that URL can
 * be built:
 *
 *   1. Resolve the user's default Cloud Workspace id via `GET /api/workspaces`.
 *   2. Translate `(workspaceId, appId, docId)` into the route URL.
 *
 * The factory in this file (`cloudWorkspaceSync.forApp`) owns both, plus the
 * auth-state subscription that re-attaches handles when the user signs in
 * after construction. Apps never see `auth.fetch`, the workspace lookup, or
 * the route shape.
 *
 * `resolveDefaultCloudWorkspaceId` is exported separately for callers
 * (Tab Manager) that already own a URL-resolution flow and only need the
 * raw workspace id.
 */

import type { AuthClient } from '@epicenter/auth';
import type { Logger } from 'wellcrafted/logger';
import type * as Y from 'yjs';
import { ACTION_KEY_PATTERN, type ActionRegistry } from '../shared/actions.js';
import {
	DispatchError,
	type DispatchRequest,
	type LiveDevice,
} from './dispatch.js';
import type {
	OpenWebSocket,
	SyncStatus,
} from './internal/sync-supervisor.js';
import {
	type Collaboration,
	type OpenCollaborationConfig,
	openCollaboration,
} from './open-collaboration.js';
import { workspaceAppDocWsUrl } from './transport.js';

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC: app-scoped factory
// ════════════════════════════════════════════════════════════════════════════

/**
 * Doc id must match the same alphabet the server validates against
 * (`apps/api/src/workspace-sync-doc.ts:3`). Apps choose doc ids; the factory
 * throws synchronously on mismatch so the error surfaces at the call site,
 * not later during connect.
 */
const ROUTE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Why the factory could not resolve a Cloud Workspace id for the signed-in
 * user. `null` means the lookup either has not run yet, succeeded, or the
 * user is signed-out (which is not a failure: it is the silent UI case).
 */
export type CloudWorkspaceLookupFailure =
	| 'personal-workspace-missing'
	| 'network';

export type CloudWorkspaceAppOpenConfig<TActions extends ActionRegistry> = {
	/**
	 * App-authored protocol name for this Y.Doc within the app namespace.
	 * Must match `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`. Defaults to `ydoc.guid`,
	 * which is route-safe for the platform's nanoid alphabet.
	 */
	docId?: string;
	waitFor?: Promise<unknown>;
	/**
	 * Override the WebSocket opener. Defaults to `auth.openWebSocket`, which
	 * carries the bearer token as a subprotocol. Tests pass a stub here.
	 */
	openWebSocket?: OpenWebSocket;
	log?: Logger;
	installationId: string;
	actions: TActions;
};

export type CloudWorkspaceAppSync = {
	/**
	 * Open a Cloud-synced collaboration on `ydoc` under this app namespace.
	 * Returns synchronously. Workspace id resolution happens lazily on the
	 * first `.open()` call and is shared across every subsequent open.
	 */
	open<TActions extends ActionRegistry>(
		ydoc: Y.Doc,
		config: CloudWorkspaceAppOpenConfig<TActions>,
	): Collaboration<TActions>;

	/**
	 * Most recent Cloud-side lookup failure. `null` when the lookup
	 * succeeded, has not run, or the user is signed-out. UI distinguishes:
	 *
	 *   auth.state === 'signed-out'                : show sign-in
	 *   signed-in + lookupFailure === null          : connecting / connected
	 *   signed-in + 'personal-workspace-missing'    : hard failure, show support
	 *   signed-in + 'network'                       : transient, will retry
	 */
	readonly lookupFailure: CloudWorkspaceLookupFailure | null;

	onLookupFailureChange(
		listener: (failure: CloudWorkspaceLookupFailure | null) => void,
	): () => void;

	[Symbol.dispose](): void;
};

type ResolveWorkspaceIdResult =
	| { kind: 'ok'; workspaceId: string }
	| { kind: 'not-signed-in' }
	| { kind: 'failure'; reason: CloudWorkspaceLookupFailure };

export const cloudWorkspaceSync = {
	forApp,
};

function forApp({
	auth,
	apiUrl,
	appId,
}: {
	auth: AuthClient;
	apiUrl: string;
	appId: string;
}): CloudWorkspaceAppSync {
	let workspaceIdPromise: Promise<ResolveWorkspaceIdResult> | null = null;
	let lookupFailure: CloudWorkspaceLookupFailure | null = null;
	let disposed = false;
	const lookupListeners = new Set<
		(failure: CloudWorkspaceLookupFailure | null) => void
	>();
	const liveHandles = new Set<Collaboration>();

	function setLookupFailure(next: CloudWorkspaceLookupFailure | null) {
		if (next === lookupFailure) return;
		lookupFailure = next;
		for (const listener of lookupListeners) listener(next);
	}

	function resolveWorkspaceId(): Promise<ResolveWorkspaceIdResult> {
		if (workspaceIdPromise) return workspaceIdPromise;
		workspaceIdPromise = doResolve();
		return workspaceIdPromise;
	}

	async function doResolve(): Promise<ResolveWorkspaceIdResult> {
		if (auth.state.status !== 'signed-in') {
			setLookupFailure(null);
			return { kind: 'not-signed-in' };
		}
		let response: Response;
		try {
			response = await auth.fetch('/api/workspaces');
		} catch {
			setLookupFailure('network');
			return { kind: 'failure', reason: 'network' };
		}
		// The user may have signed out while the request was in flight; the
		// onStateChange listener already invalidated workspaceIdPromise but the
		// resolved value here would still propagate to the original attach()'s
		// open() call. Discard it so we don't hand a workspaceId to a handle
		// whose owner is no longer authenticated.
		if (auth.state.status !== 'signed-in') {
			setLookupFailure(null);
			return { kind: 'not-signed-in' };
		}
		if (response.status === 409) {
			setLookupFailure('personal-workspace-missing');
			return { kind: 'failure', reason: 'personal-workspace-missing' };
		}
		if (!response.ok) {
			setLookupFailure('network');
			return { kind: 'failure', reason: 'network' };
		}
		let body: { defaultWorkspaceId?: unknown };
		try {
			body = (await response.json()) as { defaultWorkspaceId?: unknown };
		} catch {
			setLookupFailure('network');
			return { kind: 'failure', reason: 'network' };
		}
		if (typeof body.defaultWorkspaceId !== 'string') {
			setLookupFailure('network');
			return { kind: 'failure', reason: 'network' };
		}
		setLookupFailure(null);
		return { kind: 'ok', workspaceId: body.defaultWorkspaceId };
	}

	const unsubscribeAuth = auth.onStateChange((state) => {
		if (disposed) return;
		// Any auth transition invalidates the cached lookup. Reconnect each
		// live handle so it re-runs resolveWorkspaceId with the new state.
		workspaceIdPromise = null;
		if (state.status !== 'signed-in') {
			setLookupFailure(null);
		}
		for (const handle of liveHandles) {
			handle.reconnect();
		}
	});

	function open<TActions extends ActionRegistry>(
		ydoc: Y.Doc,
		config: CloudWorkspaceAppOpenConfig<TActions>,
	): Collaboration<TActions> {
		const docId = config.docId ?? ydoc.guid;
		assertRouteSafeDocId(docId);

		const handle = attachDeferredCollaboration<TActions>(ydoc, {
			waitFor: config.waitFor,
			openWebSocket: config.openWebSocket ?? auth.openWebSocket,
			log: config.log,
			installationId: config.installationId,
			actions: config.actions,
			async resolveUrl() {
				const result = await resolveWorkspaceId();
				if (result.kind !== 'ok') return null;
				return workspaceAppDocWsUrl(apiUrl, {
					workspaceId: result.workspaceId,
					appId,
					docId,
				});
			},
		});

		liveHandles.add(handle);
		void handle.whenDisposed.finally(() => liveHandles.delete(handle));
		return handle;
	}

	return {
		open,
		get lookupFailure() {
			return lookupFailure;
		},
		onLookupFailureChange(listener) {
			lookupListeners.add(listener);
			return () => {
				lookupListeners.delete(listener);
			};
		},
		[Symbol.dispose]() {
			if (disposed) return;
			disposed = true;
			unsubscribeAuth();
			lookupListeners.clear();
			liveHandles.clear();
		},
	};
}

function assertRouteSafeDocId(docId: string): void {
	if (ROUTE_ID_PATTERN.test(docId)) return;
	throw new Error(
		`Invalid docId ${JSON.stringify(docId)}. Doc IDs must match ${ROUTE_ID_PATTERN.source} ` +
			`(1 to 128 chars, must start with [A-Za-z0-9], allowed characters [A-Za-z0-9._-]).`,
	);
}

// ════════════════════════════════════════════════════════════════════════════
// LOW-LEVEL: kept for Tab Manager and other callers that already own a URL
// resolution flow and just want the workspace id
// ════════════════════════════════════════════════════════════════════════════

/**
 * Minimum auth surface required to read the user's default Cloud Workspace
 * id without subscribing to state transitions. Most call sites should use
 * `cloudWorkspaceSync.forApp(auth, ...)` instead, which owns the lookup,
 * the subscription, and per-doc URL construction.
 */
export type DefaultCloudWorkspaceAuth = Pick<AuthClient, 'state' | 'fetch'>;

/**
 * Read the signed-in user's default Cloud Workspace id from
 * `/api/workspaces`. Returns `undefined` on signed-out, reauth-required,
 * network failure, or any non-OK response (including the typed 409
 * PersonalWorkspaceMissing); callers that need to distinguish those cases
 * should go through `cloudWorkspaceSync.forApp(...).lookupFailure` instead.
 */
export async function resolveDefaultCloudWorkspaceId(
	auth: DefaultCloudWorkspaceAuth,
): Promise<string | undefined> {
	if (auth.state.status !== 'signed-in') return undefined;
	try {
		const response = await auth.fetch('/api/workspaces');
		if (!response.ok) return undefined;
		const body = (await response.json()) as { defaultWorkspaceId?: unknown };
		return typeof body.defaultWorkspaceId === 'string'
			? body.defaultWorkspaceId
			: undefined;
	} catch {
		return undefined;
	}
}

// ════════════════════════════════════════════════════════════════════════════
// INTERNAL: deferred-collaboration lifecycle
// ════════════════════════════════════════════════════════════════════════════

/**
 * Returns a `Collaboration` synchronously and attaches the underlying
 * `openCollaboration` asynchronously once `resolveUrl()` produces a URL.
 *
 * - `resolveUrl()` returning `null` keeps the handle in `phase: 'offline'`.
 * - `reconnect()` re-runs `resolveUrl()` if no live collaboration exists yet.
 * - `dispatch()` resolves to `DispatchError.NetworkFailed` while detached.
 * - Y.Doc destroy cascades into both the deferred handle and the live one.
 */
function attachDeferredCollaboration<TActions extends ActionRegistry>(
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
	const whenConnected = createDeferred<void>();
	const whenDisposed = createDeferred<void>();

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

function createDeferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}
