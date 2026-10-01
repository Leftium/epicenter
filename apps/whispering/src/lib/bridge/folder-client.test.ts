/**
 * Borrowed Folder Client Tests
 *
 * The host owns storage and shared Git attempts. A page can stop waiting for
 * one attempt, and closing its client fences calls and drains already sent
 * work. A lost reply is an unknown mutation outcome, never proof of no write.
 */
import { expect, test } from 'bun:test';
import type { DataDefinition } from '@epicenter/definition';
import {
	captureVersion,
	type FileCapture,
	type FolderBatch,
	type GitSnapshot,
} from '@epicenter/folder/bun';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { type RecordingFields, whisperingDefinition } from '../definition.js';
import { collectBatchPlan, InvalidBatchPlan } from './batch-plan.js';
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
			expectErr(await client.folder.files.create('note.md', 'saved')).name,
		).toBe('Unconfirmed');
		// A batch is one call: without its reply, none of it is known to have landed or not.
		expect(
			expectErr(
				await client.folder.batch((batch) => {
					batch.files.create('note.md', 'saved');
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
	const capture: FileCapture = {
		path: 'note.md',
		version: await captureVersion(new TextEncoder().encode('saved')),
	};
	const saving = client.folder.files.create('note.md', 'saved');
	await sent.promise;
	const closed = client.close();
	event?.({ type: 'git', snapshot: {} as GitSnapshot });
	expect(snapshots).toBe(1);
	reply.resolve(Ok(capture));
	expect(expectOk(await saving)).toEqual(capture);
	await closed;
});

test('a batch callback runs once in the page, and what it named is sent as one call', async () => {
	const calls: { path: readonly string[]; args: readonly unknown[] }[] = [];
	const receipt = { steps: [] };
	const client = await connectFolder(
		whisperingDefinition,
		transport(async (path, args) => {
			calls.push({ path, args });
			return Ok(receipt);
		}),
	);
	const audio = new Uint8Array([1, 2, 3]);
	const observed: FileCapture = {
		path: 'recordings/b.wav',
		version: { sha256: 'abc', size: 3 },
	};
	let runs = 0;
	let kept: FolderBatch<typeof whisperingDefinition> | undefined;
	try {
		const published = client.folder.batch((batch) => {
			runs += 1;
			kept = batch;
			batch.files.create('recordings/a.wav', audio);
			batch.files.replace(observed, audio);
			batch.tables.recordings.create({
				stem: 'a',
				fields: { title: 'A' } as never,
				body: '',
			});
		});
		// The callback already ran, synchronously, and its bytes were copied then.
		expect(runs).toBe(1);
		audio.fill(9);
		expect(expectOk(await published)).toEqual(receipt);

		expect(calls).toHaveLength(1);
		expect(calls[0]!.path).toEqual(['batch']);
		expect(calls[0]!.args).toEqual([
			[
				{
					op: 'files.create',
					path: 'recordings/a.wav',
					content: new Uint8Array([1, 2, 3]),
				},
				{
					op: 'files.replace',
					file: observed,
					content: new Uint8Array([1, 2, 3]),
				},
				{
					op: 'tables.create',
					table: 'recordings',
					input: { stem: 'a', fields: { title: 'A' }, body: '' },
				},
			],
		]);
		// The collector is sealed when the callback returns.
		expect(() => kept!.files.create('late.md', 'x')).toThrow('sealed');
		expect(calls).toHaveLength(1);
	} finally {
		await client.close();
	}
});

test('a batch callback that throws or returns anything sends nothing', async () => {
	let calls = 0;
	const client = await connectFolder(
		whisperingDefinition,
		transport(async () => {
			calls += 1;
			return Ok({ steps: [] });
		}),
	);
	try {
		const threw = expectErr(
			await client.folder.batch((batch) => {
				batch.files.create('a.md', 'a');
				throw new Error('changed my mind');
			}),
		);
		expect(threw.name).toBe('Threw');
		const returned = expectErr(
			await client.folder.batch((async () => {}) as unknown as () => undefined),
		);
		expect(returned).toMatchObject({ name: 'Returned', thenable: true });
		expect(calls).toBe(0);
	} finally {
		await client.close();
	}
	// A closed client does not call the callback at all.
	let ran = false;
	const closed = expectErr(
		await client.folder.batch(() => {
			ran = true;
		}),
	);
	expect(closed.name).toBe('Closed');
	expect(ran).toBe(false);
	expect(calls).toBe(0);
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

test('standalone file intents detach bytes and capture before transport starts', async () => {
	let received: readonly unknown[] = [];
	const client = await connectFolder(
		whisperingDefinition,
		transport(async (_path, args) => {
			received = args;
			return Ok(undefined);
		}),
	);
	try {
		const bytes = new Uint8Array([1, 2]);
		const file = {
			path: 'original.wav',
			version: { sha256: 'a'.repeat(64), size: 2 },
		};
		const writing = client.folder.files.replace(file, bytes);
		file.path = 'other.wav';
		file.version.sha256 = 'b'.repeat(64);
		bytes[0] = 9;
		await writing;
		expect(received[0]).toEqual({
			path: 'original.wav',
			version: { sha256: 'a'.repeat(64), size: 2 },
		});
		expect(received[1]).toEqual(new Uint8Array([1, 2]));
	} finally {
		await client.close();
	}
});

test('batch intents detach captures and typed fields when collected', async () => {
	let received: readonly unknown[] = [];
	const client = await connectFolder(
		whisperingDefinition,
		transport(async (_path, args) => {
			received = args;
			return Ok({ steps: [] });
		}),
	);
	try {
		const file = {
			path: 'original.wav',
			version: { sha256: 'a'.repeat(64), size: 2 },
		};
		const fields = {
			title: 'Original',
			recordedAt: '2026-10-01T00:00:00Z' as RecordingFields['recordedAt'],
			durationMs: 10,
			capture: 'fixture' as const,
			audioPath: 'original.wav',
		};
		await client.folder.batch((batch) => {
			batch.files.remove(file);
			// A plain string is not the branded instant type; the object is passed as it is.
			batch.tables.recordings.create({
				stem: 'recording',
				fields: fields as never,
			});
			file.path = 'other.wav';
			file.version.sha256 = 'b'.repeat(64);
			fields.title = 'Changed';
		});
		const plan = received[0] as [
			{ file: FileCapture },
			{ input: { fields: typeof fields } },
		];
		expect(plan[0].file).toEqual({
			path: 'original.wav',
			version: { sha256: 'a'.repeat(64), size: 2 },
		});
		expect(plan[1].input.fields.title).toBe('Original');
	} finally {
		await client.close();
	}
});

/** A client whose transport holds every call until released, recording what it was given. */
async function deferredClient(reply: unknown = Ok(undefined)) {
	const calls: { path: readonly string[]; args: readonly unknown[] }[] = [];
	const gate = Promise.withResolvers<void>();
	const client = await connectFolder(
		whisperingDefinition,
		transport(async (path, args) => {
			await gate.promise;
			calls.push({ path, args });
			return reply;
		}),
	);
	return { client, calls, release: () => gate.resolve() };
}

type MutableCapture = {
	path: string;
	version: { sha256: string; size: number };
};
const capture = (): MutableCapture => ({
	path: 'original.wav',
	version: { sha256: 'a'.repeat(64), size: 2 },
});
const ORIGINAL = capture();

/** What a caller might do with its own object right after a call. */
function mutate(file: MutableCapture) {
	file.path = 'other.wav';
	file.version.sha256 = 'b'.repeat(64);
	file.version.size = 99;
}

test('every standalone file verb sends the bytes, path, and capture it was called with, even when the caller reuses them', async () => {
	const { client, calls, release } = await deferredClient();
	const { files } = client.folder;
	try {
		// One array reused for every save, as a recorder reuses its buffer.
		const buffer = new Uint8Array([1, 2]);
		const created = files.create('a.wav', buffer);
		buffer.set([3, 4]);
		const overwritten = files.overwrite('b.wav', buffer);
		buffer.set([5, 6]);
		const replaceTarget = capture();
		const replaced = files.replace(replaceTarget, buffer);
		mutate(replaceTarget);
		buffer.set([7, 8]);
		const removeTarget = capture();
		const removed = files.remove(removeTarget);
		mutate(removeTarget);
		const moveTarget = capture();
		const moved = files.move(moveTarget, 'moved.wav');
		mutate(moveTarget);
		buffer.fill(0);

		// Nothing has been sent yet: every mutation above came first.
		expect(calls).toEqual([]);
		release();
		await Promise.all([created, overwritten, replaced, removed, moved]);

		expect(calls).toEqual([
			{ path: ['files', 'create'], args: ['a.wav', new Uint8Array([1, 2])] },
			{ path: ['files', 'overwrite'], args: ['b.wav', new Uint8Array([3, 4])] },
			{ path: ['files', 'replace'], args: [ORIGINAL, new Uint8Array([5, 6])] },
			{ path: ['files', 'remove'], args: [ORIGINAL] },
			{ path: ['files', 'move'], args: [ORIGINAL, 'moved.wav'] },
		]);
	} finally {
		release();
		await client.close();
	}
});

test('a table write sends the entry and values it was called with', async () => {
	const { client, calls, release } = await deferredClient();
	const table = client.folder.tables.recordings;
	try {
		const entry = {
			...capture(),
			path: 'recordings/a.md',
			source: '---\ntitle: A\n---\n',
		};
		const fields = { title: 'Original' };
		const created = {
			stem: 'a',
			fields: { title: 'Original' },
			body: 'Body\n',
		};
		const updating = table.update(entry as never, { fields });
		const creating = table.create(created as never);
		const deleting = table.delete(entry as never);
		fields.title = 'Changed';
		created.fields.title = 'Changed';
		created.stem = 'b';
		mutate(entry);

		release();
		await Promise.all([updating, creating, deleting]);

		const sent = {
			...ORIGINAL,
			path: 'recordings/a.md',
			source: '---\ntitle: A\n---\n',
		};
		expect(calls.map((call) => call.args)).toEqual([
			[sent, { fields: { title: 'Original' } }],
			[{ stem: 'a', fields: { title: 'Original' }, body: 'Body\n' }],
			[sent],
		]);
	} finally {
		release();
		await client.close();
	}
});

test('every batch file verb and typed row is fixed when it is named, inside the callback', async () => {
	const { client, calls, release } = await deferredClient(Ok({ steps: [] }));
	try {
		const buffer = new Uint8Array([1, 2]);
		const fields = {
			title: 'Original',
			recordedAt: '2026-10-01T00:00:00.000Z',
			durationMs: 10,
			capture: 'fixture' as const,
			audioPath: 'original.wav',
		};
		const row = { stem: 'recording', fields, body: 'Notes\n' };
		const publishing = client.folder.batch((batch) => {
			batch.files.create('a.wav', buffer);
			buffer.set([3, 4]);
			batch.files.overwrite('b.wav', buffer);
			buffer.set([5, 6]);
			const replaceTarget = capture();
			batch.files.replace(replaceTarget, buffer);
			mutate(replaceTarget);
			buffer.set([7, 8]);
			const removeTarget = capture();
			batch.files.remove(removeTarget);
			mutate(removeTarget);
			const moveTarget = capture();
			batch.files.move(moveTarget, 'moved.wav');
			mutate(moveTarget);
			batch.tables.recordings.create(row as never);
			// The caller keeps going with the same objects.
			fields.title = 'Changed';
			fields.audioPath = 'other.wav';
			row.stem = 'another';
			row.body = 'Changed\n';
			buffer.fill(0);
		});
		// And again after the callback, before the batch is sent.
		fields.durationMs = 999;
		release();
		await publishing;

		expect(calls).toHaveLength(1);
		expect(calls[0]!.path).toEqual(['batch']);
		expect(calls[0]!.args).toEqual([
			[
				{ op: 'files.create', path: 'a.wav', content: new Uint8Array([1, 2]) },
				{
					op: 'files.overwrite',
					path: 'b.wav',
					content: new Uint8Array([3, 4]),
				},
				{
					op: 'files.replace',
					file: ORIGINAL,
					content: new Uint8Array([5, 6]),
				},
				{ op: 'files.remove', file: ORIGINAL },
				{ op: 'files.move', file: ORIGINAL, destination: 'moved.wav' },
				{
					op: 'tables.create',
					table: 'recordings',
					input: {
						stem: 'recording',
						fields: {
							title: 'Original',
							recordedAt: '2026-10-01T00:00:00.000Z',
							durationMs: 10,
							capture: 'fixture',
							audioPath: 'original.wav',
						},
						body: 'Notes\n',
					},
				},
			],
		]);
	} finally {
		release();
		await client.close();
	}
});

test('a capture or row of the wrong shape is passed on for the folder to refuse, not repaired or thrown here', async () => {
	const { client, calls, release } = await deferredClient(Ok({ steps: [] }));
	release();
	try {
		await client.folder.files.replace(null as never, 'x');
		await client.folder.files.remove({ path: 7 } as never);
		await client.folder.batch((batch) => {
			batch.files.remove(undefined as never);
			batch.tables.recordings.create(null as never);
		});

		expect(calls.map((call) => call.args)).toEqual([
			[null, 'x'],
			[{ path: 7 }],
			[
				[
					{ op: 'files.remove', file: undefined },
					{ op: 'tables.create', table: 'recordings', input: {} },
				],
			],
		]);
	} finally {
		await client.close();
	}
});

test('a plan step naming a table the batch does not have is refused, never dropped', () => {
	const named: string[] = [];
	const batch = {
		files: {},
		tables: { recordings: { create: () => named.push('recordings') } },
	} as unknown as FolderBatch<DataDefinition>;
	const row = (table: string) =>
		[{ op: 'tables.create', table, input: { stem: 'a', fields: {} } }] as const;

	// An inherited name is not a table either.
	expect(() => collectBatchPlan(batch, row('toString'))).toThrow(
		InvalidBatchPlan,
	);
	expect(() => collectBatchPlan(batch, row('missing'))).toThrow(
		"'missing' is not a table of this folder",
	);
	expect(named).toEqual([]);

	collectBatchPlan(batch, row('recordings'));
	expect(named).toEqual(['recordings']);
});
