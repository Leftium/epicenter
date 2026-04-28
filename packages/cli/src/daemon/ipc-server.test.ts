import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Socket } from 'bun';

import {
	type IpcHandler,
	type IpcFrame,
	type IpcServerHandle,
	startIpcServer,
} from './ipc-server';

let socketPath: string;
let servers: IpcServerHandle[] = [];

beforeEach(() => {
	socketPath = join(
		tmpdir(),
		`epicenter-ipc-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sock`,
	);
	servers = [];
});

afterEach(() => {
	for (const server of servers) {
		try {
			server.stop();
		} catch {
			// already stopped
		}
	}
});

/** Per-connection state for the test client socket. */
type TestSocketData = { buffer: string; onLine: (line: string) => void };

/**
 * Connect, send pre-encoded raw lines (each terminated with `\n` by us),
 * collect newline-delimited JSON response frames, then resolve.
 */
function collectRaw(
	socketPath: string,
	rawLines: string[],
	expectedFrames: number,
	timeoutMs = 1000,
): Promise<{ frames: IpcFrame[]; socket: Socket<TestSocketData> }> {
	return new Promise((resolve, reject) => {
		const frames: IpcFrame[] = [];
		const timer = setTimeout(() => {
			reject(
				new Error(
					`timed out waiting for ${expectedFrames} frames; got ${frames.length}`,
				),
			);
		}, timeoutMs);

		Bun.connect<TestSocketData>({
			unix: socketPath,
			socket: {
				open(s) {
					s.data = {
						buffer: '',
						onLine: (line) => {
							frames.push(JSON.parse(line) as IpcFrame);
							if (frames.length >= expectedFrames) {
								clearTimeout(timer);
								resolve({ frames, socket: s });
							}
						},
					};
					for (const raw of rawLines) s.write(raw);
				},
				data(s, chunk) {
					s.data.buffer += chunk.toString('utf8');
					let nl = s.data.buffer.indexOf('\n');
					while (nl !== -1) {
						const line = s.data.buffer.slice(0, nl);
						s.data.buffer = s.data.buffer.slice(nl + 1);
						s.data.onLine(line);
						nl = s.data.buffer.indexOf('\n');
					}
				},
				close() {},
				error(_s, err) {
					clearTimeout(timer);
					reject(err);
				},
			},
		}).catch((err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

function collect(
	socketPath: string,
	requests: object[],
	expectedFrames: number,
	timeoutMs = 1000,
): Promise<{ frames: IpcFrame[]; socket: Socket<TestSocketData> }> {
	return collectRaw(
		socketPath,
		requests.map((r) => `${JSON.stringify(r)}\n`),
		expectedFrames,
		timeoutMs,
	);
}

describe('startIpcServer', () => {
	test('round-trip: ping → pong', async () => {
		const handler: IpcHandler = (req, send) => {
			if (req.cmd === 'ping') {
				send({ id: req.id, data: 'pong', error: null });
			}
		};
		const server = await startIpcServer(socketPath, handler);
		servers.push(server);

		const { frames, socket } = await collect(
			socketPath,
			[{ id: '1', cmd: 'ping' }],
			1,
		);
		socket.end();

		expect(frames).toEqual([{ id: '1', data: 'pong', error: null }]);
	});

	test('bad JSON on one line does not break subsequent lines', async () => {
		const handler: IpcHandler = (req, send) => {
			send({ id: req.id, data: { echoed: req.cmd }, error: null });
		};
		const server = await startIpcServer(socketPath, handler);
		servers.push(server);

		const { frames, socket } = await collectRaw(
			socketPath,
			['not json at all\n', `${JSON.stringify({ id: '2', cmd: 'echo' })}\n`],
			2,
		);
		socket.end();

		expect(frames).toHaveLength(2);
		expect(frames[0]).toMatchObject({
			data: null,
			error: { name: 'BadRequest' },
		});
		expect(frames[1]).toEqual({
			id: '2',
			data: { echoed: 'echo' },
			error: null,
		});
	});

	test('multiple concurrent connections each get their own response stream', async () => {
		const handler: IpcHandler = (req, send) => {
			send({
				id: req.id,
				data: (req.args as { tag?: string } | undefined)?.tag ?? null,
				error: null,
			});
		};
		const server = await startIpcServer(socketPath, handler);
		servers.push(server);

		const [a, b, c] = await Promise.all([
			collect(socketPath, [{ id: '1', cmd: 'x', args: { tag: 'a' } }], 1),
			collect(socketPath, [{ id: '1', cmd: 'x', args: { tag: 'b' } }], 1),
			collect(socketPath, [{ id: '1', cmd: 'x', args: { tag: 'c' } }], 1),
		]);

		a.socket.end();
		b.socket.end();
		c.socket.end();

		const tags = [a, b, c]
			.map((r) => (r.frames[0] as { data: string }).data)
			.sort();
		expect(tags).toEqual(['a', 'b', 'c']);
	});

	test('socket is created with mode 0600', async () => {
		const server = await startIpcServer(socketPath, () => {});
		servers.push(server);

		const mode = statSync(socketPath).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	test('stopping the server + unlinkSocketFile sweeps the socket file', async () => {
		const { unlinkSocketFile } = await import('./ipc-server');
		const server = await startIpcServer(socketPath, () => {});
		expect(existsSync(socketPath)).toBe(true);

		server.stop();
		unlinkSocketFile(socketPath);
		expect(existsSync(socketPath)).toBe(false);
	});
});
