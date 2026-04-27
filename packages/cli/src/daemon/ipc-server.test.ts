import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import {
	type IpcHandler,
	type IpcResponse,
	startIpcServer,
} from './ipc-server';

let socketPath: string;
let servers: Awaited<ReturnType<typeof startIpcServer>>[] = [];

beforeEach(() => {
	socketPath = join(
		tmpdir(),
		`epicenter-ipc-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sock`,
	);
	servers = [];
});

afterEach(async () => {
	for (const server of servers) {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

/** Connect, collect newline-delimited JSON responses, then resolve. */
function collect(
	socketPath: string,
	requests: object[],
	expectedFrames: number,
	timeoutMs = 1000,
): Promise<{ frames: IpcResponse[]; socket: Socket }> {
	return new Promise((resolve, reject) => {
		const socket = connect(socketPath);
		const frames: IpcResponse[] = [];
		const rl = createInterface({ input: socket });

		const timer = setTimeout(() => {
			rl.close();
			socket.destroy();
			reject(
				new Error(
					`timed out waiting for ${expectedFrames} frames; got ${frames.length}`,
				),
			);
		}, timeoutMs);

		rl.on('line', (line) => {
			frames.push(JSON.parse(line) as IpcResponse);
			if (frames.length >= expectedFrames) {
				clearTimeout(timer);
				rl.close();
				resolve({ frames, socket });
			}
		});

		socket.on('error', (err) => {
			clearTimeout(timer);
			reject(err);
		});

		socket.on('connect', () => {
			for (const req of requests) {
				socket.write(`${JSON.stringify(req)}\n`);
			}
		});
	});
}

describe('startIpcServer', () => {
	test('round-trip: ping → pong', async () => {
		const handler: IpcHandler = (req, send) => {
			if (req.cmd === 'ping') {
				send({ id: req.id, ok: true, data: 'pong' });
			}
		};
		const server = await startIpcServer(socketPath, handler);
		servers.push(server);

		const { frames, socket } = await collect(
			socketPath,
			[{ id: '1', cmd: 'ping' }],
			1,
		);
		socket.destroy();

		expect(frames).toEqual([{ id: '1', ok: true, data: 'pong' }]);
	});

	test('bad JSON on one line does not break subsequent lines', async () => {
		const handler: IpcHandler = (req, send) => {
			send({ id: req.id, ok: true, data: { echoed: req.cmd } });
		};
		const server = await startIpcServer(socketPath, handler);
		servers.push(server);

		// Send a garbage line, then a real one over the same connection.
		const result = await new Promise<IpcResponse[]>((resolve, reject) => {
			const socket = connect(socketPath);
			const frames: IpcResponse[] = [];
			const rl = createInterface({ input: socket });
			const timer = setTimeout(
				() => reject(new Error('timeout')),
				1000,
			);
			rl.on('line', (line) => {
				frames.push(JSON.parse(line) as IpcResponse);
				if (frames.length >= 2) {
					clearTimeout(timer);
					socket.destroy();
					resolve(frames);
				}
			});
			socket.on('connect', () => {
				socket.write('not json at all\n');
				socket.write(`${JSON.stringify({ id: '2', cmd: 'echo' })}\n`);
			});
			socket.on('error', reject);
		});

		expect(result).toHaveLength(2);
		expect(result[0]).toMatchObject({
			ok: false,
			error: { name: 'BadRequest' },
		});
		expect(result[1]).toEqual({
			id: '2',
			ok: true,
			data: { echoed: 'echo' },
		});
	});

	test('multiple concurrent connections each get their own response stream', async () => {
		const handler: IpcHandler = (req, send) => {
			send({
				id: req.id,
				ok: true,
				data: (req.args as { tag?: string } | undefined)?.tag ?? null,
			});
		};
		const server = await startIpcServer(socketPath, handler);
		servers.push(server);

		const [a, b, c] = await Promise.all([
			collect(socketPath, [{ id: '1', cmd: 'x', args: { tag: 'a' } }], 1),
			collect(socketPath, [{ id: '1', cmd: 'x', args: { tag: 'b' } }], 1),
			collect(socketPath, [{ id: '1', cmd: 'x', args: { tag: 'c' } }], 1),
		]);

		a.socket.destroy();
		b.socket.destroy();
		c.socket.destroy();

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

	test('closing the server unlinks the socket file', async () => {
		const server = await startIpcServer(socketPath, () => {});
		expect(existsSync(socketPath)).toBe(true);

		await new Promise<void>((resolve) => server.close(() => resolve()));

		expect(existsSync(socketPath)).toBe(false);
	});
});
