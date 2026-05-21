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

export type DefaultCloudWorkspaceAuth = Pick<AuthClient, 'state' | 'fetch'>;

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

export async function resolveDefaultWorkspaceAppDocWsUrl({
	auth,
	apiUrl,
	appId,
	docId,
}: {
	auth: DefaultCloudWorkspaceAuth;
	apiUrl: string;
	appId: string;
	docId: string;
}): Promise<string | undefined> {
	const workspaceId = await resolveDefaultCloudWorkspaceId(auth);
	if (!workspaceId) return undefined;
	return workspaceAppDocWsUrl(apiUrl, { workspaceId, appId, docId });
}

export function routeSafeWorkspaceAppDocId({
	prefix,
	id,
}: {
	prefix: string;
	id: string;
}): string {
	const encodedId = Array.from(new TextEncoder().encode(id), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('');
	return `${prefix}.h${encodedId}`;
}

export function openDefaultWorkspaceAppDocCollaboration<
	TActions extends ActionRegistry,
>(
	ydoc: Y.Doc,
	{
		auth,
		apiUrl,
		appId,
		docId,
		...collaborationConfig
	}: Omit<OpenCollaborationConfig<TActions>, 'url'> & {
		auth: DefaultCloudWorkspaceAuth;
		apiUrl: string;
		appId: string;
		docId: string;
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
			const url = await resolveDefaultWorkspaceAppDocWsUrl({
				auth,
				apiUrl,
				appId,
				docId,
			});
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
