/**
 * Notices changes under the Capture directory and to its Git state, whoever
 * made them, and says so with a hint to reread. A hint carries no bytes.
 *
 * Two sources feed one coalesced check:
 *
 * - A native `fs.watch` event. Any event outside private Git noise is a hint,
 *   whatever the metadata says: a write that keeps a file's size and restores
 *   its modification time is still a change someone made.
 * - A timer that compares two signatures: every file's path, size, and
 *   modification time, plus the Git metadata an outside `git add`,
 *   `git commit`, or `git checkout` moves (`HEAD`, the index, refs). It
 *   recovers ordinary changes whose native event never arrived.
 *
 * What neither source finds: a change whose native event was missed and that
 * left path, size, and modification time as they were. Contents are not
 * hashed on a timer. The page also rereads on focus and after its own work.
 *
 * Private Git noise never hints: object and scratch writes, logs, and the
 * temporary `*.lock` files Git creates and removes around an update. The
 * update itself (`index`, `HEAD`, a ref) does. The folder's own Git commands
 * run with optional locks off, so observing status writes nothing here.
 */
import { type Dirent, watch as watchDirectory } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Git state whose change means history, staging, or the branch moved. */
const GIT_FILES = ['HEAD', 'index', 'packed-refs', 'MERGE_HEAD', 'FETCH_HEAD'];
/** Private Git directories that churn without changing what a person sees. */
const GIT_NOISE = new Set(['objects', 'epicenter', 'logs', 'hooks', 'info']);

/** Whether a native event is private Git churn rather than a change to report. */
function isNoise(filename: string): boolean {
	const parts = filename.split(/[\\/]/);
	if (parts[0] !== '.git') return false;
	// `.git` itself, as some platforms report a change inside it by its parent.
	if (parts.length === 1) return true;
	return GIT_NOISE.has(parts[1] ?? '') || filename.endsWith('.lock');
}

async function entries(directory: string): Promise<Dirent[]> {
	try {
		return await readdir(directory, { withFileTypes: true });
	} catch {
		return [];
	}
}

async function line(path: string, full: string): Promise<string | undefined> {
	const stats = await stat(full).catch(() => undefined);
	return stats?.isFile()
		? `${path}\0${stats.size}\0${stats.mtimeMs}`
		: undefined;
}

async function signature(root: string): Promise<string> {
	const lines: string[] = [];
	async function walk(directory: string, prefix: string) {
		for (const entry of await entries(directory)) {
			if (prefix === '' && entry.name === '.git') continue;
			const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
			const full = join(directory, entry.name);
			if (entry.isDirectory()) {
				lines.push(`${path}/`);
				await walk(full, path);
				continue;
			}
			const found = await line(path, full);
			if (found !== undefined) lines.push(found);
		}
	}
	async function refs(directory: string, prefix: string) {
		for (const entry of await entries(directory)) {
			if (entry.name.endsWith('.lock')) continue;
			const path = `${prefix}/${entry.name}`;
			const full = join(directory, entry.name);
			if (entry.isDirectory()) await refs(full, path);
			else {
				const found = await line(path, full);
				if (found !== undefined) lines.push(found);
			}
		}
	}
	await walk(root, '');
	const git = join(root, '.git');
	for (const name of GIT_FILES) {
		const found = await line(`.git/${name}`, join(git, name));
		if (found !== undefined) lines.push(found);
	}
	await refs(join(git, 'refs'), '.git/refs');
	return lines.sort().join('\n');
}

export type Watcher = Awaited<ReturnType<typeof createWatcher>>;

export async function createWatcher(
	root: string,
	onChange: () => void,
	{ intervalMs = 1500 }: { intervalMs?: number } = {},
) {
	let last = await signature(root);
	let checking: Promise<boolean> | undefined;
	let soon: ReturnType<typeof setTimeout> | undefined;
	/** A native event arrived since the last check began. */
	let hinted = false;
	let closed = false;

	/**
	 * One check for both sources. It hints when a native event was waiting or
	 * the signature moved, and records the signature either way, so a change
	 * the native event already reported is not reported again by the timer.
	 * Resolves whether it hinted.
	 */
	function check(): Promise<boolean> {
		if (closed) return Promise.resolve(false);
		checking ??= (async () => {
			try {
				const native = hinted;
				hinted = false;
				// `signature` reports an unreadable directory as empty; it never rejects.
				const next = await signature(root);
				if (closed || (!native && next === last)) return false;
				last = next;
				try {
					onChange();
				} catch {
					// A listener's failure is its own; the next check still runs.
				}
				return true;
			} finally {
				checking = undefined;
				// An event that arrived mid-check gets its own check.
				if (hinted && !closed) schedule();
			}
		})();
		return checking;
	}

	/** Coalesce a burst of native events into one check. */
	function schedule() {
		clearTimeout(soon);
		soon = setTimeout(() => {
			soon = undefined;
			void check();
		}, 60);
	}

	const timer = setInterval(() => {
		// A native check is already on its way; it compares the same signature.
		if (soon === undefined) void check();
	}, intervalMs);
	let native: ReturnType<typeof watchDirectory> | undefined;
	try {
		native = watchDirectory(root, { recursive: true }, (_event, filename) => {
			if (typeof filename === 'string' && isNoise(filename)) return;
			hinted = true;
			schedule();
		});
		native.on('error', () => {});
	} catch {
		// Without native events the timer still finds changes that move metadata.
	}

	return {
		/** Compare now, after any earlier check, instead of at the next timer tick. */
		async scan() {
			await checking;
			return check();
		},
		/** Stop the timers and the watch, then wait for a check already running. */
		async close() {
			closed = true;
			clearInterval(timer);
			clearTimeout(soon);
			native?.close();
			await checking;
		},
	};
}
