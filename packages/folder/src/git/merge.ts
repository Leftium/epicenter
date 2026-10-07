/**
 * A two-parent merge of the folder's head and a fetched commit, prepared as
 * objects only. Nothing here writes files, the index, or a ref: the merge
 * runs with `noUpdateBranch` and `abortOnConflict`, and its own commit is
 * discarded.
 *
 * Root `kv.json` merges by key (`mergeKv`) when both sides changed it. The
 * merged text replaces `kv.json` in one child commit of each side, so
 * isomorphic-git's merge sees the same bytes on both sides and keeps them;
 * every other entry of those trees, modes included, is the side's own.
 * isomorphic-git merges the rest by Git's ordinary rules, and the folder's
 * commit takes that tree with the two original parents. The child commits
 * stay unreachable. A nested `kv.json` is an ordinary file.
 *
 * isomorphic-git 1.38.5 decodes both sides of a two-sided text merge as UTF-8
 * with replacement, and its line split drops a lone carriage return, U+2028,
 * and U+2029. Such a merge is a `binary` conflict before it runs, so a merged
 * file never loses bytes either side wrote. Unchanged, identical, and
 * one-sided changes keep their exact blobs. Its merge also ignores Git's
 * `merge` attribute, so a path that attribute would merge differently is
 * refused.
 *
 * A merge whose conflicts are left for a person (`leave`) classifies them
 * the same way, then gives each conflicted path, in both children, the bytes
 * a person resolves: the changed side's file against a deletion, ordinary
 * conflict markers when every version is text the line merge keeps, and
 * otherwise our bytes, as Git leaves a binary conflict. A conflicted root
 * `kv.json` gets the same treatment: its markers are ordinary text, not
 * JSON. The merge of those children is clean, and its tree goes into a
 * commit whose parents are the head and the fetched commit. That commit is
 * never a branch head or a merge parent: it names the files and index
 * entries an unfinished merge publishes. Each conflicted path keeps the
 * base, ours, and theirs blobs that become its index stages. A file against
 * a directory cannot be left this way and is refused like any conflict, as
 * is a conflicted path that is not a plain file in one of its versions.
 */
import * as git from 'isomorphic-git';
import { mergeKv } from '../kv-merge.js';
import { ancestors } from '../paths.js';
import { byCodePoint, isAttributesPath, mergeAttribute } from './attributes.js';
import type { UnmergedPath } from './backend.js';
import type { MergeConflict } from './errors.js';
import { conflictMarkers, type MarkerLabels } from './merge-markers.js';
import {
	type Author,
	commitTree,
	type ObjectAccess,
	readBlob,
	readTreeFiles,
	type TreeFile,
	writeCommitObject,
	writeTreeFiles,
} from './objects.js';

/** The one file merged by key rather than by line. */
export const ROOT_KV = 'kv.json';

const PLAIN = '100644';

export type PreparedMerge =
	| {
			readonly kind: 'merged';
			/** The merge commit; its parents are the head and the fetched commit. */
			readonly commit: string;
			readonly files: ReadonlyMap<string, TreeFile>;
	  }
	| {
			readonly kind: 'conflicted';
			readonly conflicts: readonly MergeConflict[];
	  }
	/** Conflicts left in place: the commit of the files a person resolves. */
	| {
			readonly kind: 'unfinished';
			/** Never a branch head; its parents are the head and the fetched commit. */
			readonly commit: string;
			readonly files: ReadonlyMap<string, TreeFile>;
			readonly conflicts: readonly MergeConflict[];
			readonly unmerged: readonly UnmergedPath[];
	  }
	| {
			readonly kind: 'unmergeable';
			readonly paths: readonly string[];
			readonly reason: string;
	  };

/** The best common ancestors of two commits, as isomorphic-git's merge finds them. */
export function mergeBases(
	access: ObjectAccess,
	head: string,
	fetched: string,
): Promise<string[]> {
	return git.findMergeBase({ ...access, oids: [head, fetched] });
}

const same = (left: TreeFile | undefined, right: TreeFile | undefined) =>
	left === undefined || right === undefined
		? left === right
		: left.oid === right.oid && left.mode === right.mode;

