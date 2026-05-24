/**
 * Unit tests for the `epicenter daemon logs` helper.
 *
 * Covers `tailLines` returning the last N lines of a file (mirrors `tail`).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { tailLines } from './logs';

let scratchDir: string;

beforeEach(() => {
	// Scratch dir for test log files; tailLines reads arbitrary paths and
	// has no opinion about layout.
	scratchDir = mkdtempSync('/tmp/eps-logs-scratch-');
});

afterEach(() => {
	rmSync(scratchDir, { recursive: true, force: true });
});

describe('tailLines', () => {
	test('returns empty string for a missing file', () => {
		expect(tailLines(join(scratchDir, 'missing.log'), 10)).toBe('');
	});

	test('returns last N lines with trailing newline', () => {
		const p = join(scratchDir, 'a.log');
		writeFileSync(p, 'line1\nline2\nline3\nline4\n');
		expect(tailLines(p, 2)).toBe('line3\nline4\n');
	});
});
