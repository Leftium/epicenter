import { type FSWatcher, watch } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'bun';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import type * as Y from 'yjs';
import type { MaybePromise } from '../../../shared/types.js';

// ════════════════════════════════════════════════════════════════════════════
// attachGitAutosave: optional, standalone git history for a directory
//
// Git is history/backup/publish, never the sync engine and never part of
// materialization or reconcile. So this is a SEPARATE primitive, decoupled from
// the markdown seams: it watches a directory and debounce-commits whatever
// changes there, knowing nothing about Yjs rows or the vault. Compose it next to
// a vault (or any directory) when a project wants an autosaved git trail; the
// seam itself stays git-unaware. Teardown is hooked to a Y.Doc's `destroy` so it
// disposes with the workspace it accompanies.
// ════════════════════════════════════════════════════════════════════════════

const GitAutosaveError = defineErrors({
	GitAddFailed: ({ stderr }: { stderr: string }) => ({
		message: `git autosave: git add failed: ${stderr.trim()}`,
		stderr,
	}),
	GitCommitFailed: ({ stderr }: { stderr: string }) => ({
		message: `git autosave: git commit failed: ${stderr.trim()}`,
		stderr,
	}),
	EnablementCheckFailed: ({ cause }: { cause: unknown }) => ({
		message: `git autosave: enablement check failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

export type GitAutosaveConfig = {
	author?: { name: string; email: string };
	quietMs?: number;
	maxBatchMs?: number;
};

/**
 * Watch `dir` and debounce-commit its changes to git. Returns `{ whenWatching }`,
 * resolved once the watcher is live (the directory exists and the repo check has
 * run). A non-repo directory is a no-op (logged once); git failures are logged
 * and never thrown, so autosave can never block whatever writes the directory.
 */
export function attachGitAutosave({
	ydoc,
	dir,
	config = {},
	log = createLogger('git-autosave'),
}: {
	/** Disposed when this doc is destroyed (mirrors the seam lifecycle). */
	ydoc: Y.Doc;
	/** Directory to watch. A string or async getter for lazy path resolution. */
	dir: string | (() => MaybePromise<string>);
	config?: GitAutosaveConfig;
	log?: Logger;
}) {
	const {
		author: { name = 'Autosave', email = 'autosave@epicenter.local' } = {},
		quietMs = 5_000,
		maxBatchMs = 60_000,
	} = config;

	const dirty = new Set<string>();
	let baseDir: string | undefined;
	let watcher: FSWatcher | undefined;
	let isEnabled: boolean | undefined;
	let enablement: Promise<boolean> | undefined;
	let isDisposed = false;
	let quietTimer: ReturnType<typeof setTimeout> | undefined;
	let maxBatchTimer: ReturnType<typeof setTimeout> | undefined;

	function clearTimers(): void {
		if (quietTimer !== undefined) {
			clearTimeout(quietTimer);
			quietTimer = undefined;
		}
		if (maxBatchTimer !== undefined) {
			clearTimeout(maxBatchTimer);
			maxBatchTimer = undefined;
		}
	}

	async function ensureEnabled(): Promise<boolean> {
		if (isEnabled !== undefined) return isEnabled;
		if (enablement !== undefined) return enablement;
		enablement = (async () => {
			const result = await $`git rev-parse --is-inside-work-tree`
				.cwd(baseDir ?? '.')
				.nothrow()
				.quiet();
			isEnabled =
				result.exitCode === 0 && result.stdout.toString().trim() === 'true';
			if (!isEnabled) log.info('git autosave: not in a git repo; skipping');
			return isEnabled;
		})().finally(() => {
			enablement = undefined;
		});
		return enablement;
	}

	function schedule(): void {
		if (isDisposed) return;
		if (quietTimer !== undefined) clearTimeout(quietTimer);
		quietTimer = setTimeout(() => {
			quietTimer = undefined;
			void stageAndCommit();
		}, quietMs);
		if (maxBatchTimer === undefined) {
			maxBatchTimer = setTimeout(() => {
				maxBatchTimer = undefined;
				void stageAndCommit();
			}, maxBatchMs);
		}
	}

	async function stageAndCommit(): Promise<void> {
		if (isDisposed) return;
		clearTimers();
		const batch = [...dirty];
		dirty.clear();
		if (batch.length === 0) return;
		if (!(await ensureEnabled())) return;
		await commitBatch(batch, false);
	}

	async function commitBatch(
		batch: readonly string[],
		retried: boolean,
	): Promise<void> {
		const add = await $`git add -- ${batch}`
			.cwd(baseDir ?? '.')
			.nothrow()
			.quiet();
		if (add.exitCode !== 0) {
			const stderr = add.stderr.toString();
			if (!retried && stderr.includes('index.lock')) {
				await Bun.sleep(250);
				await commitBatch(batch, true);
				return;
			}
			log.warn(GitAutosaveError.GitAddFailed({ stderr }));
			return;
		}

		const message = `Autosave (${batch.length} changes)`;
		const commit =
			await $`git -c commit.gpgsign=false commit --no-gpg-sign -m ${message} -- ${batch}`
				.cwd(baseDir ?? '.')
				.env({
					...process.env,
					GIT_AUTHOR_NAME: name,
					GIT_AUTHOR_EMAIL: email,
					GIT_COMMITTER_NAME: name,
					GIT_COMMITTER_EMAIL: email,
				})
				.nothrow()
				.quiet();
		if (commit.exitCode === 0) return;

		const output = `${commit.stdout.toString()}\n${commit.stderr.toString()}`;
		if (
			output.includes('nothing to commit') ||
			output.includes('nothing added to commit')
		) {
			return;
		}
		if (!retried && output.includes('index.lock')) {
			await Bun.sleep(250);
			await commitBatch(batch, true);
			return;
		}
		log.warn(GitAutosaveError.GitCommitFailed({ stderr: output }));
	}

	function dispose(): void {
		if (isDisposed) return;
		isDisposed = true;
		watcher?.close();
		clearTimers();
		dirty.clear();
	}

	ydoc.once('destroy', dispose);

	const whenWatching = (async () => {
		baseDir = typeof dir === 'function' ? await dir() : dir;
		await mkdir(baseDir, { recursive: true });
		await ensureEnabled();
		if (isDisposed) return;
		watcher = watch(baseDir, { recursive: true }, (_event, filename) => {
			if (isDisposed || filename === null) return;
			// `filename` is relative to the watched dir; enqueue the absolute path so
			// `git add` resolves it regardless of cwd.
			dirty.add(join(baseDir as string, filename.toString()));
			void ensureEnabled().then(
				(enabled) => {
					if (enabled && !isDisposed) schedule();
				},
				(cause) => log.warn(GitAutosaveError.EnablementCheckFailed({ cause })),
			);
		});
	})();

	return { whenWatching };
}

export type GitAutosave = ReturnType<typeof attachGitAutosave>;