const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
/** isomorphic-git's own line split for a text merge. */
const LINES = /^.*(\r?\n|$)/gm;

function strictText(bytes: Uint8Array): string | undefined {
	try {
		return strict.decode(bytes);
	} catch {
		return undefined;
	}
}

/** Whether isomorphic-git's line merge reads these bytes back exactly. */
function mergesAsText(bytes: Uint8Array): boolean {
	if (bytes.includes(0)) return false;
	const text = strictText(bytes);
	return text !== undefined && (text.match(LINES) ?? []).join('') === text;
}

/**
 * A child of `commit` whose file at each path of `overrides` is that blob,
 * or absent for `null`. Every other entry, modes included, is the commit's.
 */
async function withOverrides(
	access: ObjectAccess,
	commit: string,
	overrides: ReadonlyMap<string, string | null>,
	author: Author,
): Promise<string> {
	const files = await readTreeFiles(access, await commitTree(access, commit));
	for (const [path, blob] of overrides)
		if (blob === null) files.delete(path);
		else files.set(path, { mode: PLAIN, oid: blob });
	return writeCommitObject(access, {
		tree: await writeTreeFiles(access, files),
		parents: [commit],
		message: 'Merge with prepared paths',
		author,
	});
}

/**
 * The bytes a person resolves at a conflicted path: the changed side's file
 * against a deletion, conflict markers when every version is text the line
 * merge keeps, and otherwise our bytes.
 */
async function unresolvedBytes(
	access: ObjectAccess,
	[base, ours, theirs]: readonly (TreeFile | undefined)[],
	labels: MarkerLabels,
): Promise<Uint8Array> {
	const bytes = (entry: TreeFile) => readBlob(access, entry.oid);
	if (ours === undefined) return bytes(theirs!);
	if (theirs === undefined) return bytes(ours);
	const texts: (string | undefined)[] = [];
	for (const entry of [base, ours, theirs]) {
		if (entry === undefined) {
			texts.push('');
			continue;
		}
		const read = await bytes(entry);
		texts.push(mergesAsText(read) ? strictText(read) : undefined);
	}
	const [b, o, t] = texts;
	if (b === undefined || o === undefined || t === undefined) return bytes(ours);
	return encoder.encode(
		await conflictMarkers({ base: b, ours: o, theirs: t }, labels),
	);
}

/**
 * Merge `head` and `fetched` over their single merge base `base`, or over an
 * empty tree when `base` is undefined: histories that share no commit, which
 * a caller merges only when asked to allow unrelated histories. Objects
 * written on the way stay unreachable unless the caller publishes the merged
 * commit, which no ref names yet.
 */
