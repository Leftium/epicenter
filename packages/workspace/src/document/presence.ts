/**
 * Server-owned presence tracker.
 *
 * The relay publishes "which installs are connected" as plain JSON text
 * frames over the same WebSocket that carries Yjs binary sync and dispatch
 * text frames. This module is the client-side reader: it ingests those
 * frames, maintains a small `Set<string>` of remote install ids, and
 * notifies subscribers on every change.
 *
 * ## Wire shape (server -> client only)
 *
 *   `presence_snapshot` ({ installs: [...] }):
 *     Authoritative state of all currently-connected peers EXCLUDING the
 *     receiver. Sent on every WebSocket upgrade. Replaces the local set.
 *
 *   `presence_added` ({ install }):
 *     Emitted when the FIRST socket for `install` connects to the relay.
 *     Subsequent sockets for the same install (multi-tab) do not produce
 *     additional `presence_added` frames.
 *
 *   `presence_removed` ({ install }):
 *     Emitted when the LAST socket for `install` closes. The relay applies
 *     a small grace window to coalesce graceful tab handoffs into no
 *     wire-visible transition.
 *
 * Clients never SEND presence frames; their connection is the publish.
 *
 * ## Why a dedicated tracker
 *
 * Presence used to be derived from y-protocols Awareness states (per-peer
 * `liveness.installationId`). Awareness is the wrong primitive for
 * "is this install connected right now": it is designed for ephemeral
 * peer-to-peer state (cursors, selections, typing) and not for
 * server-authoritative facts the relay already owns via its `connections`
 * map. See `specs/20260521T121500-server-owned-presence.md` for the full
 * argument.
 */

import type { LiveDevice } from './dispatch.js';

// ════════════════════════════════════════════════════════════════════════════
// WIRE FRAME TYPES (shared by client and server)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Authoritative snapshot of currently-connected installs. Sent by the relay
 * to a freshly-upgraded WebSocket and excludes the receiver's own
 * installationId.
 */
export type PresenceSnapshotFrame = {
	type: 'presence_snapshot';
	installs: string[];
};

/** Broadcast when the first socket for `install` connects. */
export type PresenceAddedFrame = {
	type: 'presence_added';
	install: string;
};

/** Broadcast when the last socket for `install` closes (after grace window). */
export type PresenceRemovedFrame = {
	type: 'presence_removed';
	install: string;
};

// ════════════════════════════════════════════════════════════════════════════
// TRACKER
// ════════════════════════════════════════════════════════════════════════════

export type Presence = {
	/**
	 * Snapshot of currently-known remote installs, sorted and deduped. Self
	 * is always excluded.
	 */
	list(): LiveDevice[];

	/**
	 * Subscribe to set changes. The listener fires on every snapshot,
	 * added, and removed frame that mutates the set; identity-only frames
	 * (e.g. a snapshot that equals the current set) still notify because
	 * the listener is event-driven, not diff-driven.
	 *
	 * Returns an unsubscribe function.
	 */
	subscribe(fn: (devices: LiveDevice[]) => void): () => void;

	/**
	 * Try to parse `rawText` as a presence frame and apply it. Returns
	 * true if the frame was recognized (and thus consumed); false if the
	 * caller should route the text frame elsewhere.
	 */
	handleFrame(rawText: string): boolean;

	/**
	 * Drop every known remote install. Used on disconnect so a subsequent
	 * `presence_snapshot` can rebuild from a clean baseline.
	 */
	reset(): void;

	/**
	 * True once the first `presence_snapshot` has been applied since
	 * construction (or since the last `reset()` followed by a new
	 * snapshot). The daemon's local-liveness pre-check consults this to
	 * suppress `PeerNotFound` during the brief post-upgrade window before
	 * the relay's snapshot arrives.
	 */
	readonly hasSnapshot: boolean;
};

/**
 * Create a new presence tracker bound to `selfInstallationId`.
 *
 * The tracker is purely reactive: it does not open sockets, parse Yjs
 * frames, or talk to the relay directly. The caller (typically
 * `openCollaboration`) feeds it text frames via {@link Presence.handleFrame}.
 */
export function createPresenceTracker(selfInstallationId: string): Presence {
	const installs = new Set<string>();
	const listeners = new Set<(devices: LiveDevice[]) => void>();
	let hasSnapshot = false;

	function snapshot(): LiveDevice[] {
		return Array.from(installs)
			.sort()
			.map((installationId) => ({ installationId }));
	}

	function notify(): void {
		const devices = snapshot();
		for (const listener of listeners) listener(devices);
	}

	return {
		list(): LiveDevice[] {
			return snapshot();
		},

		subscribe(fn: (devices: LiveDevice[]) => void): () => void {
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		},

		handleFrame(rawText: string): boolean {
			let parsed: unknown;
			try {
				parsed = JSON.parse(rawText);
			} catch {
				return false;
			}
			if (!parsed || typeof parsed !== 'object') return false;

			const type = (parsed as { type?: unknown }).type;

			if (type === 'presence_snapshot') {
				const installsRaw = (parsed as { installs?: unknown }).installs;
				if (!Array.isArray(installsRaw)) return false;
				installs.clear();
				for (const id of installsRaw) {
					if (typeof id !== 'string') continue;
					if (id === selfInstallationId) continue;
					installs.add(id);
				}
				hasSnapshot = true;
				notify();
				return true;
			}

			if (type === 'presence_added') {
				const install = (parsed as { install?: unknown }).install;
				if (typeof install !== 'string') return false;
				if (install === selfInstallationId) {
					// The relay never sends our own install in an added frame, but
					// we ignore it defensively so a buggy peer cannot inject self.
					return true;
				}
				const before = installs.size;
				installs.add(install);
				if (installs.size !== before) notify();
				return true;
			}

			if (type === 'presence_removed') {
				const install = (parsed as { install?: unknown }).install;
				if (typeof install !== 'string') return false;
				const existed = installs.delete(install);
				if (existed) notify();
				return true;
			}

			return false;
		},

		reset(): void {
			if (installs.size === 0 && !hasSnapshot) return;
			installs.clear();
			hasSnapshot = false;
			notify();
		},

		get hasSnapshot(): boolean {
			return hasSnapshot;
		},
	};
}
