/**
 * Wave 6 coverage for the auto-detect / IPC dispatch path of `list`.
 *
 * These tests exercise the seams the yargs handler relies on without
 * running yargs itself:
 *
 *   1. `listCore` against a fake `WorkspaceEntry` produces the same
 *      `ListResult` whether called in-process or over IPC (so the
 *      renderer can't tell which path built it).
 *   2. `inheritWorkspace` honors the daemon's metadata when the user
 *      omits `--workspace` and refuses with the literal spec message
 *      when they pass a conflicting value.
 *   3. The IPC dispatch route built into `up.ts` returns a
 *      structurally-identical `ListResult` to the local one.
 */

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startIpcServer, type IpcHandler } from '../daemon/ipc-server';
import { ipcCall } from '../daemon/ipc-client';
import { writeMetadata } from '../daemon/metadata';
import { socketPathFor } from '../daemon/paths';
import type { LoadedWorkspace, WorkspaceEntry } from '../load-config';
import { inheritWorkspace, listCore, type ListResult } from './list';

let originalXdg: string | undefined;
let originalHome: string | undefined;
let runtimeRoot: string;
let homeRoot: string;
let workDir: string;

beforeEach(() => {
	originalXdg = process.env.XDG_RUNTIME_DIR;
	originalHome = process.env.HOME;

	runtimeRoot = mkdtempSync(join(tmpdir(), 'ep-listad-'));
	process.env.XDG_RUNTIME_DIR = runtimeRoot;
	mkdirSync(join(runtimeRoot, 'epicenter'), { recursive: true });

	homeRoot = mkdtempSync(join(tmpdir(), 'ep-listad-home-'));
	process.env.HOME = homeRoot;

	workDir = mkdtempSync(join(tmpdir(), 'ep-listad-dir-'));
	writeFileSync(join(workDir, 'epicenter.config.ts'), 'export {};\n');
});

afterEach(() => {
	if (originalXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
	else process.env.XDG_RUNTIME_DIR = originalXdg;
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;

	rmSync(runtimeRoot, { recursive: true, force: true });
	rmSync(homeRoot, { recursive: true, force: true });
	rmSync(workDir, { recursive: true, force: true });
	process.exitCode = 0;
});

function fakeEntry(name: string, actions?: Record<string, unknown>): WorkspaceEntry {
	const workspace: LoadedWorkspace = {
		whenReady: Promise.resolve(),
		actions: actions as LoadedWorkspace['actions'],
		[Symbol.dispose]() {
			/* no-op */
		},
	};
	return { name, workspace } as WorkspaceEntry;
}

describe('listCore — local mode', () => {
	test('returns a sections result with self section labelled by entry name', async () => {
		const entry = fakeEntry('demo');
		const result = await listCore(entry, {
			path: '',
			mode: { kind: 'local' },
			waitMs: 0,
		});
		expect(result.error).toBeNull();
		if (result.error !== null) return;
		expect(result.data.sections).toHaveLength(1);
		expect(result.data.sections[0]!.label).toBe('demo');
		expect(result.data.sections[0]!.peer).toBe('self');
	});
});

describe('inheritWorkspace — Invariant 7', () => {
	test('returns the daemon\'s workspace when user omits --workspace', () => {
		writeMetadata(workDir, {
			pid: process.pid,
			dir: workDir,
			workspace: 'alpha',
			deviceId: 'dev',
			startedAt: new Date().toISOString(),
			cliVersion: '0.0.0',
			configMtime: 0,
		});
		const result = inheritWorkspace(workDir, undefined);
		expect(result).toBe('alpha');
	});

	test('passes through user value when it agrees with metadata', () => {
		writeMetadata(workDir, {
			pid: process.pid,
			dir: workDir,
			workspace: 'alpha',
			deviceId: 'dev',
			startedAt: new Date().toISOString(),
			cliVersion: '0.0.0',
			configMtime: 0,
		});
		const result = inheritWorkspace(workDir, 'alpha');
		expect(result).toBe('alpha');
	});

	test('returns "mismatch" with literal spec message when --workspace disagrees', () => {
		writeMetadata(workDir, {
			pid: process.pid,
			dir: workDir,
			workspace: 'alpha',
			deviceId: 'dev',
			startedAt: new Date().toISOString(),
			cliVersion: '0.0.0',
			configMtime: 0,
		});

		// Capture stderr to assert the literal message — `outputError` writes
		// through `console.error`, so swap that out, not `process.stderr.write`.
		const captured: string[] = [];
		const origError = console.error;
		console.error = (...args: unknown[]) => {
			captured.push(args.map((a) => String(a)).join(' '));
		};

		try {
			const result = inheritWorkspace(workDir, 'beta');
			expect(result).toBe('mismatch');
			expect(process.exitCode).toBe(1);
		} finally {
			console.error = origError;
		}

		const joined = captured.join('\n');
		expect(joined).toContain(
			"workspace mismatch: daemon owns 'alpha', requested 'beta' — restart the daemon or omit --workspace",
		);
	});

	test('passes user value through unchanged when no metadata exists', () => {
		expect(inheritWorkspace(workDir, 'alpha')).toBe('alpha');
		expect(inheritWorkspace(workDir, undefined)).toBeUndefined();
	});
});

describe('listCore — IPC parity', () => {
	test('IPC dispatch produces a structurally-identical ListResult to the in-process call', async () => {
		const entry = fakeEntry('demo');

		// Direct (transient) path.
		const direct = await listCore(entry, {
			path: '',
			mode: { kind: 'local' },
			waitMs: 0,
		});

		// IPC path: stand up a tiny server whose handler delegates to listCore,
		// mirroring the shape `up.ts`'s `makeHandler` will use after Wave 6.
		const sockPath = socketPathFor(workDir);
		const handler: IpcHandler = (req, send) => {
			if (req.cmd === 'list') {
				void (async () => {
					const data: ListResult = await listCore(
						entry,
						req.args as Parameters<typeof listCore>[1],
					);
					send({ id: req.id, data, error: null });
				})();
			}
		};
		const server = await startIpcServer(sockPath, handler);
		try {
			const reply = await ipcCall<ListResult>(sockPath, 'list', {
				path: '',
				mode: { kind: 'local' },
				waitMs: 0,
			});
			expect(reply.error).toBeNull();
			if (reply.error !== null) return;
			expect(reply.data).toEqual(direct);
		} finally {
			server.stop();
		}
	});
});
