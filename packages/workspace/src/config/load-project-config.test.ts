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

	test('normalizes a single Mount default export into a Mount[]', async () => {
		writeConfig("export default { name: 'demo', open() {} };\n");

		const { data, error } = await loadProjectConfig(projectDir);
		if (error !== null) throw new Error(error.message);
		expect(data).toHaveLength(1);
		expect(data[0]?.name).toBe('demo');
		expect(data[0]?.open).toBeFunction();
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

	test('rejects a default export that is neither a Mount nor Mount[]', async () => {
		writeConfig('export default { notAMount: true };\n');

		const { error } = await loadProjectConfig(projectDir);
		expect(error).toMatchObject({
			name: 'ProjectConfigInvalid',
			projectConfigPath: join(projectDir, 'epicenter.config.ts'),
		});
	});

	test('rejects a Mount[] containing a non-Mount value', async () => {
		writeConfig("export default [{ name: 'demo', open() {} }, { open: 1 }];\n");

		const { error } = await loadProjectConfig(projectDir);
		expect(error?.name).toBe('ProjectConfigInvalid');
	});

	test('rejects a Mount that lacks open()', async () => {
		writeConfig("export default { name: 'demo' };\n");

		const { error } = await loadProjectConfig(projectDir);
		expect(error?.name).toBe('ProjectConfigInvalid');
	});

	test('rejects a Mount that lacks a string name', async () => {
		writeConfig('export default { open() {} };\n');

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
