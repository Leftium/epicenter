/**
 * Demo server and HTTP facade (EXPERIMENT)
 *
 * Runs the real demo server over its own disposable folder and drives the
 * browser facade into its fetch handler directly, with no port. This covers
 * the wire between them, which the native folder tests do not reach.
 *
 * Key behaviors:
 * - a removed row travels as an explicit `null` and reads as missing, not unreadable
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
	const folder = createHttpFolder({
		send: (path, init) =>
			server.fetch(new Request(new URL(path, ORIGIN), init)),
		onFilesChanged: () => () => {},
	});
	return {
		folder,
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
