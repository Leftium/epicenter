import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yargs from 'yargs';

import { epicenterRootOption } from './common-options.js';

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function tempEpicenterRoot() {
	const root = mkdtempSync(join(tmpdir(), 'ep-cli-root-'));
	roots.push(root);
	writeFileSync(join(root, 'epicenter.config.ts'), 'export default {};\n');
	const nested = join(root, 'nested', 'child');
	mkdirSync(nested, { recursive: true });
	return { root, nested };
}

describe('epicenterRootOption', () => {
	test('discovers the nearest Epicenter root from a start directory', () => {
		const { root, nested } = tempEpicenterRoot();
		const argv = yargs().option('C', epicenterRootOption).parseSync(['-C', nested]);

		expect(argv.C).toBe(root as typeof argv.C);
	});

	test('fails when discovery misses', () => {
		const root = mkdtempSync(join(tmpdir(), 'ep-cli-no-root-'));
		roots.push(root);

		expect(() =>
			yargs()
				.exitProcess(false)
				.option('C', epicenterRootOption)
				.parseSync(['-C', root]),
		).toThrow('No epicenter.config.ts found');
	});
});
