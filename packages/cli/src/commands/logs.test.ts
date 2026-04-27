/**
 * Wave 7 unit tests for `epicenter logs` helpers.
 *
 * Covers:
 *   - `tailLines` returns the last N lines of a file (mirrors `tail`).
 *   - `pickSoleDaemon` resolves to `'one'`/`'none'`/`'many'` correctly.
 *   - `followLog` streams new bytes and reopens after rotation.
 */

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeMetadata } from '../daemon/metadata';
import { followLog, pickSoleDaemon, tailLines } from './logs';

let originalXdg: string | undefined;
let originalHome: string | undefined;
let runtimeRoot: string;
let homeRoot: string;

beforeEach(() => {
	originalXdg = process.env.XDG_RUNTIME_DIR;
	originalHome = process.env.HOME;
	runtimeRoot = mkdtempSync(join(tmpdir(), 'ep-logs-'));
	process.env.XDG_RUNTIME_DIR = runtimeRoot;
	mkdirSync(join(runtimeRoot, 'epicenter'), { recursive: true });
	homeRoot = mkdtempSync(join(tmpdir(), 'ep-logs-home-'));
	process.env.HOME = homeRoot;
});

afterEach(() => {
	if (originalXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
	else process.env.XDG_RUNTIME_DIR = originalXdg;
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	rmSync(runtimeRoot, { recursive: true, force: true });
	rmSync(homeRoot, { recursive: true, force: true });
});

describe('tailLines', () => {
	test('returns empty string for a missing file', () => {
		expect(tailLines(join(runtimeRoot, 'missing.log'), 10)).toBe('');
	});

	test('returns last N lines with trailing newline', () => {
		const p = join(runtimeRoot, 'a.log');
		writeFileSync(p, 'line1\nline2\nline3\nline4\n');
		expect(tailLines(p, 2)).toBe('line3\nline4\n');
	});
});

describe('pickSoleDaemon', () => {
	test('none when runtime is empty', () => {
		expect(pickSoleDaemon().kind).toBe('none');
	});

	test('one when exactly one metadata file exists', () => {
		const dir = mkdtempSync(join(tmpdir(), 'ep-logs-one-'));
		try {
			writeMetadata(dir, {
				pid: process.pid,
				dir,
				workspace: 'w',
				deviceId: 'd',
				startedAt: new Date().toISOString(),
				cliVersion: '0.0.0',
				configMtime: 0,
			});
			const r = pickSoleDaemon();
			expect(r.kind).toBe('one');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('many when more than one', () => {
		const a = mkdtempSync(join(tmpdir(), 'ep-logs-a-'));
		const b = mkdtempSync(join(tmpdir(), 'ep-logs-b-'));
		try {
			for (const d of [a, b]) {
				writeMetadata(d, {
					pid: process.pid,
					dir: d,
					workspace: 'w',
					deviceId: 'd',
					startedAt: new Date().toISOString(),
					cliVersion: '0.0.0',
					configMtime: 0,
				});
			}
			const r = pickSoleDaemon();
			expect(r.kind).toBe('many');
		} finally {
			rmSync(a, { recursive: true, force: true });
			rmSync(b, { recursive: true, force: true });
		}
	});
});

describe('followLog', () => {
	test('streams appended bytes and reopens after rotate', async () => {
		const p = join(runtimeRoot, 'follow.log');
		writeFileSync(p, 'first\n');

		const captured: string[] = [];
		const origWrite = process.stdout.write.bind(process.stdout);
		(process.stdout as unknown as { write: (b: Buffer | string) => boolean }).write = (
			b: Buffer | string,
		) => {
			captured.push(typeof b === 'string' ? b : b.toString('utf8'));
			return true;
		};

		const stop = followLog(p);
		try {
			// Append more bytes — fs.watch should fire 'change'.
			await new Promise((r) => setTimeout(r, 50));
			appendFileSync(p, 'second\n');
			await new Promise((r) => setTimeout(r, 200));

			// Rotate: rename current to .1, then create a fresh current.
			renameSync(p, `${p}.1`);
			writeFileSync(p, 'third\n');
			await new Promise((r) => setTimeout(r, 300));

			// Append after rotate — should reach the new fd.
			appendFileSync(p, 'fourth\n');
			await new Promise((r) => setTimeout(r, 300));
		} finally {
			stop();
			(process.stdout as unknown as { write: typeof origWrite }).write =
				origWrite;
		}

		const all = captured.join('');
		// We do not assert ordering across rotation deterministically across
		// platforms, but at minimum we want post-rotate bytes to have shown up.
		expect(all).toContain('second');
		// Either 'third' (from drain on reopen) or 'fourth' (from change event)
		// should make it through.
		expect(all.includes('third') || all.includes('fourth')).toBe(true);
	});
});
