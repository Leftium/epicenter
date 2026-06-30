/**
 * Hono app for the `epicenter daemon up` daemon. Single source of truth for the
 * routes; the daemon server wires its fetch handler into Bun's listener and
 * the hand-rolled `daemonClient` in `./client.ts` POSTs against it.
 *
 * Each route is a one-line shell shortcut for one daemon runtime primitive:
 *
 *   /peers  ->  collaboration.peers.list()
 *   /list   ->  mount label + bare action manifest
 *   /run    ->  invokeAction(...) locally, or collab.dispatch(...)
 *               on a peer when `peer` is present
 *
 * Each route returns the handler's `Result<T, DomainErr>` body directly.
 * Unexpected exceptions propagate to Hono's default error handler (HTTP
 * 500), which the client maps to `DaemonError.HandlerCrashed`. There is
 * no second on-the-wire envelope: `Result<Result<...>, ...>` is gone.
 */

import { sValidator } from '@hono/standard-validator';
import { type } from 'arktype';
import { Hono } from 'hono';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { JsonValue } from 'wellcrafted/json';
import { Ok, tryAsync } from 'wellcrafted/result';
import { createMcpGatewayCatalog } from '../agent/mcp-gateway-catalog.js';
import type { AgentToolDefinition, AgentToolOutcome } from '../agent/tools.js';
import { asNodeId } from '../document/node-id.js';
import { asRouteName } from '../peer-transport.js';
import { type ActionManifest, toActionMeta } from '../shared/actions.js';
import { executeRun } from './action-handler.js';
import type {
	DaemonServedAccountRoom,
	DaemonServedDeviceGateway,
	DaemonServedMount,
} from './types.js';

/**
 * Wire body for `/run`. The schema serves two roles:
 *
 *   1. Envelope validation at the daemon boundary via
 *      `@hono/standard-validator`: it checks the request shape (`actionPath`
 *      present, `input` present) so a stale CLI gets a typed 400, NOT the
 *      action's input shape. The input (`unknown` here) is validated against
 *      the resolved action's own schema downstream in `invokeAction`.
 *   2. Compile-time inference for the hand-rolled client; both sides import
 *      the exact same shape.
 *
 * `peer` selects the execution target: absent runs the action on this
 * daemon, present dispatches it to `peer.to`. Grouping the peer fields into
 * one optional object makes the co-occurrence invariant structural: a
 * `waitMs` (peer RPC deadline; the daemon owns its default) cannot exist
 * without a peer target.
 *
 * Naming follows arktype's idiom (one PascalCase name declares both the
 * value and the type).
 */
export const RunRequest = type({
	actionPath: 'string',
	input: 'unknown',
	'peer?': {
		to: 'string',
		'waitMs?': 'number',
	},
});
export type RunRequest = typeof RunRequest.infer;

/**
 * Row shape returned by `/peers`. One row per live peer node.
 *
 * `nodeId` is the install-stable, client-claimed identity and the address
 * used by `collab.dispatch({ to })`. There is no per-socket `connectionId`
 * or server-stamped identity on the wire. The relay routes by `nodeId`
 * inside the already authorized sync room.
 */
export const PeerSnapshot = type({
	nodeId: 'string',
});
export type PeerSnapshot = typeof PeerSnapshot.infer;

/** Snapshot returned by `/list`: one mount label, bare action keys. */
export type DaemonListSnapshot = {
	mount: string;
	actions: ActionManifest;
};

/**
 * Row shape returned by `/relay-peers`. One row per same-owner device currently
 * connected to the relay floor (the account room's live presence). `nodeId` is
 * the dial target: `tools`/`call` route to it over the relay. Distinct from
 * `/peers`, which is who is editing THIS workspace room.
 */
export const RelayPeerSnapshot = type({
	nodeId: 'string',
});
export type RelayPeerSnapshot = typeof RelayPeerSnapshot.infer;

/**
 * Wire body for `/tools`: list the catalog of one route on one target device.
 * `device` is the target's nodeId (the dial target the relay routes to); `route`
 * is the named route on its gateway (e.g. `books`).
 */
export const ToolsRequest = type({
	device: 'string',
	route: 'string',
});
export type ToolsRequest = typeof ToolsRequest.infer;

/**
 * Wire body for `/call`: invoke one tool on one route of one target device.
 * `input` is the tool's JSON argument object (validated against the remote tool's
 * own schema downstream, MCP-side).
 */
