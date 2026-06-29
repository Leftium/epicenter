/**
 * Loopback test for the MCP gateway catalog over an in-memory transport.
 *
 * A fake {@link PeerTransport} opens each channel straight onto a spawned route
 * child (a tiny fixture MCP server, `test-fixtures/mini-mcp-server.ts`, standing
 * in for `local-books mcp`). The catalog is transport-blind, so this exercises
 * the productized path PeerTransport -> StreamTransport -> MCP Client ->
 * ToolCatalog with no transport-specific machinery. The relay path's own
 * authorization (owner + relay-exposed route) is covered in
 * `gateway/relay-route.test.ts`.
 */

import { afterEach, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import {
	openRouteTarget,
	type RouteTable,
	type RouteTarget,
} from '../gateway/route-table.js';
import {
	asPeerId,
	asRouteName,
	type OpenChannelOptions,
	type PeerTransport,
} from '../peer-transport.js';
import { createMcpGatewayCatalog } from './mcp-gateway-catalog.js';

const MINI_SERVER = fileURLToPath(
	new URL('./test-fixtures/mini-mcp-server.ts', import.meta.url),
);
const BOOKS = asRouteName('books');
const ROUTES: RouteTable = {
	books: { command: 'bun', args: ['run', MINI_SERVER] },
};

const spawned: RouteTarget[] = [];
const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const dispose of disposers.splice(0)) await dispose().catch(() => {});
	for (const target of spawned.splice(0)) target.close();
});

/** A {@link PeerTransport} that pipes each opened channel to a spawned route child. */
function inMemoryTransport(routes: RouteTable): PeerTransport {
	return {
		async openChannel({ route }: OpenChannelOptions) {
			const target = openRouteTarget(routes[route]!);
			spawned.push(target);
			return target.channel;
		},
	};
}

test('lists and calls the route MCP tools over the catalog', async () => {
	const catalog = await createMcpGatewayCatalog({
		transport: inMemoryTransport(ROUTES),
		target: asPeerId('test-device'),
		route: BOOKS,
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
