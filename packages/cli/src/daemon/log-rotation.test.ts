/**
 * Unit tests for {@link rotateIfNeeded}.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rotateIfNeeded } from './log-rotation';

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'ep-rotate-'));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe('rotateIfNeeded', () => {
	test('no-op when file does not exist', () => {
		rotateIfNeeded(join(dir, 'missing.log'), 10);
		expect(existsSync(join(dir, 'missing.log'))).toBe(false);
	});

	test('no-op when file is below threshold', () => {
		const p = join(dir, 'a.log');
		writeFileSync(p, 'hello');
		rotateIfNeeded(p, 1024);
		expect(readFileSync(p, 'utf8')).toBe('hello');
		expect(existsSync(`${p}.1`)).toBe(false);
	});

	test('rotates when size meets threshold; .log.1 carries old contents', () => {
		const p = join(dir, 'a.log');
		writeFileSync(p, 'X'.repeat(100));
		rotateIfNeeded(p, 100);
		expect(existsSync(p)).toBe(false);
		expect(existsSync(`${p}.1`)).toBe(true);
		expect(statSync(`${p}.1`).size).toBe(100);
	});

	test('shifts generations and drops .3 on subsequent rotates', () => {
		const p = join(dir, 'a.log');
		// Seed pre-existing generations.
		writeFileSync(p, 'CURRENT'.repeat(50));
		writeFileSync(`${p}.1`, 'GEN1');
		writeFileSync(`${p}.2`, 'GEN2');
		writeFileSync(`${p}.3`, 'GEN3-WILL-BE-DROPPED');

		rotateIfNeeded(p, 1);

		// Current rotated to .1
		expect(readFileSync(`${p}.1`, 'utf8')).toContain('CURRENT');
		// .1 → .2
		expect(readFileSync(`${p}.2`, 'utf8')).toBe('GEN1');
		// .2 → .3
		expect(readFileSync(`${p}.3`, 'utf8')).toBe('GEN2');
		// .3 dropped
		expect(existsSync(`${p}.4`)).toBe(false);
	});

	test('rotates when caller writes 10.5 MB then triggers', () => {
		const p = join(dir, 'big.log');
		const tenAndHalf = 10.5 * 1024 * 1024;
		writeFileSync(p, Buffer.alloc(tenAndHalf));
		rotateIfNeeded(p, 10 * 1024 * 1024);
		expect(existsSync(`${p}.1`)).toBe(true);
		expect(existsSync(p)).toBe(false);
		// Subsequent fresh write would create a new <p>.
		writeFileSync(p, 'fresh');
		expect(readFileSync(p, 'utf8')).toBe('fresh');
	});
});
