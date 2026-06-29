/**
 * Cross-device tools over the relay floor for one signed-in opensidian session.
 *
 * This is what makes the floor load-bearing in the app (ADR-0073): it opens this
 * device's own account-room connection (the per-user fleet room every device
 * joins) and, when the user picks one of their other online devices, drives an
 * MCP `tools/call` to that device's relay-exposed route over the account-room
 * socket. No in-room dispatch path is involved; the gateway catalog it produces
 * is composed beside opensidian's in-process action catalog in `session.ts`.
 *
 * Single active device: connecting to one replaces the prior. The session's
 * composite is first-wins on tool name, so two devices serving the same route
 * (two boxes both running `local-books` over `books`) would collide: the second
 * device's identically-named tools would never surface and every call would route
 * to the first. Holding one active device sidesteps that; multi-device needs
 * per-device tool namespacing and is deferred.
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
	type ToolCatalog,
} from '@epicenter/workspace/agent';
import {
	asRouteName,
	createRelayChannelTransport,
} from '@epicenter/workspace/relay-channel';

/** The default relay-exposed route a device serves (Local Books MCP). */
export const DEFAULT_CROSS_DEVICE_ROUTE = 'books';

/** The device the session is currently reaching tools on, and how that dial is going. */
export type ActiveDevice = {
	/** The target device's routing id, as presence reports it (a bare string). */
	nodeId: string;
	route: string;
	status: 'connecting' | 'ready' | 'error';
	/** Set only when `status` is `'error'`: the refusal or timeout message. */
	error?: string;
};

export function createCrossDeviceToolsState(config: AccountRoomConnectionConfig) {
	const accountRoom = openAccountRoomConnection(config);
	const transport = createRelayChannelTransport(accountRoom.channelPort);

	let peers = $state<Peer[]>(accountRoom.peers());
	const unsubscribePeers = accountRoom.onPeersChange((next) => {
		peers = next;
	});

	let active = $state<ActiveDevice | null>(null);
	let activeCatalog: McpGatewayCatalog | null = null;

	async function disposeActiveCatalog(): Promise<void> {
		const catalog = activeCatalog;
		activeCatalog = null;
		if (catalog) await catalog[Symbol.asyncDispose]();
	}

	/** Whether `active` still names the dial we are awaiting (not superseded). */
	function stillActive(nodeId: string, route: string): boolean {
		return active?.nodeId === nodeId && active.route === route;
	}

	return {
		/** This user's other online devices, live (newest-wins per nodeId, self excluded). */
		get peers(): Peer[] {
			return peers;
		},
		/** The device tools are being reached on, or `null` for local-only. */
		get active(): ActiveDevice | null {
			return active;
		},
		/**
		 * The ready gateway catalog as a list, for the session's composite. Empty
		 * until a device is connected and its `tools/list` has answered.
		 */
		catalogs(): ToolCatalog[] {
			return activeCatalog && active?.status === 'ready' ? [activeCatalog] : [];
		},
		/**
		 * Reach one device's route, replacing any prior active device. Opens the
		 * channel and runs the MCP handshake; a refused or offline route surfaces as
		 * `status: 'error'` rather than throwing.
		 */
		async connect(
			nodeId: string,
			route: string = DEFAULT_CROSS_DEVICE_ROUTE,
		): Promise<void> {
			await disposeActiveCatalog();
			active = { nodeId, route, status: 'connecting' };
			try {
				const catalog = await createMcpGatewayCatalog({
					transport,
					target: asNodeId(nodeId),
					route: asRouteName(route),
				});
				// A newer connect/disconnect may have superseded this dial while we
				// awaited the handshake; if so, drop the catalog we just opened.
				if (!stillActive(nodeId, route)) {
					await catalog[Symbol.asyncDispose]();
					return;
				}
				activeCatalog = catalog;
				active = { nodeId, route, status: 'ready' };
			} catch (error) {
				if (stillActive(nodeId, route)) {
					active = {
						nodeId,
						route,
						status: 'error',
						error: error instanceof Error ? error.message : String(error),
					};
				}
			}
		},
		/** Drop the active device, leaving the session with only its local tools. */
		async disconnect(): Promise<void> {
			await disposeActiveCatalog();
			active = null;
		},
		async [Symbol.asyncDispose](): Promise<void> {
			unsubscribePeers();
			await disposeActiveCatalog();
			transport.close();
			await accountRoom[Symbol.asyncDispose]();
		},
	};
}

export type CrossDeviceToolsState = ReturnType<
	typeof createCrossDeviceToolsState
>;
