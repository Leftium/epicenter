import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { $ } from 'bun';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import type { Logger } from 'wellcrafted/logger';
import { assembleMarkdown } from '../../../markdown/assemble-markdown.js';
import type { BaseRow } from '../../table.js';
import type { AnyTable } from '../shared.js';

// ════════════════════════════════════════════════════════════════════════════
// Shared substrate for the two markdown seams (vault + export)
//
// Both seams continuously materialize Yjs -> disk: an observe-driven write of
// every valid row to a `.md` file, plus a destructive `rebuild`. They differ
// only in HOW a row renders to a file (the vault is rigid: `<id>.md`, frontmatter
// is the row; the export is free: custom filename + serialization). That single
// difference is injected as a `RenderRow`; everything else lives here.
// ════════════════════════════════════════════════════════════════════════════

/** Frontmatter + optional body, the parsed/assembled shape of a `.md` file. */
export type MarkdownShape = {
	frontmatter: Record<string, unknown>;
	body: string | undefined;
};

/** Render a row to its on-disk artifact: the one thing the two seams disagree on. */
export type RenderRow = (
	row: BaseRow,
) => Promise<{ filename: string; content: string }>;

/**
 * What materialize last wrote for a row, keyed by id. Drives rename cleanup (the
 * filename changed) and, later, dirty detection (the on-disk content diverged
 * from what we wrote, so a local edit is pending and must not be stomped).
 */
export type FileState = Map<string, { filename: string; content: string }>;

/**
 * Errors produced by the background write-observer (table row → .md file).
 * These run inside `.catch(...)` of a detached async task, so they ship to the
 * logger, not through a Result to the caller.
 */
export const MaterializerWriteError = defineErrors({
	TableWriteFailed: ({
		tableName,
		id,
		cause,
	}: {
		tableName: string;
		id?: string;
		cause: unknown;
	}) => ({
		message: `[markdown] table write failed for "${tableName}"${id ? ` (row "${id}")` : ''}: ${extractErrorMessage(cause)}`,
		tableName,
		id,
		cause,
	}),
});

/**
 * Best-effort unlink. Returns `true` when the file actually went away (so the
 * caller can mark it dirty for git); `false` when it was already missing or the
 * remove failed.
 */
export async function tryUnlink(
	directory: string,
	filename: string,
): Promise<boolean> {
	try {
		await unlink(join(directory, filename));
		return true;
	} catch {
		return false;
	}
}

/**
 * Write a markdown file under `directory`, creating any intermediate
 * subdirectories implied by a filename like `"archive/old.md"`.
 */
export async function writeMarkdownFile(
	directory: string,
	filename: string,
	content: string,
): Promise<void> {
	const fullPath = join(directory, filename);
	const parent = dirname(fullPath);
	if (parent !== directory) {
		await mkdir(parent, { recursive: true });
	}
	await writeFile(fullPath, content);
}

/** Assemble frontmatter + body into the on-disk string. Re-exported for seams. */
export { assembleMarkdown };

/**
 * Continuously materialize one table to `directory`: an initial flush of every
 * valid row, then an observe that rewrites a row's file on change and unlinks it
 * when the row goes invalid or is deleted. Returns the observer unsubscribe.
 *
 * Only CONTENT PRODUCTION is guarded: a throwing `render` (e.g. a body read
 * hitting its connect deadline) skips that one row and leaves its existing `.md`
 * intact, instead of aborting the rest of the flush or the observe batch. A real
 * filesystem write failure (ENOSPC, EACCES) is NOT swallowed: it propagates, so
 * the initial flush rejects and the observer's outer catch surfaces it.
 */
