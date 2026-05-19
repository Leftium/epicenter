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

	test('loads an empty config', async () => {
		writeConfig('export default {};\n');

		const { data, error } = await loadProjectConfig(projectDir);
		if (error !== null) throw new Error(error.message);
		expect(data).toEqual({});
	});

	test('loads routes from the config default export', async () => {
		writeConfig("export default { routes: [{ route: 'demo', open() {} }] };\n");

		const { data, error } = await loadProjectConfig(projectDir);
		if (error !== null) throw new Error(error.message);
		expect(data.routes).toHaveLength(1);
		expect(data.routes?.[0]?.open).toBeFunction();
	});

	test('throws with the config path when the default export is invalid', async () => {
		writeConfig('export default { routes: {} };\n');

		await expect(loadProjectConfig(projectDir)).rejects.toThrow(
			`loadProjectConfig: ${join(projectDir, 'epicenter.config.ts')} is invalid`,
		);
	});

	test('throws with the config path when the default export is missing', async () => {
		writeConfig('export const config = {};\n');

		await expect(loadProjectConfig(projectDir)).rejects.toThrow(
			`loadProjectConfig: ${join(projectDir, 'epicenter.config.ts')} must default-export`,
		);
	});

	test('throws with the config path when the config has bad syntax', async () => {
		writeConfig('export default {;\n');

		await expect(loadProjectConfig(projectDir)).rejects.toThrow(
			`loadProjectConfig: failed to load ${join(projectDir, 'epicenter.config.ts')}`,
		);
	});
});
