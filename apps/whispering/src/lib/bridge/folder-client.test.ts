/**
 * Borrowed Folder Client Tests
 *
 * The host owns storage and shared Git attempts. A page can stop waiting for
 * one attempt, and closing its client fences calls and drains already sent
 * work. A lost reply is an unknown mutation outcome, never proof of no write.
 */
import { expect, test } from 'bun:test';
import { captureVersion, type GitSnapshot } from '@epicenter/app/files';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { whisperingDefinition } from '../definition.js';
import { connectFolder, type FolderTransport } from './folder-client.js';
import { createHttpBridge } from './http.js';

function transport(call: FolderTransport['call']): FolderTransport {
	return {
		call: (path, args) =>
			path.join('.') === 'git.snapshot'
				? Promise.resolve({})
				: call(path, args),
		events: (_listener, signal) =>
			new Promise<void>((resolve) => {
				if (signal.aborted) return resolve();
				signal.addEventListener('abort', () => resolve(), { once: true });
			}),
	};
}

for (const method of ['push', 'fetch', 'commitAndPush'] as const) {
	test(`${method} caller cancellation stops waiting while client close drains the host call`, async () => {
		const sent = Promise.withResolvers<void>();
		const reply = Promise.withResolvers<unknown>();
		const client = await connectFolder(
			whisperingDefinition,
			transport(async () => {
				sent.resolve();
				return reply.promise;
			}),
		);
		const controller = new AbortController();
		const waiting = client.folder.git[method]({ signal: controller.signal });
		await sent.promise;
		controller.abort();
		const result = await waiting;
		if ('commit' in result) expect(result.commit.status).toBe('stoppedWaiting');
		else if ('error' in result && typeof result.error !== 'string')
			expect(result.error?.name).toBe('StoppedWaiting');
		else expect(result.status).toBe('stoppedWaiting');
		let closed = false;
		const closing = client.close().then(() => {
			closed = true;
		});
		await Promise.resolve();
		expect(closed).toBe(false);
		expect(expectErr(await client.folder.files.read('note.md')).name).toBe(
			'Closed',
		);
		reply.resolve({ status: 'pushed', oid: 'host-result' });
		await closing;
		expect(closed).toBe(true);
		expect('close' in client.folder).toBe(false);
		expect('signal' in client.folder).toBe(false);
	});
}

test('lost mutation and Git replies retain uncertainty without invented commit identities', async () => {
	const client = await connectFolder(
		whisperingDefinition,
		transport(async () => {
			throw new Error('reply lost');
		}),
	);
	try {
		expect(
			expectErr(
				await client.folder.files.write('note.md', 'saved', {
					expected: 'absent',
				}),
			).name,
		).toBe('Unconfirmed');
		expect(expectErr(await client.folder.files.read('note.md')).name).toBe(
			'Io',
		);
		expect((await client.folder.git.commit()).status).toBe('unconfirmed');
		const pushed = await client.folder.git.push();
		expect(pushed.status).toBe('unconfirmed');
		expect('oid' in pushed).toBe(false);
		const both = await client.folder.git.commitAndPush();
		expect(both.commit.status).toBe('unconfirmed');
		expect(both.push.status).toBe('unconfirmed');
		expect(expectErr(await client.folder.git.stage('all')).name).toBe(
			'Unconfirmed',
		);
	} finally {
		await client.close();
	}
});

test('closing drains an admitted save and suppresses events after its fence', async () => {
	const sent = Promise.withResolvers<void>();
	const reply = Promise.withResolvers<unknown>();
	let event:
		| ((value: { type: 'git'; snapshot: GitSnapshot }) => void)
		| undefined;
	const port = transport(async () => {
		sent.resolve();
		return reply.promise;
	});
	const client = await connectFolder(whisperingDefinition, {
		...port,
		events: (listener, signal) => {
			event = listener;
			return port.events(listener, signal);
		},
	});
	let snapshots = 0;
	client.folder.git.subscribe(() => {
		snapshots++;
	});
	const version = await captureVersion(new TextEncoder().encode('saved'));
	const saving = client.folder.files.write('note.md', 'saved', {
		expected: 'absent',
	});
	await sent.promise;
	const closed = client.close();
	event?.({ type: 'git', snapshot: {} as GitSnapshot });
	expect(snapshots).toBe(1);
	reply.resolve(Ok(version));
	expect(expectOk(await saving)).toEqual(version);
	await closed;
});

test('HTTP event cancellation settles a silent reader even when fetch already returned', async () => {
	let cancelled = false;
	const bridge = createHttpBridge({
		origin: 'http://localhost',
		token: 'test',
		fetch: async () =>
			new Response(
				new ReadableStream({
					cancel() {
						cancelled = true;
					},
				}),
			),
	});
	const controller = new AbortController();
	const events = bridge.transport.events(() => {}, controller.signal);
	await Promise.resolve();
	await Promise.resolve();
	controller.abort();
	await events;
	expect(cancelled).toBe(true);
});