export async function materializeTable(opts: {
	table: AnyTable;
	directory: string;
	render: RenderRow;
	fileState: FileState;
	log: Logger;
	markDirty: (path: string) => void;
}): Promise<() => void> {
	const { table, directory, render, fileState, log, markDirty } = opts;

	await mkdir(directory, { recursive: true });

	// Write one valid row to disk, shared by the initial flush and the observer.
	// The rename branch is a no-op on first write (`fileState` starts empty), so
	// both paths run this exact code.
	async function writeRow(id: string, row: BaseRow): Promise<void> {
		let rendered: { filename: string; content: string };
		try {
			rendered = await render(row);
		} catch (cause) {
			log.warn(
				MaterializerWriteError.TableWriteFailed({
					tableName: table.name,
					id,
					cause,
				}),
			);
			return;
		}
		const { filename, content } = rendered;
		const previous = fileState.get(id);
		if (previous && previous.filename !== filename) {
			const removed = await tryUnlink(directory, previous.filename);
			if (removed) markDirty(join(directory, previous.filename));
		}
		await writeMarkdownFile(directory, filename, content);
		fileState.set(id, { filename, content });
		markDirty(join(directory, filename));
	}

	for (const row of table.getAllValid()) {
		await writeRow(row.id, row);
	}

	// Sequential writes inside the observer avoid rename races; a parallel
	// approach (Promise.allSettled) could delete a file another write needs.
	return table.observe((changedIds) => {
		void (async () => {
			for (const id of changedIds) {
				const { data: row, error } = table.get(id);

				// Invalid or missing → unlink any previously-written file.
				if (error || row === null) {
					const previous = fileState.get(id);
					if (previous) {
						const removed = await tryUnlink(directory, previous.filename);
						fileState.delete(id);
						if (removed) markDirty(join(directory, previous.filename));
					}
					continue;
				}

				await writeRow(id, row);
			}
		})().catch((cause) => {
			// Reached only by a genuine failure `writeRow` does not swallow: a
			// filesystem write error, or an unexpected throw in the loop scaffolding.
			log.warn(
				MaterializerWriteError.TableWriteFailed({ tableName: table.name, cause }),
			);
		});
	});
}

/**
 * Destructive re-export of one table to `directory`: render every valid row
 * BEFORE touching disk (a throwing render aborts the rebuild with the existing
 * files intact, rather than deleting everything and then failing to rewrite),
 * then sweep existing `.md` files and write the rendered set. Updates `fileState`
 * so the live observer and dirty detection stay consistent.
 */
export async function rebuildTable(opts: {
	table: AnyTable;
	directory: string;
	render: RenderRow;
	fileState: FileState;
	markDirty: (path: string) => void;
}): Promise<{ deleted: number; written: number }> {
	const { table, directory, render, fileState, markDirty } = opts;
	let deleted = 0;
	let written = 0;

	const rendered: { id: string; filename: string; content: string }[] = [];
	for (const row of table.getAllValid()) {
		const r = await render(row);
		rendered.push({ id: row.id, filename: r.filename, content: r.content });
	}

	try {
		const files = await readdir(directory, { recursive: true });
		for (const filename of files) {
			if (!filename.endsWith('.md')) continue;
			const path = join(directory, filename);
			await unlink(path).then(
				() => {
					deleted++;
					markDirty(path);
				},
				() => undefined,
			);
		}
	} catch {
		// Directory doesn't exist yet. Fine.
	}

	fileState.clear();
	await mkdir(directory, { recursive: true });
	for (const { id, filename, content } of rendered) {
		await writeMarkdownFile(directory, filename, content);
		fileState.set(id, { filename, content });
		markDirty(join(directory, filename));
		written++;
	}

	return { deleted, written };
}

// ════════════════════════════════════════════════════════════════════════════
// Git autosave (optional; debounced commit of materialized files)
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

export function createGitAutosave({
	dir,
	config,
	log,
}: {
	dir: () => Promise<string>;
	config: GitAutosaveConfig;
	log: Logger;
}) {
	const {
		author: { name = 'Autosave', email = 'autosave@epicenter.local' } = {},
		quietMs = 5_000,
		maxBatchMs = 60_000,
	} = config;

	const dirty = new Set<string>();
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
			const baseDir = await dir();
			const result = await $`git rev-parse --is-inside-work-tree`
				.cwd(baseDir)
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
		const baseDir = await dir();
		const add = await $`git add -- ${batch}`.cwd(baseDir).nothrow().quiet();
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
				.cwd(baseDir)
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

	return {
		async initialize(): Promise<void> {
			await ensureEnabled();
		},
		enqueue(path: string): void {
			if (isDisposed) return;
			void ensureEnabled().then(
				(enabled) => {
					if (!enabled || isDisposed) return;
					dirty.add(path);
					schedule();
				},
				(cause) => log.warn(GitAutosaveError.EnablementCheckFailed({ cause })),
			);
		},
		dispose(): void {
			isDisposed = true;
			clearTimers();
			dirty.clear();
		},
	};
}
