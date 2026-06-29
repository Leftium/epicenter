/**
 * Daemon Server Tests
 *
 * Verifies that `startDaemonServer` binds exactly one socket for an
 * already-claimed daemon lease and exposes an idempotent close operation.
 *
 * Key behaviors:
 * - the configured mount is served over the daemon client
 * - close stops the listener, removes the socket file, and can run twice
 * - /run executes a real action handler over the Unix socket, and
 *   forwards peer calls when `to` is present
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openRouteTarget } from '../gateway/route-table.js';
import type { PeerTransport } from '../peer-transport.js';
import { type ActionRegistry, defineQuery } from '../shared/actions.js';
import { daemonClient } from './client.js';
import { claimDaemonLease, type DaemonLease } from './lease.js';
import { startDaemonServer } from './server.js';
import type {
	DaemonServedAccountRoom,
	DaemonServedDeviceGateway,
	DaemonServedMount,
} from './types.js';

const MINI_MCP_SERVER = fileURLToPath(
	new URL('../agent/test-fixtures/mini-mcp-server.ts', import.meta.url),
);

/**
 * A stub device gateway whose transport serves the fixture MCP server over a
 * child's stdio, bypassing iroh. It proves the `/tools` and `/call` route
 * plumbing (socket -> catalog -> MCP) without binding a real endpoint; the real
 * gateway path is proven in `mcp-gateway-catalog.test.ts` and `packages/cli`.
 */
function stubDeviceGateway(): DaemonServedDeviceGateway {
	const transport: PeerTransport = {
		// Reuse the production spawn-and-adapt path so the stub channel is the same
		// Web Streams {@link ByteChannel} shape a real route yields; the catalog's
		// channel close ends the child's stdin and tears it down.
		openChannel: async () =>
			openRouteTarget({ command: 'bun', args: ['run', MINI_MCP_SERVER] }).channel,
	};
	return { transport };
}

let originalRuntimeDir: string | undefined;
let runtimeRoot: string;
let workDir: string;

function makeRuntime({
	actions = {},
	collaboration = true,
	dispatch = async () => ({ data: null, error: null }) as never,
}: {
	actions?: ActionRegistry;
	collaboration?: boolean;
	dispatch?: NonNullable<
		DaemonServedMount['runtime']['collaboration']
	>['dispatch'];
} = {}): DaemonServedMount['runtime'] {
	const runtime: DaemonServedMount['runtime'] = { actions };
	if (collaboration) {
		runtime.collaboration = {
			peers: {
				list: () => [],
			},
			status: { phase: 'connected' },
			dispatch,
		};
	}
	return runtime;
}

function claimTestLease(): DaemonLease {
	return expectOk(claimDaemonLease(workDir));
}

/**
 * A stub account room that reports a fixed relay-presence list from `peers()`
 * (the source the daemon serves at `/relay-peers`). Structurally satisfies
 * {@link DaemonServedAccountRoom}.
 */
function makeAccountRoom(nodeIds: string[]): DaemonServedAccountRoom {
	return {
		peers: () =>
			nodeIds.map((nodeId) => ({ nodeId, connectedAt: 0, actions: {} })),
	};
}

beforeEach(() => {
	originalRuntimeDir = process.env.EPICENTER_RUNTIME_DIR;
	// `/tmp/...` is short on every POSIX platform; needed because
	// socketPathFor enforces a strict path-length guard that macOS's
	// `os.tmpdir()` would blow.
	runtimeRoot = mkdtempSync('/tmp/eps-server-rt-');
	process.env.EPICENTER_RUNTIME_DIR = runtimeRoot;
	mkdirSync(runtimeRoot, { recursive: true });
	workDir = mkdtempSync('/tmp/eps-server-dir-');
});

