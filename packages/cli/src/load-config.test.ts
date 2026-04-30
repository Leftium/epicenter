import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_FILENAME, loadConfig } from './load-config';

let workDir: string;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), 'ep-load-config-'));
});

afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
});

function writeConfig(source: string) {
	mkdirSync(workDir, { recursive: true });
	writeFileSync(join(workDir, CONFIG_FILENAME), source);
}

describe('loadConfig', () => {
	test('rejects disposable workspace exports without an actions object', async () => {
		writeConfig(`
			export const demo = {
				[Symbol.dispose]() {}
			};
		`);

		const result = await loadConfig(workDir);

		expect(result.data).toBeNull();
		expect(result.error?.name).toBe('InvalidWorkspace');
		if (result.error?.name === 'InvalidWorkspace') {
			expect(result.error.exportName).toBe('demo');
		}
	});
});