export const CallRequest = type({
	device: 'string',
	route: 'string',
	tool: 'string',
	input: 'unknown',
});
export type CallRequest = typeof CallRequest.infer;

/**
 * Tagged error for the cross-device tool routes. `Unavailable` means this daemon
 * has no live gateway to dial through (signed out, or it failed to open).
 * `DialFailed` means the channel to the target route could not be opened: the
 * route refused this device (wrong owner, or the route is not relay-exposed), the
 * peer is offline, or the MCP handshake timed out. The refusal and the offline
 * case are indistinguishable to the dialer by design (a refused channel is just
 * reset), so both surface here.
 */
export const DeviceGatewayError = defineErrors({
	Unavailable: () => ({
		message:
			'no device gateway: the daemon has no signed-in session or the gateway failed to open. Sign in, then restart `epicenter daemon up`.',
	}),
	DialFailed: ({
		device,
		route,
		cause,
	}: {
		device: string;
		route: string;
		cause: unknown;
	}) => ({
		message: `could not reach route "${route}" on ${device}: ${extractErrorMessage(cause)}. The device may be offline, or the route is not exposed over the relay.`,
		device,
		route,
		cause,
	}),
});
export type DeviceGatewayError = InferErrors<typeof DeviceGatewayError>;

/**
 * Build the daemon's Hono app. Tests import this directly; production serves
 * the app through the daemon server factory.
 *
 * The daemon serves one mounted runtime. Its socket is the route; the mount
 * name is a label for CLI display, never an internal dispatch key. Actions are
 * addressed by their bare key on the wire and in the CLI alike.
 */
export function buildDaemonApp(
	mount: DaemonServedMount,
	accountRoom?: DaemonServedAccountRoom,
	deviceGateway?: DaemonServedDeviceGateway,
) {
	return new Hono()
		.post('/ping', (c) => c.json(Ok('pong' as const)))
		.post('/peers', (c) => {
			const rows: PeerSnapshot[] = [];
			const collaboration = mount.runtime.collaboration;
			if (!collaboration) return c.json(Ok(rows));
			for (const peer of collaboration.peers.list()) {
				rows.push({ nodeId: peer.nodeId });
			}
			return c.json(Ok(rows));
		})
		.post('/relay-peers', (c) => {
			const rows: RelayPeerSnapshot[] = [];
			if (!accountRoom) return c.json(Ok(rows));
			for (const peer of accountRoom.peers()) {
				rows.push({ nodeId: peer.nodeId });
			}
			return c.json(Ok(rows));
		})
		.post('/tools', sValidator('json', ToolsRequest), async (c) => {
			if (!deviceGateway) return c.json(DeviceGatewayError.Unavailable());
			const { device, route } = c.req.valid('json');
			const { data, error } = await tryAsync({
				try: async () => {
					await using catalog = await createMcpGatewayCatalog({
						transport: deviceGateway.transport,
						target: asNodeId(device),
						route: asRouteName(route),
					});
					return catalog.definitions();
				},
				catch: (cause) =>
					DeviceGatewayError.DialFailed({ device, route, cause }),
			});
			if (error !== null) return c.json(error);
			return c.json(Ok<AgentToolDefinition[]>(data));
		})
		.post('/call', sValidator('json', CallRequest), async (c) => {
			if (!deviceGateway) return c.json(DeviceGatewayError.Unavailable());
			const { device, route, tool, input } = c.req.valid('json');
			const { data, error } = await tryAsync({
				try: async () => {
					await using catalog = await createMcpGatewayCatalog({
						transport: deviceGateway.transport,
						target: asNodeId(device),
						route: asRouteName(route),
					});
					// Await before the scope's `await using` disposes the catalog, or the
					// MCP client closes while the call is still in flight.
					return await catalog.resolve(
						{
							toolCallId: '1',
							toolName: tool,
							input: (input ?? null) as JsonValue,
						},
						c.req.raw.signal,
					);
				},
				catch: (cause) =>
					DeviceGatewayError.DialFailed({ device, route, cause }),
			});
			if (error !== null) return c.json(error);
			return c.json(Ok<AgentToolOutcome>(data));
		})
		.post('/list', (c) => {
			const actions: ActionManifest = {};
			for (const [path, action] of Object.entries(mount.runtime.actions)) {
				actions[path] = toActionMeta(action);
			}
			return c.json(Ok({ mount: mount.mount, actions }));
		})
		.post('/run', sValidator('json', RunRequest), async (c) => {
			const request = c.req.valid('json');
			return c.json(await executeRun(mount, request));
		});
}
