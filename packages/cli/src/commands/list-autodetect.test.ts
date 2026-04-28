/**
 * Coverage for the IPC-dispatch path of `list`.
 *
 * These tests exercise the seams the yargs handler relies on without
 * running yargs itself:
 *
 *   1. `listCore` against a fake `WorkspaceEntry` produces the same
 *      `ListResult` whether called in-process or over IPC (so the
 *      renderer can't tell which path built it).
 *   2. The IPC dispatch route built into `up.ts` returns a
 *      structurally-identical `ListResult` to the local one.
 *
 * Workspace-routing on the daemon side (using `args.workspace` to pick
 * an entry via `resolveEntry`) is covered by `up.ts`'s own tests; here
 * we just confirm the wire shape round-trips cleanly.
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

import { buildApp } from '../daemon/app';
import { daemonClient } from '../daemon/client';
import { bindUnixSocket } from '../daemon/unix-socket';
import { socketPathFor } from '../daemon/paths';
import type { LoadedWorkspace, WorkspaceEntry } from '../load-config';
import { listCore } from './list';

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

describe('listCore: local mode', () => {
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

describe('listCore: IPC parity', () => {
	test('IPC dispatch produces a structurally-identical ListResult to the in-process call', async () => {
		const entry = fakeEntry('demo');

		// Direct (transient) path.
		const direct = await listCore(entry, {
			path: '',
			mode: { kind: 'local' },
			waitMs: 0,
		});

		// IPC path: stand up the production Hono app (with the real `/list`
		// route) bound to a unix socket, then call it through the typed
		// `daemonClient` and assert structural equality with the cold path.
		const sockPath = socketPathFor(workDir);
		const app = buildApp([entry], () => {});
		const server = await bindUnixSocket(sockPath, app);
		try {
			const reply = await daemonClient(sockPath).list({
				path: '',
				mode: { kind: 'local' },
				waitMs: 0,
			});
			expect(reply).toEqual(direct);
		} finally {
			server.stop();
		}
	});
});
