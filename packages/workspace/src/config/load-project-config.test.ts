/**
 * Project config loading tests.
 *
 * Verifies that `epicenter.config.ts` is discovered, imported, and runtime
 * validated before daemon startup consumes the mount list.
 *
 * Invariant under test: `loadProjectConfig` is total. Every failure mode
 * (missing file, import/syntax error, wrong-shaped export) comes back as a
 * specific `ProjectConfigError` variant in the error channel; it never throws.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadProjectConfig } from './load-project-config.js';

let projectDir: string;

beforeEach(() => {
	projectDir = mkdtempSync(join(tmpdir(), 'load-project-config-'));
});

afterEach(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

function writeConfig(source: string): void {
	writeFileSync(join(projectDir, 'epicenter.config.ts'), source);
}

describe('loadProjectConfig', () => {
	test('returns a typed not-found error when the config is missing', async () => {
		const { data, error } = await loadProjectConfig(projectDir);
		expect(data).toBeNull();
		if (error === null) throw new Error('Expected ProjectConfigNotFound');
		expect(error).toMatchObject({
			name: 'ProjectConfigNotFound',
			projectConfigPath: join(projectDir, 'epicenter.config.ts'),
		});
	});

	test('passes through a Mount[] default export', async () => {
		writeConfig(
			"export default [{ name: 'a', open() {} }, { name: 'b', open() {} }];\n",
		);

		const { data, error } = await loadProjectConfig(projectDir);
		if (error !== null) throw new Error(error.message);
		expect(data.map((mount) => mount.name)).toEqual(['a', 'b']);
	});

	test('passes through an empty Mount[] default export', async () => {
		writeConfig('export default [];\n');

		const { data, error } = await loadProjectConfig(projectDir);
		if (error !== null) throw new Error(error.message);
		expect(data).toEqual([]);
	});

	test('rejects a non-array default export', async () => {
		writeConfig('export default { notAMount: true };\n');

		const { error } = await loadProjectConfig(projectDir);
		expect(error).toMatchObject({
			name: 'ProjectConfigInvalid',
			projectConfigPath: join(projectDir, 'epicenter.config.ts'),
		});
	});

	test('rejects a bare Mount that is not wrapped in an array', async () => {
		writeConfig("export default { name: 'demo', open() {} };\n");

		const { error } = await loadProjectConfig(projectDir);
		expect(error?.name).toBe('ProjectConfigInvalid');
	});

	test('rejects a Mount[] containing a non-Mount value', async () => {
		writeConfig("export default [{ name: 'demo', open() {} }, { open: 1 }];\n");

		const { error } = await loadProjectConfig(projectDir);
		expect(error?.name).toBe('ProjectConfigInvalid');
	});

	test('rejects a config with no default export', async () => {
		writeConfig('export const config = {};\n');

		const { error } = await loadProjectConfig(projectDir);
		expect(error?.name).toBe('ProjectConfigInvalid');
	});

	test('reports a structured import error for bad syntax', async () => {
		writeConfig('export default {;\n');

		const { error } = await loadProjectConfig(projectDir);
		expect(error).toMatchObject({
			name: 'ProjectConfigImportFailed',
			projectConfigPath: join(projectDir, 'epicenter.config.ts'),
		});
	});
});
