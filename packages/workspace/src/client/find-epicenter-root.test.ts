import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EpicenterRoot } from '../shared/types.js';
import { findEpicenterRoot } from './find-epicenter-root.js';

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'find-epicenter-root-'));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function writeEpicenterConfig(dir: string = root): void {
	writeFileSync(join(dir, 'epicenter.config.ts'), 'export default {};\n');
}

describe('findEpicenterRoot', () => {
	test('finds an Epicenter root by epicenter.config.ts', () => {
		writeEpicenterConfig();

		expect(findEpicenterRoot(root)).toBe(root as EpicenterRoot);
	});

	test('walks up from a nested subdirectory', () => {
		writeEpicenterConfig();
		const nested = join(root, 'a', 'b', 'c');
		mkdirSync(nested, { recursive: true });

		expect(findEpicenterRoot(nested)).toBe(root as EpicenterRoot);
	});

	test('ignores workspaces and .epicenter as root markers', () => {
		mkdirSync(join(root, 'workspaces'));
		mkdirSync(join(root, '.epicenter'));

		expect(() => findEpicenterRoot(root)).toThrow(
			/No epicenter\.config\.ts found/,
		);
	});

	test('throws if no config is found before the filesystem root', () => {
		expect(() => findEpicenterRoot(root)).toThrow(
			`No epicenter.config.ts found walking up from ${root}.`,
		);
	});
});
