/**
 * `exposedRoutesByKind`: the floor's discovery contract. The split is what keeps a
 * consumer's MCP auto-mount from mis-dialing a service route as MCP, so these tests
 * pin that a service route NEVER lands in the spawn bucket and a refused route in
 * neither.
 */

import { expect, test } from 'bun:test';
import { exposedRoutesByKind, type RouteTable } from './route-table.js';

test('partitions exposed routes by kind; refused routes appear in neither', () => {
	const routes: RouteTable = {
		books: { kind: 'spawn', command: 'local-books', args: ['mcp'], relay: 'exposed' },
		whisper: { kind: 'service', service: { port: 8000 }, relay: 'exposed' },
		secret: { kind: 'spawn', command: 'shell' }, // refused (no relay)
		idle: { kind: 'service', service: { port: 9000 } }, // refused (no relay)
	};

	const { spawn, service } = exposedRoutesByKind(routes);

	expect(spawn).toEqual(['books']);
	expect(service).toEqual(['whisper']);
});

test('a service route never lands in the spawn bucket (Finding B)', () => {
	const routes: RouteTable = {
		whisper: { kind: 'service', service: { port: 8000 }, relay: 'exposed' },
	};

	const { spawn, service } = exposedRoutesByKind(routes);

	expect(spawn).toEqual([]);
	expect(service).toEqual(['whisper']);
});

test('an empty table exposes nothing', () => {
	expect(exposedRoutesByKind({})).toEqual({ spawn: [], service: [] });
});
