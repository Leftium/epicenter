/**
 * Epicenter config loading tests.
 *
 * Verifies that `epicenter.config.ts` is discovered, imported, and runtime
 * validated before daemon startup consumes the mount list.
 *
 * Invariant under test: `loadEpicenterConfig` is total. Every failure mode
 * (missing file, import/syntax error, wrong-shaped export) comes back as a
 * specific `EpicenterConfigError` variant in the error channel; it never throws.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadEpicenterConfig } from './load-epicenter-config.js';

let epicenterRoot: string;

beforeEach(() => {
	epicenterRoot = mkdtempSync(join(tmpdir(), 'load-epicenter-config-'));
});

afterEach(() => {
	rmSync(epicenterRoot, { recursive: true, force: true });
});

function writeConfig(source: string): void {
	writeFileSync(join(epicenterRoot, 'epicenter.config.ts'), source);
}

describe('loadEpicenterConfig', () => {
	test('returns a typed not-found error when the config is missing', async () => {
		const { data, error } = await loadEpicenterConfig(epicenterRoot);
		expect(data).toBeNull();
		if (error === null) throw new Error('Expected EpicenterConfigNotFound');
		expect(error).toMatchObject({
			name: 'EpicenterConfigNotFound',
			epicenterConfigPath: join(epicenterRoot, 'epicenter.config.ts'),
		});
	});

	test('passes through a Mount[] default export', async () => {
		writeConfig(
			"export default [{ name: 'a', open() {} }, { name: 'b', open() {} }];\n",
		);

		const { data, error } = await loadEpicenterConfig(epicenterRoot);
		if (error !== null) throw new Error(error.message);
		expect(data.map((mount) => mount.name)).toEqual(['a', 'b']);
	});

	test('passes through an empty Mount[] default export', async () => {
		writeConfig('export default [];\n');

		const { data, error } = await loadEpicenterConfig(epicenterRoot);
		if (error !== null) throw new Error(error.message);
		expect(data).toEqual([]);
	});

	test('rejects a non-array default export', async () => {
		writeConfig('export default { notAMount: true };\n');

		const { error } = await loadEpicenterConfig(epicenterRoot);
		expect(error).toMatchObject({
			name: 'EpicenterConfigInvalid',
			epicenterConfigPath: join(epicenterRoot, 'epicenter.config.ts'),
		});
	});

	test('rejects a bare Mount that is not wrapped in an array', async () => {
		writeConfig("export default { name: 'demo', open() {} };\n");

		const { error } = await loadEpicenterConfig(epicenterRoot);
		expect(error).toMatchObject({
			name: 'EpicenterConfigInvalid',
			detail:
				'the default export is a single Mount; wrap it in an array, for example `export default [fuji()]`',
		});
	});

	test('rejects a Mount[] containing a non-Mount value', async () => {
		writeConfig("export default [{ name: 'demo', open() {} }, { open: 1 }];\n");

		const { error } = await loadEpicenterConfig(epicenterRoot);
		expect(error?.name).toBe('EpicenterConfigInvalid');
	});

	test('accepts a mount with just name and open (no kind needed)', async () => {
		writeConfig("export default [{ name: 'demo', open() {} }];\n");

		const { data, error } = await loadEpicenterConfig(epicenterRoot);
		if (error !== null) throw new Error(error.message);
		expect(data.map((mount) => mount.name)).toEqual(['demo']);
	});

	test('rejects a config with no default export', async () => {
		writeConfig('export const config = {};\n');

		const { error } = await loadEpicenterConfig(epicenterRoot);
		expect(error?.name).toBe('EpicenterConfigInvalid');
	});

	test('reports a structured import error for bad syntax', async () => {
		writeConfig('export default {;\n');

		const { error } = await loadEpicenterConfig(epicenterRoot);
		expect(error).toMatchObject({
			name: 'EpicenterConfigImportFailed',
			epicenterConfigPath: join(epicenterRoot, 'epicenter.config.ts'),
		});
	});
});
