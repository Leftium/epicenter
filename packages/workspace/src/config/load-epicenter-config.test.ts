/**
 * Epicenter config loading tests.
 *
 * Verifies that `epicenter.config.ts` is discovered, imported, and runtime
 * validated before daemon startup consumes the mount list.
 *
 * Invariant under test: `loadEpicenterConfig` is total. Every failure mode
 * (missing file, import/syntax error, wrong-shaped export, bad mount name)
 * comes back as a specific `EpicenterConfigError` variant in the error channel;
 * it never throws. The config default-exports a single `Mount`.
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

	test('passes through a single Mount default export', async () => {
		writeConfig("export default { name: 'demo', open() {} };\n");

		const { data, error } = await loadEpicenterConfig(epicenterRoot);
		if (error !== null) throw new Error(error.message);
		expect(data.name).toBe('demo');
	});

	test('rejects a non-Mount default export', async () => {
		writeConfig('export default { notAMount: true };\n');

		const { error } = await loadEpicenterConfig(epicenterRoot);
		expect(error).toMatchObject({
			name: 'EpicenterConfigInvalid',
			epicenterConfigPath: join(epicenterRoot, 'epicenter.config.ts'),
		});
	});

	test('rejects a Mount[] with a pointer to export the mount directly', async () => {
		writeConfig("export default [{ name: 'demo', open() {} }];\n");

		const { error } = await loadEpicenterConfig(epicenterRoot);
		expect(error).toMatchObject({
			name: 'EpicenterConfigInvalid',
			detail:
				'the default export is a Mount[]; one folder declares one mount, so export it directly, for example `export default fuji()`',
		});
	});

	test('rejects a mount with a bad name', async () => {
		writeConfig("export default { name: '__proto__', open() {} };\n");

		const { error } = await loadEpicenterConfig(epicenterRoot);
		expect(error).toMatchObject({
			name: 'EpicenterConfigInvalid',
			detail: expect.stringContaining('the mount name "__proto__" is invalid'),
		});
	});

	test('accepts a mount with just name and open (no kind needed)', async () => {
		writeConfig("export default { name: 'demo', open() {} };\n");

		const { data, error } = await loadEpicenterConfig(epicenterRoot);
		if (error !== null) throw new Error(error.message);
		expect(data.name).toBe('demo');
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
