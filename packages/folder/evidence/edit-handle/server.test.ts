/**
 * Demo server and HTTP facade (EXPERIMENT)
 *
 * Runs the real demo server over its own disposable folder and drives the
 * browser facade into its fetch handler directly, with no port. This covers
 * the wire between them, which the native folder tests do not reach.
 *
 * Key behaviors:
 * - a removed row travels as an explicit `null` and reads as missing, not unreadable
 * - a guard that is present but `undefined` crosses the wire and is refused
 * - options the table would refuse are refused before anything is sent
 */
import { expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import { createFolderEdits } from './folder-edits.js';
import type { HarnessRequest } from './protocol.js';
import { createDemoServer } from './server.js';
import { FORM_STEM } from './todos.js';
import { createHttpFolder } from './web/folder-http.js';

const ORIGIN = 'http://demo.test';

async function setup() {
	const server = await createDemoServer();
	const post = (path: string, body: unknown) =>
		server.fetch(
			new Request(new URL(path, ORIGIN), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			}),
		);
	const sent: string[] = [];
	const folder = createHttpFolder({
		send: (path, init) => {
			sent.push(path);
			return server.fetch(new Request(new URL(path, ORIGIN), init));
		},
		onFilesChanged: () => () => {},
	});
	return {
		folder,
		/** Every path the page's client sent, in order. */
		sent,
		post,
		harness: (request: HarnessRequest) => post('/api/harness', request),
		async [Symbol.asyncDispose]() {
			await server.close();
		},
	};
}

test('a removed row travels as an explicit null and reads as missing, not unreadable', async () => {
	await using demo = await setup();
	const displayed = expectOk(await demo.folder.tables.todos.get(FORM_STEM));
	if (displayed === undefined) throw new Error('the seeded row is missing');
	const edit = createFolderEdits(demo.folder).tables.todos.edit(displayed);
	await edit.refresh();

	await demo.harness({ action: 'remove', path: `todos/${FORM_STEM}.md` });

	const wire = await demo.post('/api/tables/todos/get', { stem: FORM_STEM });
	expect(await wire.json()).toEqual({ data: null, error: null });
	expect(
		expectOk(await demo.folder.tables.todos.get(FORM_STEM)),
	).toBeUndefined();
	await edit.refresh();
	expect(edit.get().incoming).toEqual({ kind: 'missing' });
	await edit.dispose();
});

test('a guard that is present but undefined crosses the wire and is refused, while an absent one saves the current row', async () => {
	await using demo = await setup();
	const todos = demo.folder.tables.todos;
	const row = expectOk(await todos.get(FORM_STEM));
	if (row === undefined) throw new Error('the seeded row is missing');

	// JSON alone would drop the `undefined` and save unguarded.
	const refused = await todos.replace(FORM_STEM, 'lost guard\n', {
		expectedSha256: undefined,
	});
	expect(refused.error).toMatchObject({ name: 'InvalidPath' });
	expect(expectOk(await todos.get(FORM_STEM))?.text).toBe(row.text);

	// A stale guard still travels and is a Conflict.
	await demo.harness({
		action: 'write',
		path: `todos/${FORM_STEM}.md`,
		change: 'body',
	});
	const stale = await todos.replace(FORM_STEM, 'mine\n', {
		expectedSha256: row.sha256,
	});
	expect(stale.error).toMatchObject({ name: 'Conflict' });

	expectOk(await todos.replace(FORM_STEM, 'current\n', {}));
	expect(expectOk(await todos.get(FORM_STEM))?.text).toBe('current\n');
});

test('options the table would refuse are refused by the page before anything is sent, and the row keeps its bytes', async () => {
	await using demo = await setup();
	const todos = demo.folder.tables.todos;
	const row = expectOk(await todos.get(FORM_STEM));
	if (row === undefined) throw new Error('the seeded row is missing');
	const cases: [options: unknown, reason: string][] = [
		// A misspelled guard would otherwise be dropped from the request.
		[{ expectedSHA256: row.sha256 }, "not 'expectedSHA256'"],
		// So would an extra key beside a valid guard.
		[{ expectedSha256: row.sha256, force: true }, "not 'force'"],
		[undefined, 'Write options are required'],
		[null, 'Write options are required'],
		[[], 'Write options are required'],
	];
	demo.sent.length = 0;
	for (const [options, reason] of cases)
		expect(
			(await todos.replace(FORM_STEM, 'unsent\n', options as never)).error,
		).toMatchObject({
			name: 'InvalidPath',
			path: `todos/${FORM_STEM}.md`,
			reason: expect.stringContaining(reason),
		});
	expect(demo.sent).toEqual([]);
	expect(expectOk(await todos.get(FORM_STEM))?.text).toBe(row.text);

	// An inherited guard is still present, and still travels.
	const saved = expectOk(
		await todos.replace(
			FORM_STEM,
			'guarded\n',
			Object.create({ expectedSha256: row.sha256 }),
		),
	);
	expect(saved.text).toBe('guarded\n');
	expect(
		(
			await todos.replace(
				FORM_STEM,
				'stale\n',
				Object.create({ expectedSha256: row.sha256 }),
			)
		).error,
	).toMatchObject({ name: 'Conflict' });
	expect(expectOk(await todos.get(FORM_STEM))?.text).toBe('guarded\n');
});
