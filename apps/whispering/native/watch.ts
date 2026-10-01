/**
 * Notices changes made to the data folder by anything: this app, the embedded
 * terminal, an editor, or Git.
 *
 * The page is told when the folder's observable state changes: the name, size,
 * and modification time of every file outside `.git`, plus where the branches
 * point (a commit made in the terminal changes what is uncommitted). Git's
 * objects, index, and scratch files are private bookkeeping and are ignored.
 *
 * A recursive filesystem watch asks for a check as soon as something happens,
 * and a slow poll runs the same check regardless, because a platform watch can
 * be unavailable or drop events without reporting an error. Either way one
 * state change is one notification.
 */
import { type FSWatcher, watch } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';

const BATCH_MS = 120;
const POLL_MS = 1000;
const BRANCH_STATE = /^\.git\/(HEAD|ORIG_HEAD|packed-refs|refs\/heads\/.+)$/;

/** Whether a change at this folder-relative path can alter what the page shows. */
export function isObservedChange(path: string): boolean {
	if (path === '.git') return false;
	if (path.startsWith('.git/'))
		return BRANCH_STATE.test(path) && !path.endsWith('.lock');
	return true;
}

/** One line per observed file and branch; equal text means nothing changed. */
export async function folderSignature(root: string): Promise<string> {
	const lines: string[] = [];
	async function walk(directory: string, prefix: string) {
		let entries: import('node:fs').Dirent[];
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
			if (path === '.git') continue;
			const full = join(directory, entry.name);
			if (entry.isDirectory()) {
				lines.push(`${path}/`);
				await walk(full, path);
				continue;
			}
			try {
				const stats = await stat(full);
				lines.push(`${path}\t${stats.size}\t${stats.mtimeMs}`);
			} catch {
				// Removed while listing; the next check sees the settled state.
			}
		}
	}
	async function branches(directory: string, prefix: string) {
		let entries: import('node:fs').Dirent[];
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = `${prefix}/${entry.name}`;
			if (entry.isDirectory())
				await branches(join(directory, entry.name), path);
			else if (isObservedChange(path))
				lines.push(
					`${path}\t${await readFile(join(directory, entry.name), 'utf8').catch(() => '')}`,
				);
		}
	}
	await walk(root, '');
	const git = join(root, '.git');
	for (const name of ['HEAD', 'packed-refs'])
		lines.push(
			`.git/${name}\t${await readFile(join(git, name), 'utf8').catch(() => '')}`,
		);
	await branches(join(git, 'refs', 'heads'), '.git/refs/heads');
	return lines.sort().join('\n');
}

export function watchFolder(
	root: string,
	onChange: () => void,
	onError: (cause: unknown) => void,
): () => void {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let last: string | undefined;
	let checking: Promise<void> | undefined;

	function check(): Promise<void> {
		checking ??= (async () => {
			try {
				const next = await folderSignature(root);
				const changed = last !== undefined && next !== last;
				last = next;
				if (changed && !stopped) onChange();
			} finally {
				checking = undefined;
			}
		})();
		return checking;
	}
	void check();

	let watcher: FSWatcher | undefined;
	try {
		watcher = watch(root, { recursive: true }, (_event, filename) => {
			// A missing name means the platform could not say what changed.
			const path = filename === null ? '' : filename.split(sep).join('/');
			if (path !== '' && !isObservedChange(path)) return;
			clearTimeout(timer);
			timer = setTimeout(() => void check(), BATCH_MS);
		});
		watcher.on('error', onError);
	} catch (cause) {
		// The poll below still observes the folder.
		onError(cause);
	}
	const poll = setInterval(() => void check(), POLL_MS);

	return () => {
		stopped = true;
		clearTimeout(timer);
		clearInterval(poll);
		watcher?.close();
	};
}
