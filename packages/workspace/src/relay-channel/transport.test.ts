/**
 * The relay floor's data path, proven in one process: the real
 * `createMcpGatewayCatalog` drives an MCP client over the relay-channel
 * transport, across a loopback that stands in for the relay, into the channel
 * acceptor, which pipes to an in-process MCP server. No WebSocket and no spawned
 * child: just the client transport, the acceptor, and the shared bridge.
 *
 * The loopback is a faithful 2-party stand-in for the relay's forwarding (the
 * relay's routing and refusal logic is unit-tested in `packages/server`
 * `channel-router.test.ts`), so this test isolates the channel <-> ByteChannel
 * bridge and the MCP-over-channel framing.
 */

import { expect, test } from 'bun:test';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { composeToolCatalogs } from '../agent/compose-tool-catalogs.js';
import { createMcpGatewayCatalog } from '../agent/mcp-gateway-catalog.js';
import type { ToolCatalog } from '../agent/tools.js';
import { createStreamTransport } from '../mcp-stream-transport.js';
import { asNodeId } from '../document/node-id.js';
import { asRouteName, type ByteChannel } from '../peer-transport.js';
import { createChannelAcceptor } from './acceptor.js';
import type { ChannelFrame } from './protocol.js';
import { type ChannelPort, createRelayChannelTransport } from './transport.js';

const CUSTOMERS = ['Acme | 4200.00', 'Globex | 1500.00', 'Initech | 300.00'];

/** An in-process MCP server with one read-only `customers` tool. */
function miniBooksServer(): Server {
	const server = new Server(
		{ name: 'mini-books', version: '0.0.0' },
		{ capabilities: { tools: {} } },
	);
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			{
				name: 'customers',
				title: 'List customers',
				description: 'Who owes money, by balance.',
				inputSchema: { type: 'object', properties: {} },
				annotations: { readOnlyHint: true },
			},
		],
	}));
	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		if (req.params.name !== 'customers') {
			return {
				content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }],
				isError: true,
			};
		}
		return { content: [{ type: 'text', text: CUSTOMERS.join('\n') }] };
	});
	return server;
}

/**
 * Two linked {@link ByteChannel}s (a socketpair over identity transforms): bytes
 * written to one end's sink arrive on the other end's source.
 */
function byteChannelPair(): [ByteChannel, ByteChannel] {
	const toB = new TransformStream<Uint8Array, Uint8Array>();
	const toA = new TransformStream<Uint8Array, Uint8Array>();
	return [
		{ source: toA.readable, sink: toB.writable },
		{ source: toB.readable, sink: toA.writable },
	];
}

/** Two {@link ChannelPort}s wired so each side's `send` reaches the other's listeners. */
function loopbackPorts(): { caller: ChannelPort; target: ChannelPort } {
	const callerListeners = new Set<(frame: ChannelFrame) => void>();
	const targetListeners = new Set<(frame: ChannelFrame) => void>();
	const deliver = (
		listeners: Set<(frame: ChannelFrame) => void>,
		frame: ChannelFrame,
	) => {
		// Defer like a real socket so a send inside a listener does not reenter.
		queueMicrotask(() => {
			for (const listener of [...listeners]) listener(frame);
		});
	};
	return {
		caller: {
			send: (frame) => deliver(targetListeners, frame),
			onFrame: (listener) => {
				callerListeners.add(listener);
				return () => callerListeners.delete(listener);
			},
		},
		target: {
			send: (frame) => deliver(callerListeners, frame),
			onFrame: (listener) => {
				targetListeners.add(listener);
				return () => targetListeners.delete(listener);
			},
		},
	};
}

test('a relay-channel catalog lists and calls a tool over the loopback floor', async () => {
	const wire = loopbackPorts();

	// Device side: an in-process MCP server reachable as route `books`.
	const [routeEnd, serverEnd] = byteChannelPair();
	const server = miniBooksServer();
	await server.connect(createStreamTransport(serverEnd));
	const acceptor = createChannelAcceptor(wire.target, ({ route }) =>
		route === 'books'
			? { channel: routeEnd, close: () => void server.close() }
			: null,
	);

	// Caller side: the browser-shaped relay-channel transport, consumed by the
	// real cross-device catalog with no change.
	const transport = createRelayChannelTransport(wire.caller);
	const catalog = await createMcpGatewayCatalog({
		transport,
		target: asNodeId('laptop'),
		route: asRouteName('books'),
	});

	expect(catalog.definitions().map((d) => d.name)).toEqual(['customers']);
	expect(catalog.definitions()[0]?.kind).toBe('query');

	const outcome = await catalog.resolve(
		{ toolCallId: 't1', toolName: 'customers', input: {} },
		new AbortController().signal,
	);
	expect(outcome.isError).toBe(false);
	expect(outcome.output).toBe(CUSTOMERS.join('\n'));

	await catalog[Symbol.asyncDispose]();
	transport.close();
	acceptor.close();
});

test('a composed catalog routes a tool call to the floor gateway, the rest stays local', async () => {
	// The closest headless proof of prompt 1's claim: a client agent loop drives a
	// `tools/call` to a device's relay-exposed route over the floor with no
	// dispatch path, while its own in-process tools still resolve locally. This
	// exercises the REAL gateway catalog + `composeToolCatalogs` together (the
	// server stamp/route is `channel-router.test.ts`; the same-room requirement is
	// verified by inspection). It is NOT the live two-daemon smoke prompt 1 defines.
	const wire = loopbackPorts();

	const [routeEnd, serverEnd] = byteChannelPair();
	const server = miniBooksServer();
	await server.connect(createStreamTransport(serverEnd));
	const acceptor = createChannelAcceptor(wire.target, ({ route }) =>
		route === 'books'
			? { channel: routeEnd, close: () => void server.close() }
			: null,
	);

	const transport = createRelayChannelTransport(wire.caller);
	const gateway = await createMcpGatewayCatalog({
		transport,
		target: asNodeId('laptop'),
		route: asRouteName('books'),
	});

	// A stand-in for the app's in-process catalog (opensidian's file/bash actions).
	const local: ToolCatalog = {
		definitions: () => [{ name: 'files_read', kind: 'query' }],
		resolve: async () => ({ output: 'local file body', isError: false }),
	};

	// Local first so a local action shadows a same-named remote tool.
	const merged = composeToolCatalogs([local, gateway]);

	expect(merged.definitions().map((d) => d.name).sort()).toEqual([
		'customers',
		'files_read',
	]);

	const signal = new AbortController().signal;
	const remote = await merged.resolve(
		{ toolCallId: 'r1', toolName: 'customers', input: {} },
		signal,
	);
	expect(remote.isError).toBe(false);
	expect(remote.output).toBe(CUSTOMERS.join('\n'));

	const localOutcome = await merged.resolve(
		{ toolCallId: 'l1', toolName: 'files_read', input: {} },
		signal,
	);
	expect(localOutcome.output).toBe('local file body');

	await gateway[Symbol.asyncDispose]();
	transport.close();
	acceptor.close();
});

test('a catalog for an unknown route is refused', async () => {
	const wire = loopbackPorts();
	const acceptor = createChannelAcceptor(wire.target, () => null); // every route refused
	const transport = createRelayChannelTransport(wire.caller);

	let refused = false;
	try {
		await createMcpGatewayCatalog({
			transport,
			target: asNodeId('laptop'),
			route: asRouteName('books'),
			connectTimeoutMs: 2000,
		});
	} catch {
		refused = true;
	}
	expect(refused).toBe(true);

	transport.close();
	acceptor.close();
});
