/**
 * Markdown Vault Git Autosave Tests
 *
 * Verifies the optional `git` integration on `attachMarkdownVault`
 * against real Yjs workspaces, real markdown writes, and real temporary Git
 * repositories. These tests pin the materializer-owned contract: file writes
 * enqueue exact paths, timers batch those paths, and Git failures never block
 * markdown materialization.
 *
 * Key behaviors:
 * - quiet and max-batch timers commit materialized paths
 * - configured and default authors apply per commit without mutating config
 * - non-repo directories, empty batches, no-diff batches, and index locks do
 *   not stop markdown writes
 * - graceful destroy does not flush autosave; a subsequent attach re-enqueues
 */

import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'wellcrafted/logger';
import { createWorkspace, defineTable } from '../../../index.js';
import { column } from '../../column/index.js';
import { attachMarkdownVault, type GitAutosaveConfig } from './index.js';

const postsTable = defineTable({
	id: column.string(),
	title: column.string(),
	published: column.boolean(),
});

const tableDefinitions = { posts: postsTable };

type TestWorkspace = ReturnType<typeof createTestWorkspace>;

type GitResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
};

function createTestLogger() {
	const messages = {
		info: [] as string[],
		warn: [] as string[],
		error: [] as string[],
	};
	const logger = {
		error(value: unknown): void {
			messages.error.push(logMessage(value));
		},
		warn(value: unknown): void {
			messages.warn.push(logMessage(value));
		},
		info(message: string): void {
			messages.info.push(message);
		},
		debug(): void {},
		trace(): void {},
	} satisfies Logger;
	return { logger, messages };
}

function logMessage(value: unknown): string {
	if (value && typeof value === 'object') {
		if ('message' in value) return String(value.message);
		if ('error' in value) {
			const error = (value as { error?: unknown }).error;
			if (error && typeof error === 'object' && 'message' in error) {
				return String(error.message);
			}
		}
	}
	return String(value);
}

function setupProject() {
	const projectDir = mkdtempSync(join(tmpdir(), 'markdown-git-'));
	const markdownDir = join(projectDir, 'markdown');
	mkdirSync(markdownDir, { recursive: true });
	const logs = createTestLogger();

	return {
		projectDir,
		markdownDir,
		logs,
		async initGitRepo(): Promise<void> {
			await runGit(projectDir, ['init', '-q', '-b', 'main']);
			await runGit(projectDir, ['config', 'user.name', 'Repo User']);
			await runGit(projectDir, ['config', 'user.email', 'repo@example.com']);
			writeFileSync(join(projectDir, '.gitignore'), '.epicenter/\n');
			await runGit(projectDir, ['add', '.gitignore']);
			await runGit(projectDir, ['commit', '-q', '-m', 'init']);
		},
		createWorkspace(
			git?: GitAutosaveConfig,
			options: { countDestroyOnce?: () => void } = {},
		): TestWorkspace {
			return createTestWorkspace({
				markdownDir,
				git,
				log: logs.logger,
				countDestroyOnce: options.countDestroyOnce,
			});
		},
		cleanup(): void {
			rmSync(projectDir, { recursive: true, force: true });
		},
	};
}

function createTestWorkspace({
	markdownDir,
	git,
	log,
	countDestroyOnce,
}: {
	markdownDir: string;
	git?: GitAutosaveConfig;
	log: Logger;
	countDestroyOnce?: () => void;
}) {
	const workspace = createWorkspace({
		id: `markdown-git-${randomUUID()}`,
		tables: tableDefinitions,
		kv: {},
	});

	if (countDestroyOnce) {
		const originalOnce = workspace.ydoc.once.bind(workspace.ydoc);
		const patchedOnce: typeof workspace.ydoc.once = (name, listener) => {
			if (name === 'destroy') countDestroyOnce();
			return originalOnce(name, listener);
		};
		workspace.ydoc.once = patchedOnce;
	}

	const materializer = attachMarkdownVault(workspace, {
		dir: markdownDir,
		tables: { posts: {} },
		git,
		log,
	});

	return {
		...workspace,
		materializer,
		async ready(): Promise<void> {
			await materializer.whenFlushed;
		},
		[Symbol.dispose](): void {
			workspace[Symbol.dispose]();
		},
	};
}

