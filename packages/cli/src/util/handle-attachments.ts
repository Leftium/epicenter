/**
 * Safely read optional `sync` and `awareness` attachments off a document
 * handle whose bundle shape the CLI does not know statically.
 *
 * The CLI operates on arbitrary user bundles — `epicenter.config.ts` can
 * put anything on the handle, and the attachments are *conventional* names
 * (`sync`, `awareness`), not contract. So we:
 *
 *   - treat them as possibly-undefined at the boundary,
 *   - import the authoritative `SyncAttachment` type from `@epicenter/workspace`
 *     so future API changes propagate (no local duplicate shape),
 *   - duck-type awareness because users may attach either a raw y-protocols
 *     `Awareness` or the typed wrapper from `attachAwareness` (which exposes
 *     `.raw`). Both shapes must work.
 *
 * Awareness invariants the CLI relies on (from y-protocols/awareness):
 *
 *   - **Ephemeral.** ~30s liveness window; peers that crashed silently
 *     disappear after `outdatedTimeout`. Awareness is a liveness probe,
 *     not a directory.
 *   - **clientID is session-local.** Re-randomized on every `new Y.Doc()`,
 *     so numeric clientIDs are stable within one presence session only.
 *     Scripts that need stable addressing should prefer `deviceName=...`
 *     or a `k=v` field match, not numeric IDs.
 *   - **deviceName is a convention, not a contract.** The CLI's bare-name
 *     `--peer myMacbook` form assumes peers publish `deviceName` into
 *     awareness via `attachAwareness({ deviceName: ... })`. If no peer does,
 *     use `--peer field=value` against whatever field *is* published.
 *     Persistent peer identity (across reconnects) belongs in a shared Y.Map
 *     on the doc, not in awareness.
 */
import type { SyncAttachment } from '@epicenter/workspace';

/**
 * Shape the CLI sees for a peer's awareness state. Users' bundles may
 * attach a typed `Awareness<TDefs>` wrapper, but the CLI is bundle-agnostic
 * so it works with the most general shape: an arbitrary string-keyed record.
 */
export type AwarenessState = Record<string, unknown>;

export function getSync(handle: unknown): SyncAttachment | undefined {
	if (handle == null || typeof handle !== 'object') return undefined;
	const sync = (handle as { sync?: unknown }).sync;
	if (sync == null || typeof sync !== 'object') return undefined;
	return sync as SyncAttachment;
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
