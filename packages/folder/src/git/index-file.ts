/**
 * Git's version 2 index file, read and written whole.
 *
 * isomorphic-git keeps unmerged stages when it reads an index, but its public
 * API cannot write one, and its status walk sees only one stage of an
 * unmerged path. A merge left for a person needs the stages themselves, so
 * the browser reads and writes them here. Only version 2, the version
 * isomorphic-git writes, is understood; other bytes read as `undefined`.
 */

export type IndexEntry = {
	/** The ten cached stat words, in file order: ctime, mtime, dev, ino, mode, uid, gid, size. */
	readonly stats: readonly number[];
	readonly mode: number;
	readonly oid: string;
	/** 0 for a merged entry; 1, 2, 3 for an unmerged path's base, ours, and theirs. */
	readonly stage: 0 | 1 | 2 | 3;
	readonly path: string;
};

const decoder = new TextDecoder();
const encoder = new TextEncoder();
/** Byte offset of the mode word in an entry; the stats before and after it are kept. */
const MODE_WORD = 6;

/** Every entry, in file order, or `undefined` for anything but a version 2 index. */
export function parseIndex(bytes: Uint8Array): IndexEntry[] | undefined {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes.byteLength < 12 || decoder.decode(bytes.subarray(0, 4)) !== 'DIRC')
		return undefined;
	if (view.getUint32(4) !== 2) return undefined;
	const entries: IndexEntry[] = [];
	let offset = 12;
	for (let count = view.getUint32(8); count > 0; count--) {
		if (offset + 62 > bytes.byteLength) return undefined;
		const stats: number[] = [];
		for (let word = 0; word < 10; word++)
			stats.push(view.getUint32(offset + word * 4));
		const oid = [...bytes.subarray(offset + 40, offset + 60)]
			.map((byte) => byte.toString(16).padStart(2, '0'))
			.join('');
		const flags = view.getUint16(offset + 60);
		const start = offset + 62;
		const end = bytes.indexOf(0, start);
		if (end < 0) return undefined;
		entries.push({
			stats,
			mode: stats[MODE_WORD]!,
			oid,
			stage: ((flags >> 12) & 0b11) as IndexEntry['stage'],
			path: decoder.decode(bytes.subarray(start, end)),
		});
		// An entry is padded with NULs to a multiple of eight bytes.
		offset += Math.ceil((end - offset + 1) / 8) * 8;
	}
	return entries;
}

/** Git's index order: path bytes, then stage. */
function compareEntries(left: IndexEntry, right: IndexEntry): number {
	const [a, b] = [encoder.encode(left.path), encoder.encode(right.path)];
	for (let index = 0; index < Math.min(a.length, b.length); index++)
		if (a[index] !== b[index]) return a[index]! - b[index]!;
	return a.length - b.length || left.stage - right.stage;
}

/** A version 2 index holding exactly `entries`, sorted as Git requires. */
export async function renderIndex(
	entries: readonly IndexEntry[],
): Promise<Uint8Array> {
	const sorted = [...entries].sort(compareEntries);
	const parts: Uint8Array[] = [];
	const header = new Uint8Array(12);
	header.set(encoder.encode('DIRC'));
	new DataView(header.buffer).setUint32(4, 2);
	new DataView(header.buffer).setUint32(8, sorted.length);
	parts.push(header);
	for (const entry of sorted) {
		const path = encoder.encode(entry.path);
		const bytes = new Uint8Array(Math.ceil((62 + path.length + 1) / 8) * 8);
		const view = new DataView(bytes.buffer);
		for (let word = 0; word < 10; word++)
			view.setUint32(
				word * 4,
				word === MODE_WORD ? entry.mode : (entry.stats[word] ?? 0),
			);
		for (let byte = 0; byte < 20; byte++)
			bytes[40 + byte] = Number.parseInt(
				entry.oid.slice(byte * 2, byte * 2 + 2),
				16,
			);
		view.setUint16(60, (entry.stage << 12) | Math.min(path.length, 0xfff));
		bytes.set(path, 62);
		parts.push(bytes);
	}
	const body = new Uint8Array(
		parts.reduce((sum, part) => sum + part.length, 0),
	);
	let at = 0;
	for (const part of parts) {
		body.set(part, at);
		at += part.length;
	}
	const checksum = new Uint8Array(
		await crypto.subtle.digest('SHA-1', body as Uint8Array<ArrayBuffer>),
	);
	const bytes = new Uint8Array(body.length + checksum.length);
	bytes.set(body);
	bytes.set(checksum, body.length);
	return bytes;
}

/** An entry with no cached stats, so the next status look reads the file. */
export function plainEntry(
	path: string,
	oid: string,
	stage: IndexEntry['stage'],
): IndexEntry {
	return { stats: [], mode: 0o100644, oid, stage, path };
}

/** What an entry says apart from cached stats: mode, object, stage, and path. */
export const entryKey = (entry: IndexEntry) =>
	`${entry.mode.toString(8)} ${entry.oid} ${entry.stage} ${entry.path}`;

/**
 * Why a whole-folder commit refuses unmerged index stages, which only
 * another Git program leaves here. Such a commit would reset the stages to
 * the head and record whatever the files hold, conflict markers included,
 * as one-parent content. The stages stay for whoever repairs it with Git.
 */
export function orphanStagesProblem(
	paths: readonly string[],
): string | undefined {
	if (paths.length === 0) return undefined;
	return `${paths.join(', ')} ${paths.length === 1 ? 'has' : 'have'} unmerged index stages from a merge begun outside this folder; finish or abandon that merge with Git, then Sync`;
}