async function runGit(
	cwd: string,
	args: readonly string[],
): Promise<GitResult> {
	const proc = Bun.spawn(['git', ...args], {
		cwd,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

async function commitCount(projectDir: string): Promise<number> {
	const result = await runGit(projectDir, ['rev-list', '--count', 'HEAD']);
	return Number(result.stdout.trim());
}

async function lastCommitSubject(projectDir: string): Promise<string> {
	const result = await runGit(projectDir, ['log', '-1', '--format=%s']);
	return result.stdout.trim();
}

async function lastCommitAuthor(projectDir: string): Promise<string> {
	const result = await runGit(projectDir, ['log', '-1', '--format=%an <%ae>']);
	return result.stdout.trim();
}

async function waitForCommitCount(
	projectDir: string,
	expected: number,
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if ((await commitCount(projectDir)) === expected) return;
		await Bun.sleep(10);
	}
	expect(await commitCount(projectDir)).toBe(expected);
}

function setPost(
	workspace: Pick<TestWorkspace, 'tables'>,
	id: string,
	title = id,
): void {
	workspace.tables.posts.set({ id, title, published: true });
}

describe('attachMarkdownVault git autosave', () => {
	test('quiet timer commits one batch for many observer writes', async () => {
		const project = setupProject();
		try {
			await project.initGitRepo();
			const workspace = project.createWorkspace({
				quietMs: 20,
				maxBatchMs: 1_000,
			});
			await workspace.ready();

			for (let i = 0; i < 5; i++) setPost(workspace, `post-${i}`);

			await waitForCommitCount(project.projectDir, 2);
			expect(await lastCommitSubject(project.projectDir)).toBe(
				'Autosave (5 changes)',
			);
			for (let i = 0; i < 5; i++) {
				expect(
					existsSync(join(project.markdownDir, 'posts', `post-${i}.md`)),
				).toBe(true);
			}

			workspace[Symbol.dispose]();
		} finally {
			project.cleanup();
		}
	});

	test('max-batch timer commits while quiet window remains open', async () => {
		const project = setupProject();
		try {
			await project.initGitRepo();
			const workspace = project.createWorkspace({
				quietMs: 1_000,
				maxBatchMs: 30,
			});
			await workspace.ready();

			setPost(workspace, 'force-batch');

			await waitForCommitCount(project.projectDir, 2);
			expect(await lastCommitSubject(project.projectDir)).toBe(
				'Autosave (1 changes)',
			);

			workspace[Symbol.dispose]();
		} finally {
			project.cleanup();
		}
	});

	test('empty materializer produces no autosave commit', async () => {
		const project = setupProject();
		try {
			await project.initGitRepo();
			const workspace = project.createWorkspace({
				quietMs: 10,
				maxBatchMs: 20,
			});
			await workspace.ready();
			await Bun.sleep(60);

			expect(await commitCount(project.projectDir)).toBe(1);

			workspace[Symbol.dispose]();
		} finally {
			project.cleanup();
		}
	});

	test('configured author applies per commit without mutating git config', async () => {
		const project = setupProject();
		try {
			await project.initGitRepo();
			const workspace = project.createWorkspace({
				author: { name: 'Configured Bot', email: 'bot@example.com' },
				quietMs: 10,
				maxBatchMs: 1_000,
			});
			await workspace.ready();

			setPost(workspace, 'configured-author');

			await waitForCommitCount(project.projectDir, 2);
			expect(await lastCommitAuthor(project.projectDir)).toBe(
				'Configured Bot <bot@example.com>',
			);
			expect(
				(
					await runGit(project.projectDir, ['config', 'user.name'])
				).stdout.trim(),
			).toBe('Repo User');
			expect(
				(
					await runGit(project.projectDir, ['config', 'user.email'])
				).stdout.trim(),
			).toBe('repo@example.com');

			workspace[Symbol.dispose]();
		} finally {
			project.cleanup();
		}
	});

	test('default author uses synthetic autosave identity', async () => {
		const project = setupProject();
		try {
			await project.initGitRepo();
			const workspace = project.createWorkspace({
				quietMs: 10,
				maxBatchMs: 1_000,
			});
			await workspace.ready();

			setPost(workspace, 'default-author');

			await waitForCommitCount(project.projectDir, 2);
			expect(await lastCommitAuthor(project.projectDir)).toBe(
				'Autosave <autosave@epicenter.local>',
			);

			workspace[Symbol.dispose]();
		} finally {
			project.cleanup();
		}
	});

	test('no-diff batch skips silently after files are already committed', async () => {
		const project = setupProject();
		try {
			await project.initGitRepo();

			const first = project.createWorkspace({ quietMs: 10, maxBatchMs: 1_000 });
			setPost(first, 'same-content');
			await first.ready();
			await waitForCommitCount(project.projectDir, 2);
			first[Symbol.dispose]();

			const second = project.createWorkspace({
				quietMs: 10,
				maxBatchMs: 1_000,
			});
			setPost(second, 'same-content');
			await second.ready();
			await Bun.sleep(80);

			expect(await commitCount(project.projectDir)).toBe(2);
			expect(project.logs.messages.warn).toEqual([]);
			second[Symbol.dispose]();
		} finally {
			project.cleanup();
		}
	});

	test('non-repo directory logs once and leaves markdown writes on disk', async () => {
		const project = setupProject();
		try {
			const workspace = project.createWorkspace({
				quietMs: 10,
				maxBatchMs: 20,
			});
			setPost(workspace, 'outside-repo');
			await workspace.ready();
			await Bun.sleep(60);

			expect(project.logs.messages.info).toEqual([
				'git autosave: not in a git repo; skipping',
			]);
			expect(project.logs.messages.warn).toEqual([]);
			expect(
				readFileSync(
					join(project.markdownDir, 'posts', 'outside-repo.md'),
					'utf8',
				),
			).toContain('title: outside-repo');

			workspace[Symbol.dispose]();
		} finally {
			project.cleanup();
		}
	});

	test('index.lock contention retries once and commits after the lock clears', async () => {
		const project = setupProject();
		try {
			await project.initGitRepo();
			const workspace = project.createWorkspace({
				quietMs: 10,
				maxBatchMs: 1_000,
			});
			await workspace.ready();

			const lockPath = join(project.projectDir, '.git', 'index.lock');
			writeFileSync(lockPath, 'locked');
			setTimeout(() => rmSync(lockPath, { force: true }), 80);
			setPost(workspace, 'retry-lock');

			await waitForCommitCount(project.projectDir, 2);
			expect(project.logs.messages.warn).toEqual([]);

			workspace[Symbol.dispose]();
		} finally {
			project.cleanup();
		}
	});

	test('index.lock contention leaves files uncommitted when the retry also fails', async () => {
		const project = setupProject();
		try {
			await project.initGitRepo();
			const workspace = project.createWorkspace({
				quietMs: 10,
				maxBatchMs: 1_000,
			});
			await workspace.ready();

			const lockPath = join(project.projectDir, '.git', 'index.lock');
			writeFileSync(lockPath, 'locked');
			setPost(workspace, 'stuck-lock');
			await Bun.sleep(350);

			expect(await commitCount(project.projectDir)).toBe(1);
			expect(project.logs.messages.warn[0]).toContain(
				'git autosave: git add failed',
			);
			expect(
				existsSync(join(project.markdownDir, 'posts', 'stuck-lock.md')),
			).toBe(true);
			rmSync(lockPath, { force: true });

			workspace[Symbol.dispose]();
		} finally {
			project.cleanup();
		}
	});

	test('destroy registers no autosave flush hook beyond materializer disposal', async () => {
		const project = setupProject();
		try {
			await project.initGitRepo();
			let destroyOnceCount = 0;
			const workspace = project.createWorkspace(
				{ quietMs: 10, maxBatchMs: 1_000 },
				{ countDestroyOnce: () => destroyOnceCount++ },
			);
			await workspace.ready();

			expect(destroyOnceCount).toBe(1);
			workspace[Symbol.dispose]();
		} finally {
			project.cleanup();
		}
	});

	test('destroy drops pending autosave and later attach re-enqueues materialized files', async () => {
		const project = setupProject();
		try {
			await project.initGitRepo();

			const first = project.createWorkspace({
				quietMs: 5_000,
				maxBatchMs: 5_000,
			});
			setPost(first, 'resurfaced');
			await first.ready();
			first[Symbol.dispose]();
			await Bun.sleep(80);
			expect(await commitCount(project.projectDir)).toBe(1);

			const second = project.createWorkspace({
				quietMs: 10,
				maxBatchMs: 1_000,
			});
			setPost(second, 'resurfaced');
			await second.ready();

			await waitForCommitCount(project.projectDir, 2);
			expect(await lastCommitSubject(project.projectDir)).toBe(
				'Autosave (1 changes)',
			);
			second[Symbol.dispose]();
		} finally {
			project.cleanup();
		}
	});

	test('omitted git option writes markdown without git setup', async () => {
		const project = setupProject();
		try {
			const workspace = project.createWorkspace(undefined);
			setPost(workspace, 'no-git-option');
			await workspace.ready();
			await Bun.sleep(60);

			expect(project.logs.messages.info).toEqual([]);
			expect(project.logs.messages.warn).toEqual([]);
			expect(
				existsSync(join(project.markdownDir, 'posts', 'no-git-option.md')),
			).toBe(true);

			workspace[Symbol.dispose]();
		} finally {
			project.cleanup();
		}
	});
});