afterEach(() => {
	if (originalRuntimeDir === undefined)
		delete process.env.EPICENTER_RUNTIME_DIR;
	else process.env.EPICENTER_RUNTIME_DIR = originalRuntimeDir;
	rmSync(runtimeRoot, { recursive: true, force: true });
	rmSync(workDir, { recursive: true, force: true });
});

describe('startDaemonServer', () => {
	test('starts the configured mount', async () => {
		const lease = claimTestLease();
		const serverResult = await startDaemonServer({
			lease,
			mount: { mount: 'demo', runtime: makeRuntime() },
		});

		try {
			const server = expectOk(serverResult);

			const data = expectOk(await daemonClient(server.socketPath).peers());
			expect(data).toEqual([]);
		} finally {
			if (serverResult.error === null) await serverResult.data.close();
			lease.release();
		}
	});

	test('relay-peers serves the account-room presence, empty without one', async () => {
		// Without an account room, /relay-peers is a valid empty list.
		const leaseA = claimTestLease();
		const withoutRoom = await startDaemonServer({
			lease: leaseA,
			mount: { mount: 'demo', runtime: makeRuntime() },
		});
		try {
			const server = expectOk(withoutRoom);
			expect(
				expectOk(await daemonClient(server.socketPath).relayPeers()),
			).toEqual([]);
		} finally {
			if (withoutRoom.error === null) await withoutRoom.data.close();
			leaseA.release();
		}

		// With presence, /relay-peers maps each online device to a { nodeId } row.
		const leaseB = claimTestLease();
		const withRoom = await startDaemonServer({
			lease: leaseB,
			mount: { mount: 'demo', runtime: makeRuntime() },
			accountRoom: makeAccountRoom(['node-laptop', 'node-phone']),
		});
		try {
			const server = expectOk(withRoom);
			const rows = expectOk(await daemonClient(server.socketPath).relayPeers());
			expect(rows).toEqual([{ nodeId: 'node-laptop' }, { nodeId: 'node-phone' }]);
		} finally {
			if (withRoom.error === null) await withRoom.data.close();
			leaseB.release();
		}
	});

	test('tools/call dial the device gateway; absent gateway errors', async () => {
		// With a gateway, /tools lists the route's MCP catalog and /call runs a tool.
		const leaseA = claimTestLease();
		const withGateway = await startDaemonServer({
			lease: leaseA,
			mount: { mount: 'demo', runtime: makeRuntime() },
			deviceGateway: stubDeviceGateway(),
		});
		try {
			const client = daemonClient(expectOk(withGateway).socketPath);
			const tools = expectOk(
				await client.tools({ device: 'bb'.repeat(32), route: 'books' }),
			);
			expect(tools.map((t) => t.name)).toEqual(['customers']);
			expect(tools[0]?.kind).toBe('query');

			const outcome = expectOk(
				await client.call({
					device: 'bb'.repeat(32),
					route: 'books',
					tool: 'customers',
					input: {},
				}),
			);
			expect(outcome.isError).toBe(false);
			expect(String(outcome.output)).toContain('Acme');
		} finally {
			if (withGateway.error === null) await withGateway.data.close();
			leaseA.release();
		}

		// Without one, a cross-device route is a typed Unavailable error.
		const leaseB = claimTestLease();
		const withoutGateway = await startDaemonServer({
			lease: leaseB,
			mount: { mount: 'demo', runtime: makeRuntime() },
		});
		try {
			const client = daemonClient(expectOk(withoutGateway).socketPath);
			const error = expectErr(
				await client.tools({ device: 'bb'.repeat(32), route: 'books' }),
			);
			expect(error.name).toBe('Unavailable');
		} finally {
			if (withoutGateway.error === null) await withoutGateway.data.close();
			leaseB.release();
		}
	});

	test('close stops the listener, removes the socket, and is idempotent', async () => {
		const lease = claimTestLease();
		const serverResult = await startDaemonServer({
			lease,
			mount: { mount: 'demo', runtime: makeRuntime() },
		});

		try {
			const server = expectOk(serverResult);
			expect(existsSync(server.socketPath)).toBe(true);

			await server.close();
			await server.close();
			expect(existsSync(server.socketPath)).toBe(false);
		} finally {
			if (serverResult.error === null) await serverResult.data.close();
			lease.release();
		}
	});

	test('run executes a real action handler over the socket', async () => {
		const lease = claimTestLease();
		const runtime = makeRuntime({
			actions: {
				echo: defineQuery({ handler: () => 'hello' }),
			},
		});
		const serverResult = await startDaemonServer({
			lease,
			mount: { mount: 'demo', runtime },
		});

		try {
			const server = expectOk(serverResult);
			const data = expectOk(
				await daemonClient(server.socketPath).run({
					actionPath: 'echo',
					input: null,
				}),
			);
			expect(data).toBe('hello');
		} finally {
			if (serverResult.error === null) await serverResult.data.close();
			lease.release();
		}
	});

	test('run executes a local-only mount action over the socket', async () => {
		const lease = claimTestLease();
		const runtime = makeRuntime({
			collaboration: false,
			actions: {
				sync: defineQuery({ handler: () => ({ imported: 1 }) }),
			},
		});
		const serverResult = await startDaemonServer({
			lease,
			mount: { mount: 'mirror', runtime },
		});

		try {
			const server = expectOk(serverResult);
			const data = expectOk(
				await daemonClient(server.socketPath).run({
					actionPath: 'sync',
					input: null,
				}),
			);
			expect(data).toEqual({ imported: 1 });
		} finally {
			if (serverResult.error === null) await serverResult.data.close();
			lease.release();
		}
	});

	test('run with to forwards mount-local action keys over the socket', async () => {
		const lease = claimTestLease();
		let invokedAction = '';
		let invokedTo = '';
		const runtime = makeRuntime({
			dispatch: async (request) => {
				invokedAction = request.action;
				invokedTo = request.to;
				return { data: 'remote-ok', error: null };
			},
		});
		const serverResult = await startDaemonServer({
			lease,
			mount: { mount: 'demo', runtime },
		});

		try {
			const server = expectOk(serverResult);
			const data = expectOk(
				await daemonClient(server.socketPath).run({
					actionPath: 'peer_only_action',
					input: null,
					peer: { to: 'mac', waitMs: 25 },
				}),
			);
			expect(data).toBe('remote-ok');
			expect(invokedAction).toBe('peer_only_action');
			expect(invokedTo).toBe('mac');
		} finally {
			if (serverResult.error === null) await serverResult.data.close();
			lease.release();
		}
	});

	test('run with to rejects invalid wait budgets as a domain error', async () => {
		const lease = claimTestLease();
		const serverResult = await startDaemonServer({
			lease,
			mount: { mount: 'demo', runtime: makeRuntime() },
		});

		try {
			const server = expectOk(serverResult);
			const error = expectErr(
				await daemonClient(server.socketPath).run({
					actionPath: 'peer_only_action',
					input: null,
					peer: { to: 'mac', waitMs: -1 },
				}),
			);
			expect(error.name).toBe('UsageError');
		} finally {
			if (serverResult.error === null) await serverResult.data.close();
			lease.release();
		}
	});

	test('run with to rejects a local-only mount as a usage error', async () => {
		const lease = claimTestLease();
		const serverResult = await startDaemonServer({
			lease,
			mount: {
				mount: 'mirror',
				runtime: makeRuntime({ collaboration: false }),
			},
		});

		try {
			const server = expectOk(serverResult);
			const error = expectErr(
				await daemonClient(server.socketPath).run({
					actionPath: 'sync',
					input: null,
					peer: { to: 'mac', waitMs: 25 },
				}),
			);
			expect(error.name).toBe('UsageError');
		} finally {
			if (serverResult.error === null) await serverResult.data.close();
			lease.release();
		}
	});
});
