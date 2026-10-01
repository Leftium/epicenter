/**
 * Notices changes under the notes directory, whoever made them.
 *
 * The answer comes from comparing two listings (path, size, and modification
 * time), on a timer. `fs.watch` only brings the next comparison forward; it
 * is not trusted to report every change. Private Git state is not watched.
 */
import { watch as watchDirectory } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

async function signature(root: string): Promise<string> {
	const lines: string[] = [];
	async function walk(directory: string, prefix: string) {
		let entries: import('node:fs').Dirent[];
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (prefix === '' && entry.name === '.git') continue;
			const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
			const full = join(directory, entry.name);
			if (entry.isDirectory()) {
				lines.push(`${path}/`);
				await walk(full, path);
				continue;
			}
			const stats = await stat(full).catch(() => undefined);
			if (stats) lines.push(`${path}\0${stats.size}\0${stats.mtimeMs}`);
		}
	}
	await walk(root, '');
	return lines.sort().join('\n');
}

export async function createWatcher(
	root: string,
	onChange: () => void,
	{ intervalMs = 1000 }: { intervalMs?: number } = {},
) {
	let last = await signature(root);
	let scanning: Promise<boolean> | undefined;
	let soon: ReturnType<typeof setTimeout> | undefined;
	let closed = false;

	/** Compare now. Resolves whether something changed since the last comparison. */
	function scan(): Promise<boolean> {
		scanning ??= (async () => {
			try {
				const next = await signature(root);
				if (closed || next === last) return false;
				last = next;
				onChange();
				return true;
			} finally {
				scanning = undefined;
			}
		})();
		return scanning;
	}

	const timer = setInterval(() => void scan(), intervalMs);
	let native: ReturnType<typeof watchDirectory> | undefined;
	try {
		native = watchDirectory(root, { recursive: true }, (_event, filename) => {
			if (typeof filename === 'string' && filename.split(/[\\/]/)[0] === '.git')
				return;
			clearTimeout(soon);
			soon = setTimeout(() => void scan(), 60);
		});
		native.on('error', () => {});
	} catch {
		// The timer alone still finds every change.
	}

	return {
		scan,
		close() {
			closed = true;
			clearInterval(timer);
			clearTimeout(soon);
			native?.close();
		},
	};
}
