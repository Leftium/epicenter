/**
 * Cross-device tools over the relay floor for one signed-in opensidian session.
 *
 * This is what makes the floor load-bearing in the app (ADR-0073): it opens this
 * device's own account-room connection (the per-user fleet room every device
 * joins) and AUTO-MOUNTS every relay-exposed route the user's other online
 * devices advertise in presence. No picker: the consent boundary is the daemon
 * exposing a route (`--relay-expose books`, default refused); a browser is a pure
 * consumer that reflects whatever its fleet exposes. The mounted catalogs compose
 * beside opensidian's in-process action catalog in `session.ts`.
 *
 * Each device's tools are namespaced by `<shortNodeId>_<route>` so two devices
 * serving the same route (two boxes both running `local-books`) coexist instead
 * of colliding under the composite's first-wins rule. The mounted set is
 * reconciled against presence: a device coming online mounts its routes, one
 * dropping unmounts them.
 */

import {
	type AccountRoomConnectionConfig,
	asNodeId,
	openAccountRoomConnection,
	type Peer,
} from '@epicenter/workspace';
import {
	createMcpGatewayCatalog,
	type McpGatewayCatalog,
	namespaceToolCatalog,
	type ToolCatalog,
} from '@epicenter/workspace/agent';
import {
	asRouteName,
	createRelayChannelTransport,
} from '@epicenter/workspace/relay-channel';

/** One mounted (device, route): the live MCP session plus its namespaced view. */
type Mount = {
	nodeId: string;
	route: string;
	/** The namespaced catalog the session composes. */
	catalog: ToolCatalog;
	/** The live MCP session to close on unmount. */
	session: McpGatewayCatalog;
};

/** Stable per-mount key: a device serves at most one session per route. */
const mountKey = (nodeId: string, route: string) => `${nodeId}::${route}`;

/** A collision-free, `__`-free prefix identifying one device's route. */
function routePrefix(nodeId: string, route: string): string {
	const short = nodeId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
	return `${short}_${route}`;
}

export function createCrossDeviceToolsState(config: AccountRoomConnectionConfig) {
	const accountRoom = openAccountRoomConnection(config);
	const transport = createRelayChannelTransport(accountRoom.channelPort);

	const mounts = new Map<string, Mount>();
	/** Keys currently being dialed, so a presence flap does not double-mount. */
	const inFlight = new Set<string>();
	/** The ready namespaced catalogs, for the session composite. Reassigned to notify. */
	let catalogs = $state<ToolCatalog[]>([]);
	/** The mounted sources, for a passive UI hint. Reassigned alongside `catalogs`. */
	let sources = $state<{ nodeId: string; route: string }[]>([]);

	function publishCatalogs(): void {
		const live = [...mounts.values()];
		catalogs = live.map((mount) => mount.catalog);
		sources = live.map(({ nodeId, route }) => ({ nodeId, route }));
	}

	async function mount(nodeId: string, route: string): Promise<void> {
		const key = mountKey(nodeId, route);
		if (mounts.has(key) || inFlight.has(key)) return;
		inFlight.add(key);
		try {
			const session = await createMcpGatewayCatalog({
				transport,
				target: asNodeId(nodeId),
				route: asRouteName(route),
			});
			// A presence tick may have dropped this device while we dialed; if so,
			// drop the session we just opened rather than mounting a stale one.
			if (!inFlight.has(key)) {
				await session[Symbol.asyncDispose]();
				return;
			}
			mounts.set(key, {
				nodeId,
				route,
				session,
				catalog: namespaceToolCatalog(routePrefix(nodeId, route), session),
			});
			publishCatalogs();
		} catch {
			// Refused or offline: skip. A later presence tick reconciles a retry.
		} finally {
			inFlight.delete(key);
		}
	}

	async function unmount(key: string): Promise<void> {
		// Cancel an in-flight dial so its late resolve drops its session (see mount).
		inFlight.delete(key);
		const mount = mounts.get(key);
		if (!mount) return;
		mounts.delete(key);
		publishCatalogs();
		await mount.session[Symbol.asyncDispose]();
	}

	/** Mount what presence advertises, unmount what it no longer does. */
	function reconcile(peers: Peer[]): void {
		const desired = new Set<string>();
		for (const peer of peers) {
			for (const route of peer.exposedRoutes ?? []) {
				desired.add(mountKey(peer.nodeId, route));
				void mount(peer.nodeId, route);
			}
		}
		for (const key of [...mounts.keys(), ...inFlight]) {
			if (!desired.has(key)) void unmount(key);
		}
	}

	reconcile(accountRoom.peers());
	const unsubscribePeers = accountRoom.onPeersChange(reconcile);

	return {
		/** The ready namespaced cross-device catalogs, for the session composite. */
		catalogs(): ToolCatalog[] {
			return catalogs;
		},
		/** How many cross-device tool sources are mounted (for a passive UI hint). */
		get sourceCount(): number {
			return sources.length;
		},
		/** Mounted sources as `{ nodeId, route }`, for a passive UI hint. */
		get sources(): { nodeId: string; route: string }[] {
			return sources;
		},
		async [Symbol.asyncDispose](): Promise<void> {
			unsubscribePeers();
			inFlight.clear();
			for (const mount of mounts.values()) {
				await mount.session[Symbol.asyncDispose]();
			}
			mounts.clear();
			transport.close();
			await accountRoom[Symbol.asyncDispose]();
		},
	};
}

export type CrossDeviceToolsState = ReturnType<
	typeof createCrossDeviceToolsState
>;
