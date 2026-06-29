/**
 * Loopback integration test for the MCP gateway catalog.
 *
 * Two in-process gateways over real iroh loopback: a `verified` dialer opens a
 * catalog against the server's `books` route, lists its tools, and calls one,
 * getting the customers answer back over the dumb-piped MCP session. A merely
 * `listed` dialer is refused the `verified`-only `books` route before the MCP
 * handshake completes.
 *
 * The route target is a tiny fixture MCP server (`test-fixtures/mini-mcp-server.ts`)
 * standing in for `local-books mcp`; the real-`local-books` acceptance lives in
 * `packages/cli`. This proves the productized path (PeerTransport ->
 * StreamTransport -> MCP Client -> ToolCatalog) end to end.
 */

import { afterEach, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { SecretKey } from '@number0/iroh';
import type { TrustState } from '../account/reducer.js';
import { createLocalGatewayTransport } from '../gateway/local-gateway-transport.js';
import { createPeerGateway, type PeerGateway } from '../gateway/gateway.js';
import {
	asPeerId,
	asRouteName,
	type PeerId,
} from '../peer-transport.js';
import { createMcpGatewayCatalog } from './mcp-gateway-catalog.js';

const MINI_SERVER = fileURLToPath(
	new URL('./test-fixtures/mini-mcp-server.ts', import.meta.url),
);
const BOOKS_ROUTE = {
	command: 'bun',
	args: ['run', MINI_SERVER],
	requires: 'verified' as const,
};
const BOOKS = asRouteName('books');

function fixedTrust(
	entries: Iterable<[PeerId, TrustState]>,
): (peerId: PeerId) => TrustState | undefined {
	const states = new Map(entries);
	return (peerId) => states.get(peerId);
}

const opened: PeerGateway[] = [];
const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const dispose of disposers.splice(0)) await dispose().catch(() => {});
	for (const gw of opened.splice(0)) await gw.close().catch(() => {});
});

async function gateway(options: Parameters<typeof createPeerGateway>[0]) {
	const gw = await createPeerGateway(options);
	opened.push(gw);
	return gw;
}

test('a verified dialer lists and calls the route MCP tools', async () => {
	const dialerSecret = SecretKey.generate();
	const dialerId = asPeerId(dialerSecret.public().toString());

	const server = await gateway({
		secret: SecretKey.generate(),
		routes: { books: BOOKS_ROUTE },
		trust: fixedTrust([[dialerId, 'verified']]),
	});
	server.listen();

	const dialer = await gateway({
		secret: dialerSecret,
		routes: {},
		trust: fixedTrust([]),
	});

	const catalog = await createMcpGatewayCatalog({
		transport: createLocalGatewayTransport(dialer),
		target: server.peerId,
		route: BOOKS,
		hintAddrs: server.boundSockets(),
	});
	disposers.push(() => catalog[Symbol.asyncDispose]());

	const definitions = catalog.definitions();
	expect(definitions.map((d) => d.name)).toEqual(['customers']);
	// The fixture publishes readOnlyHint, so the catalog marks it a query.
	expect(definitions[0]?.kind).toBe('query');

	const outcome = await catalog.resolve(
		{ toolCallId: '1', toolName: 'customers', input: {} },
		AbortSignal.timeout(5000),
	);
	expect(outcome.isError).toBe(false);
	expect(outcome.output).toContain('Acme');
	expect(outcome.output).toContain('Globex');
});

test('a merely-listed dialer is refused the verified-only books route', async () => {
	const dialerSecret = SecretKey.generate();
	const dialerId = asPeerId(dialerSecret.public().toString());

	const server = await gateway({
		secret: SecretKey.generate(),
		routes: { books: BOOKS_ROUTE },
		trust: fixedTrust([[dialerId, 'listed']]),
	});
	server.listen();

	const dialer = await gateway({
		secret: dialerSecret,
		routes: {},
		trust: fixedTrust([]),
	});

	// Opening the catalog must throw: the route refuses a listed peer at Ring 0,
	// so the MCP handshake never completes and the connect times out (the refusal
	// signal). A short timeout keeps the test fast.
	let refused = false;
	try {
		const catalog = await createMcpGatewayCatalog({
			transport: createLocalGatewayTransport(dialer),
			target: server.peerId,
			route: BOOKS,
			hintAddrs: server.boundSockets(),
			connectTimeoutMs: 2500,
		});
		disposers.push(() => catalog[Symbol.asyncDispose]());
	} catch {
		refused = true;
	}
	expect(refused).toBe(true);
});
