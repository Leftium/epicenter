/**
 * The captures table's interpreter for tests that hold no folder.
 *
 * It is the real one, taken from a folder opened over an empty temporary
 * directory that nothing is ever saved to, so a test reads source exactly as
 * the app does.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureDefinition } from '@epicenter/capture';
import { openFolder } from '@epicenter/folder/bun';

export async function captureInspector() {
	const root = await mkdtemp(join(tmpdir(), 'capture-inspect-'));
	const opened = await openFolder({
		root,
		definition: captureDefinition,
		git: {
			author: { name: 'Test', email: 'test@localhost' },
			commitOnEdit: false,
		},
	});
	if (opened.error) throw new Error(opened.error.message);
	// `inspect` reads no file, so it outlives the folder it came from.
	const { inspect } = opened.data.tables.captures;
	await opened.data.close();
	await rm(root, { recursive: true, force: true });
	return inspect;
}