export async function prepareMerge(
	access: ObjectAccess,
	{
		base,
		head,
		fetched,
		author,
		message,
		leave,
	}: {
		/** Undefined: no common commit, so every file of either side is an addition. */
		base: string | undefined;
		head: string;
		fetched: string;
		author: Author;
		message: string;
		/** Leave conflicts for a person, marked with these labels, instead of refusing. */
		leave?: MarkerLabels;
	},
): Promise<PreparedMerge> {
	const [b, o, t] = (await Promise.all(
		[base, head, fetched].map(async (commit) =>
			commit === undefined
				? new Map<string, TreeFile>()
				: readTreeFiles(access, await commitTree(access, commit)),
		),
	)) as [Map<string, TreeFile>, Map<string, TreeFile>, Map<string, TreeFile>];
	const bytes = (entry: TreeFile) => readBlob(access, entry.oid);
	const conflicts: MergeConflict[] = [];

	// Root kv.json, when both sides changed it differently. `kv` is what both
	// sides' children hold: the merged bytes, `null` for no file, or
	// `undefined` to leave each side's own file to the ordinary merge.
	let kv: Uint8Array | null | undefined;
	const [kb, ko, kt] = [b, o, t].map((files) => files.get(ROOT_KV));
	if (!same(ko, kt) && !same(ko, kb) && !same(kt, kb)) {
		const plain =
			[kb, ko, kt].every(
				(entry) => entry === undefined || entry.mode === PLAIN,
			) &&
			[b, o, t].every((files) =>
				[...files.keys()].every((path) => !path.startsWith(`${ROOT_KV}/`)),
			);
		if (!plain)
			return {
				kind: 'unmergeable',
				paths: [ROOT_KV],
				reason: 'kv.json is not a plain file on every side',
			};
		const sources = { base: kb, ours: ko, theirs: kt };
		const texts: Record<keyof typeof sources, string | null> = {
			base: null,
			ours: null,
			theirs: null,
		};
		let invalid: keyof typeof sources | undefined;
		for (const side of ['base', 'ours', 'theirs'] as const) {
			const entry = sources[side];
			if (entry === undefined) continue;
			const text = strictText(await bytes(entry));
			if (text === undefined) {
				invalid ??= side;
				continue;
			}
			texts[side] = text;
		}
		const merged =
			invalid === undefined
				? mergeKv(texts)
				: ({ kind: 'invalid', side: invalid } as const);
		switch (merged.kind) {
			case 'merged':
				kv = merged.text === null ? null : encoder.encode(merged.text);
				break;
			case 'conflict':
				for (const conflict of merged.conflicts)
					conflicts.push({ reason: 'kvKey', path: ROOT_KV, ...conflict });
				break;
			case 'file-conflict':
				conflicts.push({ reason: 'kvFile', path: ROOT_KV });
				break;
			case 'invalid':
				conflicts.push({
					reason: 'kvInvalid',
					path: ROOT_KV,
					side: merged.side,
				});
				break;
		}
		// A conflicted kv.json gives both sides our file, so the rest still
		// merges and reports its own conflicts. Nothing is published.
		if (kv === undefined) kv = ko === undefined ? null : await bytes(ko);
	}

	// Every other path by Git's rules. `present` is where a file will be, so a
	// file on one side under a directory on the other is found before the
	// merge, which isomorphic-git does not support.
	const present = new Set<string>();
	const textMerges: string[] = [];
	for (const path of new Set([...b.keys(), ...o.keys(), ...t.keys()])) {
		if (path === ROOT_KV && kv !== undefined) {
			if (kv !== null) present.add(path);
			continue;
		}
		const [eb, eo, et] = [b.get(path), o.get(path), t.get(path)];
		if (same(eo, et) || same(eo, eb)) {
			if (et !== undefined) present.add(path);
			continue;
		}
		if (same(et, eb)) {
			if (eo !== undefined) present.add(path);
			continue;
		}
		present.add(path);
		if (eo === undefined || et === undefined) {
			conflicts.push({
				reason: 'deleted',
				path,
				deletedBy: eo === undefined ? 'ours' : 'theirs',
			});
			continue;
		}
		textMerges.push(path);
	}

	const special = textMerges.filter((path) =>
		[b.get(path), o.get(path), t.get(path)].some(
			(entry) => entry !== undefined && entry.mode !== PLAIN,
		),
	);
	if (special.length > 0)
		return {
			kind: 'unmergeable',
			paths: special,
			reason:
				'both sides changed a file that is a symbolic link, executable, or submodule in one of its versions',
		};
	const asText: string[] = [];
	for (const path of textMerges) {
		let text = true;
		for (const entry of [b.get(path), o.get(path), t.get(path)])
			if (entry !== undefined && !mergesAsText(await bytes(entry))) {
				text = false;
				break;
			}
		if (text) asText.push(path);
		else conflicts.push({ reason: 'binary', path });
	}
	if (asText.length > 0)
		for (const files of [b, o, t]) {
			const attributeFiles = new Map<string, Uint8Array>();
			for (const [path, entry] of files)
				if (isAttributesPath(path))
					attributeFiles.set(path, await bytes(entry));
			const declared = mergeAttribute(attributeFiles, asText);
			if (declared !== undefined)
				return {
					kind: 'unmergeable',
					paths: [declared.path],
					reason: `the Git attribute ${declared.attribute} applies to ${declared.path}, and this folder merges text only by Git's default rule`,
				};
		}

	const shapes = new Set<string>();
	for (const path of present)
		for (const parent of ancestors(path))
			if (present.has(parent)) shapes.add(parent);
	for (const path of shapes) conflicts.push({ reason: 'shape', path });

	const signature = { name: author.name, email: author.email };
	/** isomorphic-git's merge of the two sides, each with `overrides` applied. */
	async function mergeWith(overrides: ReadonlyMap<string, string | null>) {
		let [ours, theirs] = [head, fetched];
		if (overrides.size > 0)
			[ours, theirs] = (await Promise.all(
				[head, fetched].map((side) =>
					withOverrides(access, side, overrides, author),
				),
			)) as [string, string];
		return (
			await git.merge({
				...access,
				ours,
				theirs,
				fastForward: false,
				noUpdateBranch: true,
				abortOnConflict: true,
				// Its own base is then the empty tree, the same as `b` here.
				allowUnrelatedHistories: base === undefined,
				message,
				author: signature,
				committer: signature,
			})
		).tree;
	}
	const unsupported = {
		kind: 'unmergeable',
		paths: [],
		reason:
			'isomorphic-git does not merge this combination of files and directories',
	} as const;

	let tree: string | undefined;
	const overrides = new Map<string, string | null>();
	if (shapes.size === 0) {
		if (kv !== undefined)
			overrides.set(
				ROOT_KV,
				kv === null ? null : await git.writeBlob({ ...access, blob: kv }),
			);
		try {
			tree = await mergeWith(overrides);
		} catch (cause) {
			if (cause instanceof git.Errors.MergeNotSupportedError)
				return unsupported;
			if (!(cause instanceof git.Errors.MergeConflictError)) throw cause;
			const reported = new Set(conflicts.map((conflict) => conflict.path));
			for (const path of cause.data.bothModified)
				if (!reported.has(path)) conflicts.push({ reason: 'content', path });
		}
	}
	conflicts.sort((left, right) => byCodePoint(left.path, right.path));

	if (conflicts.length > 0 && leave !== undefined && shapes.size === 0) {
		const paths = [...new Set(conflicts.map((conflict) => conflict.path))];
		const unplain = paths.filter((path) =>
			[b.get(path), o.get(path), t.get(path)].some(
				(entry) => entry !== undefined && entry.mode !== PLAIN,
			),
		);
		if (unplain.length > 0)
			return {
				kind: 'unmergeable',
				paths: unplain,
				reason:
					'a conflicted path is a symbolic link, executable, or submodule in one of its versions, so it cannot be left as a plain file',
			};
		const unmerged: UnmergedPath[] = [];
		for (const path of paths) {
			const sides = [b.get(path), o.get(path), t.get(path)];
			overrides.set(
				path,
				await git.writeBlob({
					...access,
					blob: await unresolvedBytes(access, sides, leave),
				}),
			);
			const [eb, eo, et] = sides;
			unmerged.push({ path, base: eb?.oid, ours: eo?.oid, theirs: et?.oid });
		}
		let left: string | undefined;
		try {
			left = await mergeWith(overrides);
		} catch (cause) {
			if (cause instanceof git.Errors.MergeNotSupportedError)
				return unsupported;
			throw cause;
		}
		if (left === undefined) throw new Error('The merge produced no tree');
		const files = await readTreeFiles(access, left);
		for (const [path, blob] of overrides)
			if ((files.get(path)?.oid ?? null) !== blob)
				throw new Error(`The merged tree does not hold the prepared ${path}`);
		const commit = await writeCommitObject(access, {
			tree: left,
			parents: [head, fetched],
			message,
			author,
		});
		return { kind: 'unfinished', commit, files, conflicts, unmerged };
	}
	if (conflicts.length > 0) return { kind: 'conflicted', conflicts };
	if (tree === undefined) throw new Error('The merge produced no tree');

	const files = await readTreeFiles(access, tree);
	const kvBlob = overrides.get(ROOT_KV);
	if (kvBlob !== undefined && (files.get(ROOT_KV)?.oid ?? null) !== kvBlob)
		throw new Error('The merged tree does not hold the merged kv.json');
	const commit = await writeCommitObject(access, {
		tree,
		parents: [head, fetched],
		message,
		author,
	});
	return { kind: 'merged', commit, files };
}
