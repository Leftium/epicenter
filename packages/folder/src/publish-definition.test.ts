/**
 * Publication attempt contract: awaited unconditional writes, unsupported
 * export with no writes, and failure diagnostics retaining uncertain outcomes.
 */
import { afterEach, expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import { fileCapture } from './capture.js';
import { defineFolder } from './definition.js';
import { FileError } from './errors.js';
import { events } from './publication-log.test-support.js';

afterEach(() => {
	events.length = 0;
});
const { publishDefinition } = await import('./publish-definition.js');

const definition = defineFolder({ kv: {}, tables: {} });

test('each attempt overwrites unconditionally and waits for the file outcome', async () => {
	let writes = 0;
	const done = Promise.withResolvers<void>();
	const files = {
		overwrite: async (path: string, text: string) => {
			writes++;
			expect(path).toBe('definition.json');
			expect(text.endsWith('\n')).toBe(true);
			await done.promise;
			return Ok(fileCapture(path, '0'.repeat(64)));
		},
	};
	let returned = false;
	const opening = publishDefinition(definition, files).then(() => {
		returned = true;
	});
	await Promise.resolve();
	expect(writes).toBe(1);
	expect(returned).toBe(false);
	done.resolve();
	await opening;
	await publishDefinition(definition, files);
	expect(writes).toBe(2);
});

test('a lost write reply preserves Unconfirmed and its actual cause in the diagnostic', async () => {
	const lost = new Error('Lost native reply after sending overwrite');
	const refusal = FileError.Unconfirmed({
		operation: 'overwrite',
		path: 'definition.json',
		cause: lost,
	});
	await publishDefinition(definition, { overwrite: async () => refusal });
	expect(events).toHaveLength(1);
	expect(events[0]).toMatchObject({
		source: 'folder/definition',
		level: 'error',
		data: {
			name: 'DefinitionPublicationUnconfirmed',
			path: 'definition.json',
			cause: refusal.error,
		},
	});
});

test('a thrown write retains its cause without claiming whether the save landed', async () => {
	const cause = new Error('Connection closed after sending overwrite');
	await publishDefinition(definition, {
		overwrite: async () => {
			throw cause;
		},
	});
	expect(events).toHaveLength(1);
	expect(events[0]?.data).toMatchObject({
		name: 'DefinitionPublicationUnconfirmed',
		path: 'definition.json',
		cause,
	});
});
