/**
 * Loopback integration test for the device gateway.
 *
 * Proves the Wave 1 invariants WITHOUT MCP or local-books: real iroh endpoints
 * over loopback, an enrolled dialer admitted and dumb-piped to a route child,
 * an unenrolled dialer refused before any byte reaches the child, and a durable
 * keyfile yielding a stable PeerId across "restarts".
 *
 * The route target is a tiny unbuffered echo (`bun -e`), so the test exercises
 * the gateway's pipe mechanics without depending on any real executor. The full
 * MCP + local-books acceptance (tools/list = query,status,... ; customers
 * returns Acme/Globex/Initech) stays the proto baseline's job, end-to-end over
 * iroh.
 */

import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretKey } from '@number0/iroh';
import type { TrustState } from '../account/reducer.js';
import { createPeerGateway, type PeerGateway } from './gateway.js';
import { loadOrCreateDeviceSecret } from './key-store.js';
import { asPeerId, asRouteName, type ByteChannel, type PeerId } from './transport.js';

// An echo child that flushes each chunk immediately (cat block-buffers a small
// write and would never echo before EOF).
const ECHO_ROUTE = {
	command: 'bun',
	args: ['-e', 'process.stdin.on("data",(d)=>process.stdout.write(d));'],
};
const ECHO = asRouteName('echo');

/** A trust resolver backed by a fixed map; unlisted peers read `undefined`. */
function fixedTrust(
	entries: Iterable<[PeerId, TrustState]>,
): (peerId: PeerId) => TrustState | undefined {
	const states = new Map(entries);
	return (peerId) => states.get(peerId);
}

const opened: Array<{ close(): Promise<void> }> = [];
const tmpDirs: string[] = [];

afterEach(async () => {
	for (const gw of opened.splice(0)) await gw.close().catch(() => {});
	for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), 'gateway-test-'));
	tmpDirs.push(dir);
	return dir;
}

async function track(gw: Promise<PeerGateway>): Promise<PeerGateway> {
	const g = await gw;
	opened.push(g);
	return g;
}

/** Write `ping` to the channel and resolve with the first echoed bytes, or
 *  null on EOF/timeout (the refusal signal). */
function probe(channel: ByteChannel, ms = 4000): Promise<string | null> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(null), ms);
		channel.source.once('data', (chunk: Buffer) => {
			clearTimeout(timer);
			resolve(chunk.toString());
		});
		channel.source.once('close', () => {
			clearTimeout(timer);
			resolve(null);
		});
		channel.sink.write(Buffer.from('ping'));
	});
}

test('durable keyfile yields a stable PeerId across restarts', () => {
	const path = join(tmp(), 'device.key.json');
	const a = loadOrCreateDeviceSecret(path).public().toString();
	const b = loadOrCreateDeviceSecret(path).public().toString();
	expect(a).toBe(b);
});

test('admits an enrolled peer and dumb-pipes to the route child', async () => {
	const dialerSecret = SecretKey.generate();
	const dialerId = asPeerId(dialerSecret.public().toString());

	const server = await track(
		createPeerGateway({
			secret: SecretKey.generate(),
			// `listed` route: a listed dialer clears it.
			routes: { echo: { ...ECHO_ROUTE, requires: 'listed' } },
			trust: fixedTrust([[dialerId, 'listed']]),
		}),
	);
	server.listen();

	const dialer = await track(
		createPeerGateway({
			secret: dialerSecret,
			routes: {},
			trust: fixedTrust([]),
		}),
	);

	const channel = await dialer.dial({
		target: server.peerId,
		route: ECHO,
		hintAddrs: server.boundSockets(),
	});
	expect(await probe(channel)).toBe('ping');
});

test('refuses an unenrolled peer before any byte reaches the child', async () => {
	const server = await track(
		createPeerGateway({
			secret: SecretKey.generate(),
			routes: { echo: ECHO_ROUTE },
			// Nobody is listed: every peer reads `undefined`, below `listed`.
			trust: fixedTrust([]),
		}),
	);
	server.listen();

	const dialer = await track(
		createPeerGateway({
			secret: SecretKey.generate(),
			routes: {},
			trust: fixedTrust([]),
		}),
	);

	let refused = false;
	try {
		const channel = await dialer.dial({
			target: server.peerId,
			route: ECHO,
			hintAddrs: server.boundSockets(),
		});
		refused = (await probe(channel)) === null;
	} catch {
		refused = true;
	}
	expect(refused).toBe(true);
});

test('admits a peer for a route iff its state meets the route threshold', async () => {
	// One gateway exposes two routes: a low-risk `echo` accepting `listed`, and a
	// sensitive `books` demanding `verified`. A merely-listed dialer clears the
	// first and is refused by the second, proving the per-route threshold is what
	// admits, not a single global allowlist.
	const listedSecret = SecretKey.generate();
	const listedId = asPeerId(listedSecret.public().toString());
	const LOW = asRouteName('echo');
	const HIGH = asRouteName('books');

	const server = await track(
		createPeerGateway({
			secret: SecretKey.generate(),
			routes: {
				echo: { ...ECHO_ROUTE, requires: 'listed' },
				books: { ...ECHO_ROUTE, requires: 'verified' },
			},
			trust: fixedTrust([[listedId, 'listed']]),
		}),
	);
	server.listen();

	const dialer = await track(
		createPeerGateway({
			secret: listedSecret,
			routes: {},
			trust: fixedTrust([]),
		}),
	);

	// Meets `listed`: admitted and echoed.
	const low = await dialer.dial({
		target: server.peerId,
		route: LOW,
		hintAddrs: server.boundSockets(),
	});
	expect(await probe(low)).toBe('ping');

	// Below `verified`: refused before any byte reaches the child.
	let refused = false;
	try {
		const high = await dialer.dial({
			target: server.peerId,
			route: HIGH,
			hintAddrs: server.boundSockets(),
		});
		refused = (await probe(high)) === null;
	} catch {
		refused = true;
	}
	expect(refused).toBe(true);
});

test('dial rejects promptly when its signal is already aborted', async () => {
	const server = await track(
		createPeerGateway({
			secret: SecretKey.generate(),
			routes: { echo: { ...ECHO_ROUTE, requires: 'listed' } },
			trust: fixedTrust([]),
		}),
	);
	server.listen();

	const dialer = await track(
		createPeerGateway({
			secret: SecretKey.generate(),
			routes: {},
			trust: fixedTrust([]),
		}),
	);

	// A pre-aborted signal short-circuits before any connect, so a caller that has
	// already timed the open out gets a prompt rejection instead of a hang.
	let rejected = false;
	try {
		await dialer.dial({
			target: server.peerId,
			route: ECHO,
			hintAddrs: server.boundSockets(),
			signal: AbortSignal.abort(),
		});
	} catch {
		rejected = true;
	}
	expect(rejected).toBe(true);
});
