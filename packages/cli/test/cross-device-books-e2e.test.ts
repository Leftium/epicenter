/**
 * The Wave 5a acceptance: the cross-device tool loop end to end against the REAL
 * `local-books mcp` server, node-only.
 *
 * Two in-process device gateways over iroh loopback stand in for two laptops.
 * The server gateway exposes a `books` route that spawns the real `local-books
 * mcp` child against a demo-seeded company. A `verified` dialer opens an MCP
 * catalog over the gateway, lists the tools, and runs the "who owes me money?"
 * query, getting Acme/Globex/Initech back. A merely `listed` dialer is refused
 * the `verified`-only `books` route before any tool runs.
 *
 * This lives in `packages/cli`, the integration layer that legitimately consumes
 * both `@epicenter/workspace` (the gateway + catalog) and `@epicenter/local-books`
 * (spawned as a child, never imported): the workspace library must not depend on
 * an app, and local-books must not depend on the workspace (ADR-0072/0073). The
 * workspace package proves the same path against a fixture MCP server in
 * `mcp-gateway-catalog.test.ts`; this proves it against the genuine server.
 */

import { afterAll, afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TrustState } from '@epicenter/workspace/account';
import {
	asPeerId,
	asRouteName,
	createLocalGatewayTransport,
	createMcpGatewayCatalog,
	createPeerGateway,
	generateDeviceSecret,
	type PeerGateway,
	type PeerId,
} from '@epicenter/workspace/gateway';

const LOCAL_BOOKS_BIN = fileURLToPath(
	new URL('../../../apps/local-books/src/bin.ts', import.meta.url),
);
const BOOKS = asRouteName('books');

// Seed one demo company once; every test's `local-books mcp` child reads it.
const dataDir = mkdtempSync(join(tmpdir(), 'cli-books-e2e-'));
const bookEnv = {
	...process.env,
	LOCAL_BOOKS_DIR: dataDir,
	LOCAL_BOOKS_QB_REALM: 'demo',
};
const seed = spawnSync('bun', ['run', LOCAL_BOOKS_BIN, 'demo'], {
	env: bookEnv,
	stdio: 'ignore',
});
if (seed.status !== 0) {
	throw new Error(`local-books demo seed failed (status ${seed.status})`);
}

const BOOKS_ROUTE = {
	command: 'bun',
	args: ['run', LOCAL_BOOKS_BIN, 'mcp'],
	env: {
		LOCAL_BOOKS_DIR: dataDir,
		LOCAL_BOOKS_QB_REALM: 'demo',
	},
	requires: 'verified' as const,
};

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

afterAll(() => {
	rmSync(dataDir, { recursive: true, force: true });
});

async function gateway(options: Parameters<typeof createPeerGateway>[0]) {
	const gw = await createPeerGateway(options);
	opened.push(gw);
	return gw;
}

test(
	'a verified dialer lists and queries the real local-books mcp tools',
	async () => {
		const dialerSecret = generateDeviceSecret();
		const dialerId = asPeerId(dialerSecret.public().toString());

		const server = await gateway({
			secret: generateDeviceSecret(),
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

		// The real server publishes query/report/status (+ recategorize unless
		// read-only). We only assert the read tool the next step exercises.
		const toolNames = catalog.definitions().map((d) => d.name);
		expect(toolNames).toContain('query');

		const outcome = await catalog.resolve(
			{
				toolCallId: '1',
				toolName: 'query',
				input: {
					sql: 'SELECT display_name, balance FROM customers ORDER BY balance DESC',
				},
			},
			AbortSignal.timeout(10_000),
		);
		expect(outcome.isError).toBe(false);
		const text = String(outcome.output);
		expect(text).toContain('Acme');
		expect(text).toContain('Globex');
		expect(text).toContain('Initech');
	},
	30_000,
);

test(
	'a merely-listed dialer is refused the verified-only books route',
	async () => {
		const dialerSecret = generateDeviceSecret();
		const dialerId = asPeerId(dialerSecret.public().toString());

		const server = await gateway({
			secret: generateDeviceSecret(),
			routes: { books: BOOKS_ROUTE },
			trust: fixedTrust([[dialerId, 'listed']]),
		});
		server.listen();

		const dialer = await gateway({
			secret: dialerSecret,
			routes: {},
			trust: fixedTrust([]),
		});

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
	},
	30_000,
);
