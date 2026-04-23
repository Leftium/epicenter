/**
 * Duck-typed readers over a document handle's optional `sync` and
 * `awareness` attachments.
 *
 * `handle.sync` is usually the `SyncAttachment` from `attachSync`, but the
 * CLI operates on arbitrary user bundles — so we duck-type the fields we
 * care about (`whenConnected`, `whenDisposed`, `rpc`) in one place instead
 * of re-declaring the cast at every call site.
 *
 * `handle.awareness` may be either a raw y-protocols `Awareness` or the
 * typed wrapper from `attachAwareness` (which exposes `.raw`). Same idea.
 */
import type { AwarenessState } from './find-peer';

export type HandleSync = {
	whenConnected?: Promise<void>;
	whenDisposed?: Promise<void>;
	rpc?: (
		clientId: number,
		action: string,
		input: unknown,
		options?: { timeout?: number },
	) => Promise<{ data: unknown; error: unknown }>;
};

export function getSync(handle: unknown): HandleSync | undefined {
	if (handle == null || typeof handle !== 'object') return undefined;
	const sync = (handle as { sync?: unknown }).sync;
	if (sync == null || typeof sync !== 'object') return undefined;
	return sync as HandleSync;
}

type AwarenessLike = {
	clientID: number;
	getStates(): Map<number, unknown>;
};

export function readPeers(
	handle: unknown,
): Map<number, AwarenessState> {
	const awareness = extractAwareness(handle);
	if (!awareness) return new Map();
	const peers = new Map<number, AwarenessState>();
	const selfId = awareness.clientID;
	for (const [clientId, state] of awareness.getStates()) {
		if (clientId === selfId) continue;
		if (state == null || typeof state !== 'object') continue;
		peers.set(clientId, state as AwarenessState);
	}
	return peers;
}

function extractAwareness(handle: unknown): AwarenessLike | undefined {
	if (handle == null || typeof handle !== 'object') return undefined;
	const a = (handle as { awareness?: unknown }).awareness;
	if (a == null || typeof a !== 'object') return undefined;
	const raw = (a as { raw?: unknown }).raw;
	if (raw && isAwareness(raw)) return raw;
	if (isAwareness(a)) return a;
	return undefined;
}

function isAwareness(value: unknown): value is AwarenessLike {
	return (
		value != null &&
		typeof value === 'object' &&
		typeof (value as { getStates?: unknown }).getStates === 'function' &&
		typeof (value as { clientID?: unknown }).clientID === 'number'
	);
}
