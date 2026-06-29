/**
 * The relay route opener is the endpoint gate on the relay path, so the test
 * pins its refusals: only this daemon's authenticated owner, only an explicitly
 * relay-exposed route. A sensitive route (iroh-only `requires`, no `relay`) and
 * any other identity are refused before a child is ever spawned.
 */

import { afterEach, expect, test } from 'bun:test';
import { createRelayRouteOpener } from './relay-route.js';
import type { RouteTable } from './route-table.js';

const opened: Array<{ close(): void }> = [];
afterEach(() => {
	for (const target of opened.splice(0)) target.close();
});

const routes: RouteTable = {
	// A low-risk route opted IN to the relay floor.
	echo: {
		command: 'bun',
		args: ['-e', 'process.stdin.on("data",(d)=>process.stdout.write(d));'],
		relay: 'exposed',
	},
	// A sensitive route: refused over the relay by default (no `relay`).
	books: { command: 'local-books', args: ['mcp'] },
};

const owner = { kind: 'user', userId: 'u1' } as const;

test('admits an exposed route for the owner', () => {
	const open = createRelayRouteOpener({ routes, ownerUserId: 'u1' });
	const target = open({ route: 'echo', source: owner });
	expect(target).not.toBeNull();
	if (target) opened.push(target);
});

test('refuses a route not exposed over the relay (iroh-only stays iroh-only)', () => {
	const open = createRelayRouteOpener({ routes, ownerUserId: 'u1' });
	expect(open({ route: 'books', source: owner })).toBeNull();
});

test('refuses a source that is not the owner', () => {
	const open = createRelayRouteOpener({ routes, ownerUserId: 'u1' });
	expect(
		open({ route: 'echo', source: { kind: 'user', userId: 'attacker' } }),
	).toBeNull();
});

test('refuses a missing source (no compliant relay stamped one)', () => {
	const open = createRelayRouteOpener({ routes, ownerUserId: 'u1' });
	expect(open({ route: 'echo' })).toBeNull();
});

test('refuses an unknown route', () => {
	const open = createRelayRouteOpener({ routes, ownerUserId: 'u1' });
	expect(open({ route: 'ghost', source: owner })).toBeNull();
});
