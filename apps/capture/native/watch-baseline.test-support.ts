import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import * as realFs from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// No native events: `watch` fails, and the watcher falls back to its timer.
mock.module('node:fs', () => ({
	...realFs,
	watch() {
		throw new Error('native events are off in this test');
	},
}));

const { createCaptureBridge } = await import('./index.js');
const { createBridgeTransport, openBridgeFolder } = await import(
	'../src/lib/bridge/client.js'
);

const cleanups: (() => Promise<unknown>)[] = [];

async function setup() {
	const parent = await realpath(
		await mkdtemp(join(tmpdir(), 'capture-watch-')),
	);
	cleanups.push(() => rm(parent, { recursive: true, force: true }));
	const root = join(parent, 'so.epicenter.capture');
	// The timer is far away: only an explicit comparison runs.
	const bridge = createCaptureBridge({ root, watchIntervalMs: 3_600_000 });
	cleanups.push(() => bridge.close());
	const opened = await openBridgeFolder(
		createBridgeTransport({
			origin: 'http://capture.test',
			fetch: (request) => bridge.fetch(request),
			retryMs: 20,
		}),
	);
	cleanups.push(() => opened.close());
	let hints = 0;
	opened.onExternalChange(() => {
		hints++;
	});
	// Let the event stream attach before anything changes.
	await Bun.sleep(50);
	return {
		root,
		bridge,
		folder: opened.folder,
		hintsNow: () => hints,
		/** Hints delivered since the last call. */
		async hintsAfterScan() {
			const found = await bridge.scan();
			await Bun.sleep(30);
			const count = hints;
			hints = 0;
			return { found, count };
		},
	};
}

async function createdThenRemoved() {
	const { root, folder, hintsAfterScan, hintsNow } = await setup();
	// Proof that nothing but an explicit comparison reports here: an outside
	// file goes unreported until one runs.
	await writeFile(join(root, 'captures/probe.md'), 'probe\n');
	await Bun.sleep(200);
	assert.equal(hintsNow(), 0);
	assert.equal((await hintsAfterScan()).found, true);
	await rm(join(root, 'captures/probe.md'));
	await hintsAfterScan();

	const created = await folder.tables.captures.create({
		stem: 'one',
		fields: { capturedAt: '2026-10-01T02:30:00.000Z' as never },
		body: '\nText\n',
	});
	assert.equal(created.error, null);

	// The directory is back to how it looked before the creation. Only the
	// owner's own comparison after its write makes this visible.
	await rm(join(root, 'captures/one.md'));
	const { found } = await hintsAfterScan();
	assert.equal(found, true);
	assert.deepEqual((await folder.tables.captures.list()).data?.entries, []);
}

async function rawAndEdited() {
	const { root, folder, hintsAfterScan } = await setup();
	await folder.files.write('captures/raw.md', 'raw\n', { expected: 'absent' });
	await rm(join(root, 'captures/raw.md'));
	assert.equal((await hintsAfterScan()).found, true);

	const created = await folder.tables.captures.create({
		stem: 'two',
		fields: { capturedAt: '2026-10-01T02:30:00.000Z' as never },
		body: '\nText\n',
	});
	if (!created.data) throw new Error('not created');
	await folder.tables.captures.writeSource(
		created.data,
		'saved here, longer\n',
	);
	await writeFile(
		join(root, 'captures/two.md'),
		'edited outside, longer still\n',
	);
	const after = await hintsAfterScan();
	assert.equal(after.found, true);
	assert.ok(after.count > 0);
}

try {
	if (process.argv[2] === 'create') await createdThenRemoved();
	else if (process.argv[2] === 'raw-and-edit') await rawAndEdited();
	else throw new Error('Unknown watcher scenario');
} finally {
	for (const run of cleanups.reverse()) await run().catch(() => {});
}
