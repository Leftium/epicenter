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
import { expectErr, expectOk } from 'wellcrafted/testing';
import { type ActionRegistry, defineQuery } from '../shared/actions.js';
import { daemonClient } from './client.js';
import { claimDaemonLease, type DaemonLease } from './lease.js';
import { startDaemonServer } from './server.js';
import type { DaemonServedAccountRoom, DaemonServedMount } from './types.js';

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
 * A stub account room backed by a plain roster map. `verify`/`revoke` record the
 * subjects they were asked to sign (the daemon's write path is exercised without
 * a real Y.Doc); `sas` returns a fixed code. Structurally satisfies
 * {@link DaemonServedAccountRoom}.
 */
function makeAccountRoom(
	roster: Map<string, { label: string }>,
): DaemonServedAccountRoom & { verified: string[]; revoked: string[] } {
	const verified: string[] = [];
	const revoked: string[] = [];
	return {
		verified,
		revoked,
		roster: () => roster as never,
		verify: (subject) => {
			verified.push(subject);
			return { asserter: 'self' as never, subject, seq: 1 };
		},
		revoke: (subject) => {
			revoked.push(subject);
			return { asserter: 'self' as never, subject, seq: 2 };
		},
		sas: () => '004217',
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

	test('devices serves the account-room roster, empty without one', async () => {
		// Without an account room, /devices is a valid empty list.
		const leaseA = claimTestLease();
		const withoutRoom = await startDaemonServer({
			lease: leaseA,
			mount: { mount: 'demo', runtime: makeRuntime() },
		});
		try {
			const server = expectOk(withoutRoom);
			expect(
				expectOk(await daemonClient(server.socketPath).devices()),
			).toEqual([]);
		} finally {
			if (withoutRoom.error === null) await withoutRoom.data.close();
			leaseA.release();
		}

		// With a roster, /devices maps each entry to a { peerId, label } row.
		const leaseB = claimTestLease();
		const roster = new Map([
			['aa'.repeat(32), { label: 'Laptop' }],
			['bb'.repeat(32), { label: 'Phone' }],
		]);
		const withRoom = await startDaemonServer({
			lease: leaseB,
			mount: { mount: 'demo', runtime: makeRuntime() },
			accountRoom: makeAccountRoom(roster),
		});
		try {
			const server = expectOk(withRoom);
			const rows = expectOk(await daemonClient(server.socketPath).devices());
			expect(rows).toEqual([
				{ peerId: 'aa'.repeat(32), label: 'Laptop' },
				{ peerId: 'bb'.repeat(32), label: 'Phone' },
			]);
		} finally {
			if (withRoom.error === null) await withRoom.data.close();
			leaseB.release();
		}
	});

	test('verify/revoke/sas write through the account room; absent room errors', async () => {
		const subject = 'cc'.repeat(32);

		// With an account room, the verdict routes sign through it and SAS returns.
		const leaseA = claimTestLease();
		const room = makeAccountRoom(new Map());
		const withRoom = await startDaemonServer({
			lease: leaseA,
			mount: { mount: 'demo', runtime: makeRuntime() },
			accountRoom: room,
		});
		try {
			const client = daemonClient(expectOk(withRoom).socketPath);
			const verified = expectOk(await client.verify({ peerId: subject }));
			expect(verified).toEqual({ peerId: subject, seq: 1 });
			expect(room.verified).toEqual([subject]);

			const revoked = expectOk(await client.revoke({ peerId: subject }));
			expect(revoked).toEqual({ peerId: subject, seq: 2 });
			expect(room.revoked).toEqual([subject]);

			const sas = expectOk(await client.sas({ peerId: subject }));
			expect(sas).toEqual({ peerId: subject, sas: '004217' });
		} finally {
			if (withRoom.error === null) await withRoom.data.close();
			leaseA.release();
		}

		// Without one, a verdict route is a typed Unavailable error, not a no-op.
		const leaseB = claimTestLease();
		const withoutRoom = await startDaemonServer({
			lease: leaseB,
			mount: { mount: 'demo', runtime: makeRuntime() },
		});
		try {
			const client = daemonClient(expectOk(withoutRoom).socketPath);
			const error = expectErr(await client.verify({ peerId: subject }));
			expect(error.name).toBe('Unavailable');
		} finally {
			if (withoutRoom.error === null) await withoutRoom.data.close();
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
