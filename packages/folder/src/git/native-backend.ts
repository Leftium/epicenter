/**
 * Native Git storage: a real repository in `<root>/.git`.
 *
 * isomorphic-git writes immutable objects for checkpoints (atomically, via a
 * scratch file and rename). Everything that mutates shared state uses the
 * real `git` CLI, whose `index.lock` and ref locks other Git processes
 * respect: `update-ref` with an expected old value is the branch
 * compare-and-swap, `reset` and `update-index` update index entries, and
 * staging and staged commits run `git add` and `git commit`, except a
 * commit that finishes a merge (below). isomorphic-git never writes the
 * native index.
 *
 * A merge left unfinished is Git's own: `ORIG_HEAD`, `MERGE_MSG`, and
 * `MERGE_HEAD` beside the unmoved branch, files with markers, and an index
 * holding the incoming entries and each conflicted path's stages, written by
 * `update-index --index-info`, so `git status`, `git add`, and `git commit`
 * in a terminal see the same merge.
 *
 * Everything that makes the merge commit correct lands before any authored
 * file: `ORIG_HEAD` (the local head) and `MERGE_MSG` (the message, with a
 * `# Incoming commit: <oid>` line naming the fetched commit in full), then
 * the whole index in one `update-index`, then `MERGE_HEAD`, then the files.
 * The index and `MERGE_HEAD` together keep the merge's two parents, the
 * fetched changes it brings, and its unresolved paths, so a staged commit
 * made without staging anything is `Unmerged`, never a commit of the local
 * tree that claims the fetched history.
 *
 * Nothing is rolled back: once the index holds the merge, another program
 * may have staged something in it too, and putting older bytes back would
 * erase that. A failure is reported where it stopped instead:
 * - `ORIG_HEAD`, `MERGE_MSG`, or the index refused: `Refused`, with no file
 *   or index entry changed. An `ORIG_HEAD` or `MERGE_MSG` left behind, with
 *   no `MERGE_HEAD`, is only a head and a message; no merge is in progress.
 * - `MERGE_HEAD` refused: `Partial` with no file step. The index holds the
 *   stages and incoming entries with no `MERGE_HEAD`; whole-folder commits
 *   refuse the stages and `git commit` refuses them as unmerged. Writing the
 *   commit `MERGE_MSG` names to `.git/MERGE_HEAD` makes it the merge again,
 *   whatever the tracking ref names by then.
 * - A file step: `Partial`, with the steps that landed, possibly none. The
 *   merge is in progress; files it did not write differ from their index
 *   entries. A person inspects staged and unstaged differences, resolves,
 *   stages what each path should hold, and commits, or removes `MERGE_HEAD`
 *   and resets the index to abandon the merge while keeping working files.
 * No other record is kept.
 *
 * A staged commit that finishes a merge writes, as objects, the index's tree
 * and a commit whose parents are `ORIG_HEAD` and `MERGE_HEAD`, then moves
 * the branch from `ORIG_HEAD` by compare-and-swap. `git commit` would take
 * whatever `HEAD` names when it runs. Like a whole-folder commit, that
 * commit runs no hooks.
 */
import { spawn } from 'node:child_process';
import * as nodeFs from 'node:fs';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type * as git from 'isomorphic-git';
import type { FileBoundary } from '../boundary.js';
import { describe, FileError } from '../errors.js';
import { byCodePoint, NORMALIZING } from './attributes.js';
import type {
	GitBackend,
	GitRemote,
	IncomingPlan,
	MergeInProgress,
	PathStatus,
	PublishResult,
	StatusCode,
	UnfinishedMerge,
	UnmergedPath,
} from './backend.js';
import { capturedIndexMatchesHead } from './captured-index.js';
import { createMutex } from './mutex.js';
import { nativeCheckpointProblem } from './native-checkpoint.js';
import {
	type CommitSummary,
	commitTree,
	type ObjectAccess,
	readTreeFiles,
	type TreeFile,
	writeCommitObject,
	writeTreeFiles,
} from './objects.js';

const ZERO = '0000000000000000000000000000000000000000';
const REMOTE_NAME = 'origin';

export class GitCommandError extends Error {
	constructor(
		readonly args: readonly string[],
		readonly code: number | null,
		readonly stderr: string,
	) {
		super(
			stderr.trim() === ''
				? `git ${args[0]} exited with ${code}`
				: `git ${args[0]}: ${stderr.trim()}`,
		);
		this.name = 'GitCommandError';
	}
}

export type GitRun = (
	args: readonly string[],
	options?: {
		input?: Uint8Array | string;
		signal?: AbortSignal;
		allowFailure?: boolean;
	},
) => Promise<{ code: number | null; stdout: Uint8Array; stderr: string }>;

/**
 * Inherited variables that would point Git at another repository, index, or
 * object store: the names `git rev-parse --local-env-vars` lists, plus the
 * ref namespace. Each command addresses the repository in its working
 * directory, whatever the parent process had set. The ceiling stops discovery
 * at the root, so a root whose `.git` is missing never resolves to a
 * repository in a directory above it. `GIT_OPTIONAL_LOCKS=0` keeps read-only
 * commands such as `status` and `diff` from taking `index.lock` to refresh
 * the index, so observing the folder never looks like a change to it.
 */
const REPOSITORY_ENV =
	/^GIT_(DIR|WORK_TREE|IMPLICIT_WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|GRAFT_FILE|SHALLOW_FILE|NO_REPLACE_OBJECTS|REPLACE_REF_BASE|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/;

function gitEnvironment(root: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(process.env))
		if (!REPOSITORY_ENV.test(name)) env[name] = value;
	return {
		...env,
		GIT_CEILING_DIRECTORIES: dirname(root),
		GIT_OPTIONAL_LOCKS: '0',
		GIT_TERMINAL_PROMPT: '0',
		LC_ALL: 'C',
	};
}

export function createGitRunner(root: string): GitRun {
	return (args, options = {}) =>
		new Promise((resolve, reject) => {
			const child = spawn('git', [...args], {
				cwd: root,
				env: gitEnvironment(root),
				stdio: ['pipe', 'pipe', 'pipe'],
				signal: options.signal,
			});
			const stdout: Uint8Array[] = [];
			const stderr: Uint8Array[] = [];
			child.stdout.on('data', (chunk: Uint8Array) => stdout.push(chunk));
			child.stderr.on('data', (chunk: Uint8Array) => stderr.push(chunk));
			child.on('error', reject);
			child.on('close', (code) => {
				const out = Buffer.concat(stdout);
				const err = Buffer.concat(stderr).toString('utf8');
				if (code !== 0 && !options.allowFailure)
					reject(new GitCommandError(args, code, err));
				else resolve({ code, stdout: new Uint8Array(out), stderr: err });
			});
			child.stdin.on('error', () => {});
			if (options.input !== undefined) child.stdin.end(options.input);
			else child.stdin.end();
		});
}

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8');

/**
 * The `MERGE_MSG` line naming a merge's incoming commit in full. Git strips
 * `#` lines from a message it edits, as it does its own `# Conflicts:` list.
 */
const INCOMING_LINE = '# Incoming commit: ';

/** A node filesystem whose writes land atomically, for isomorphic-git object writes. */
function atomicObjectFs(): git.PromiseFsClient {
	const promises = {
		...nodeFs.promises,
		async writeFile(
			path: string,
			data: Uint8Array | string,
			options?: unknown,
		) {
			const temporary = `${path}.tmp-${crypto.randomUUID()}`;
			await writeFile(temporary, data, options as never);
			await rename(temporary, path);
		},
	};
	return { promises } as unknown as git.PromiseFsClient;
}

export async function createNativeGitBackend({
	root,
	branch,
	remote,
	boundary,
}: {
	root: string;
	branch: string;
	remote: GitRemote | undefined;
	boundary: FileBoundary;
}): Promise<GitBackend> {
	const run = createGitRunner(root);
	const gitdir = join(root, '.git');
	const access: ObjectAccess = { fs: atomicObjectFs(), gitdir };
	const branchRef = `refs/heads/${branch}`;
	const trackingRef = `refs/remotes/${REMOTE_NAME}/${remote?.branch ?? branch}`;

	const isRepository = await stat(join(gitdir, 'HEAD')).then(
		() => true,
		() => false,
	);
	if (!isRepository)
		await run(['init', '--quiet', `--initial-branch=${branch}`]);

	// This handle's own work only. Another process is met at Git's lock
	// files, where a held lock fails the command instead of delaying it.
	const queue = createMutex();

	async function resolve(ref: string): Promise<string | undefined> {
		const result = await run(
			['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
			{
				allowFailure: true,
			},
		);
		if (result.code !== 0) return undefined;
		return text(result.stdout).trim();
	}

	const literal = ['--literal-pathspecs'];

	/** Reset the named index entries without changing working files. */
	async function syncIndex(commit: string, paths: readonly string[]) {
		if (paths.length === 0) return;
		await run(
			[
				...literal,
				'reset',
				'--quiet',
				commit,
				'--pathspec-from-file=-',
				'--pathspec-file-nul',
			],
			{ input: `${paths.join('\0')}\0` },
		);
	}

	/** A private Git file's bytes, or `undefined` when there is none. */
	async function readPrivate(name: string): Promise<Uint8Array | undefined> {
		try {
			return new Uint8Array(await readFile(join(gitdir, name)));
		} catch (cause) {
			if ((cause as { code?: string }).code === 'ENOENT') return undefined;
			throw cause;
		}
	}

	/** Replace a private Git file whole, through a scratch file and rename. */
	async function writePrivate(name: string, value: string) {
		const temporary = join(gitdir, `${name}.tmp-${crypto.randomUUID()}`);
		try {
			await writeFile(temporary, value);
			await rename(temporary, join(gitdir, name));
		} finally {
			await rm(temporary, { force: true }).catch(() => {});
		}
	}

	/**
	 * Give the changed paths the entries of `commit`'s tree and each unmerged
	 * path its stages, in one `update-index`: Git writes the index once, so
	 * it holds either all of these entries or none of them.
	 */
	async function indexMerge(
		commit: string,
		paths: readonly string[],
		unmerged: readonly UnmergedPath[],
	) {
		const target = await readTreeFiles(
			access,
			await commitTree(access, commit),
		);
		const conflicted = new Set(unmerged.map((path) => path.path));
		const removals: string[] = [];
		const entries: string[] = [];
		for (const path of paths) {
			if (conflicted.has(path)) continue;
			const file = target.get(path);
			// A mode-0 record removes the path's entries.
			if (file === undefined) removals.push(`0 ${ZERO}\t${path}`);
			else entries.push(`${file.mode} ${file.oid} 0\t${path}`);
		}
		for (const { path, base, ours, theirs } of unmerged) {
			// The path's entry goes before its stages go in.
			removals.push(`0 ${ZERO}\t${path}`);
			for (const [stage, oid] of [
				[1, base],
				[2, ours],
				[3, theirs],
			] as const)
				if (oid !== undefined) entries.push(`100644 ${oid} ${stage}\t${path}`);
		}
		const records = [...removals, ...entries];
		if (records.length === 0) return;
		await run(['update-index', '-z', '--index-info'], {
			input: `${records.join('\0')}\0`,
		});
	}

	/**
	 * Publish a merge left unfinished: `ORIG_HEAD` and `MERGE_MSG`, the whole
	 * index, `MERGE_HEAD`, then the files. See the module comment for why
	 * that order, and why nothing is rolled back.
	 */
	async function publishMerge(
		plan: IncomingPlan,
		merge: UnfinishedMerge,
	): Promise<PublishResult> {
		const refused = (path: string, operation: string, cause: unknown) =>
			({
				status: 'refused',
				error: FileError.Io({ path, operation, cause }).error,
			}) as const;
		const actual = await resolve(branchRef);
		if (actual !== plan.expectedHead)
			return { status: 'branchMoved', actual, filesApplied: false };
		const message = merge.message.endsWith('\n')
			? merge.message
			: `${merge.message}\n`;
		try {
			await writePrivate('ORIG_HEAD', `${plan.expectedHead}\n`);
			await writePrivate(
				'MERGE_MSG',
				`${message}\n${INCOMING_LINE}${merge.incoming}\n`,
			);
		} catch (cause) {
			return refused('.git/MERGE_MSG', 'prepare the merge message', cause);
		}
		try {
			await indexMerge(plan.nextHead, plan.paths, merge.unmerged);
		} catch (cause) {
			// `update-index` replaces the index whole or not at all.
			return refused('.git/index', 'write the merge into the index', cause);
		}
		// From here the index holds the merge. It is never put back: another
		// program may have staged something in it since.
		try {
			await writePrivate('MERGE_HEAD', `${merge.incoming}\n`);
		} catch (cause) {
			return {
				status: 'partial',
				applied: [],
				error: FileError.Io({
					path: '.git/MERGE_HEAD',
					operation: `record the merge of ${merge.incoming} in`,
					cause: new Error(
						`${describe(cause)}. The index already holds the merge's stages and incoming entries, and .git/MERGE_MSG names the incoming commit on its "${INCOMING_LINE.trim()}" line; using a system shell, write that commit to .git/MERGE_HEAD before resolving, staging, or committing`,
					),
				}).error,
			};
		}
		const { error: applyError } = await boundary.apply(plan.changes);
		if (applyError !== null)
			// The merge is in progress either way: its index and merge state stay.
			return applyError.name === 'Partial'
				? {
						status: 'partial',
						applied: applyError.applied,
						error: applyError.error,
					}
				: { status: 'partial', applied: [], error: applyError };
		// Another program may have moved the branch meanwhile. `ORIG_HEAD`
		// still names the merge's first parent; a staged commit refuses to
		// finish the merge from anywhere else.
		const after = await resolve(branchRef);
		if (after !== plan.expectedHead)
			return { status: 'branchMoved', actual: after, filesApplied: true };
		return { status: 'published' };
	}

	function parsePorcelain(output: Uint8Array): PathStatus[] {
		const tokens = text(output).split('\0');
		const result: PathStatus[] = [];
		for (let index = 0; index < tokens.length; index++) {
			const token = tokens[index]!;
			if (token.length < 4) continue;
			const indexCode = token[0] as StatusCode;
			const worktreeCode = token[1] as StatusCode;
			const path = token.slice(3);
			if (indexCode === 'R' || indexCode === 'C') index++;
			result.push({ path, index: indexCode, worktree: worktreeCode });
		}
		return result;
	}

	const backend: GitBackend = {
		branch,
		remote,
		async withObjects(work) {
			return work(access);
		},
		exclusive: queue.run,
		readBranch: () => resolve(branchRef),
		readRemoteTracking: () => resolve(trackingRef),
		async casBranch(expected, next) {
			const result = await run(
				[
					'update-ref',
					'-m',
					'epicenter: commit',
					branchRef,
					next,
					expected ?? ZERO,
				],
				{ allowFailure: true },
			);
			if (result.code === 0) return { ok: true };
			const actual = await resolve(branchRef);
			if (actual !== expected) return { ok: false, actual };
			throw new GitCommandError(['update-ref'], result.code, result.stderr);
		},
		async blocked() {
			const head = await run(['symbolic-ref', '--quiet', 'HEAD'], {
				allowFailure: true,
			});
			if (head.code !== 0) return 'HEAD is detached';
			if (text(head.stdout).trim() !== branchRef)
				return `HEAD is not on ${branch}`;
			// A merge in progress is `mergeState`: a staged commit finishes it.
			for (const marker of [
				'CHERRY_PICK_HEAD',
				'REVERT_HEAD',
				'rebase-merge',
				'rebase-apply',
				'BISECT_LOG',
			]) {
				const present = await stat(join(gitdir, marker)).then(
					() => true,
					() => false,
				);
				if (present) return `a Git operation is in progress (${marker})`;
			}
			return undefined;
		},
		async mergeState(): Promise<MergeInProgress | undefined> {
			const stored = await readPrivate('MERGE_HEAD');
			if (stored === undefined) return undefined;
			const incoming = text(stored).trim().split('\n')[0] ?? '';
			if (!/^[0-9a-f]{40}$/.test(incoming))
				throw new Error('.git/MERGE_HEAD does not name a commit');
			const origin = text((await readPrivate('ORIG_HEAD')) ?? new Uint8Array())
				.trim()
				.split('\n')[0];
			const listed = await run(['ls-files', '--unmerged', '-z']);
			const unresolved = new Set<string>();
			for (const record of text(listed.stdout).split('\0'))
				if (record.includes('\t'))
					unresolved.add(record.slice(record.indexOf('\t') + 1));
			return {
				incoming,
				head:
					origin !== undefined && /^[0-9a-f]{40}$/.test(origin)
						? origin
						: undefined,
				unresolved: [...unresolved],
			};
		},
		async clearMerge() {
			for (const name of ['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE'])
				await rm(join(gitdir, name), { force: true });
		},
		async checkpointProblem() {
			return nativeCheckpointProblem({
				root,
				run,
				head: await resolve(branchRef),
				ignored: (paths) => backend.ignoredPaths(paths, new Map()),
			});
		},
		async incomingAttribute(commit, files) {
			if (files.size === 0) return undefined;
			// Git's own attribute matching, against the commit's tree alone. A
			// Git too old for `--source` fails here, before anything is written.
			const result = await run(
				['check-attr', `--source=${commit}`, '--stdin', '-z', ...NORMALIZING],
				{ input: `${[...files.keys()].sort(byCodePoint).join('\0')}\0` },
			);
			const records = text(result.stdout).split('\0');
			for (let index = 0; index + 2 < records.length; index += 3) {
				const [path, attribute, value] = records.slice(index, index + 3);
				if (value !== 'unspecified' && value !== 'unset')
					return {
						path: path!,
						attribute: value === 'set' ? attribute! : `${attribute}=${value}`,
					};
			}
			return undefined;
		},
		async reconcileIndex(commit) {
			// `diff-index --cached` lists every index entry that differs from the
			// tree, including staged-only additions and deletions.
			const differing = await run([
				'diff-index',
				'--cached',
				'--name-only',
				'--no-renames',
				'-z',
				commit,
			]);
			const paths = text(differing.stdout).split('\0').filter(Boolean);
			await syncIndex(commit, paths);
			return paths;
		},
		async ignoredPaths(candidates) {
			// `--no-index` evaluates the rules alone; the caller keeps tracked files.
			const result = await run(
				['check-ignore', '--no-index', '--stdin', '-z'],
				{ input: `${candidates.join('\0')}\0`, allowFailure: true },
			);
			if (result.code !== 0 && result.code !== 1)
				throw new GitCommandError(['check-ignore'], result.code, result.stderr);
			return new Set(text(result.stdout).split('\0').filter(Boolean));
		},
		async indexMatchesHead(captured) {
			if (captured !== undefined)
				return backend.withObjects((access) =>
					capturedIndexMatchesHead(access, captured),
				);
			const head = await resolve(branchRef);
			const result = await run(
				head === undefined
					? ['ls-files', '--cached', '-z']
					: ['diff', '--cached', '--quiet', '--no-ext-diff'],
				{ allowFailure: true },
			);
			if (head === undefined)
				return result.code === 0 && result.stdout.byteLength === 0;
			if (result.code === 0) return true;
			if (result.code === 1) return false;
			throw new GitCommandError(['diff'], result.code, result.stderr);
		},
		readIndex: () => readPrivate('index'),
		async pathStatus() {
			const result = await run([
				'status',
				'--porcelain=v1',
				'-z',
				'--untracked-files=all',
			]);
			return parsePorcelain(result.stdout);
		},
		async stage(paths) {
			if (paths === 'all') await run(['add', '--all']);
			else await run([...literal, 'add', '--all', '--', ...paths]);
		},
		async commitIndex(message, author, merge) {
			if (merge !== undefined) {
				// Both parents are pinned. The tree is built from a listing of the
				// index, which `write-tree` would rewrite to cache its trees, so a
				// commit the compare-and-swap refuses leaves the index as it was.
				const listed = await run(['ls-files', '--stage', '-z']);
				const entries = new Map<string, TreeFile>();
				for (const record of text(listed.stdout).split('\0')) {
					const match = /^(\d{6}) ([0-9a-f]{40}) (\d)\t(.+)$/s.exec(record);
					if (match === null) continue;
					const [, mode, oid, stage, path] = match;
					if (stage !== '0') throw new Error(`${path} is still unmerged`);
					entries.set(path!, { mode: mode!, oid: oid! });
				}
				const tree = await writeTreeFiles(access, entries);
				const oid = await writeCommitObject(access, {
					tree,
					parents: [merge.head, merge.incoming],
					message,
					author,
				});
				const moved = await backend.casBranch(merge.head, oid);
				if (!moved.ok) return { status: 'branchMoved', actual: moved.actual };
				return { status: 'committed', oid, parent: merge.head };
			}
			const parent = await resolve(branchRef);
			if (await backend.indexMatchesHead()) return { status: 'nothing' };
			const result = await run(
				[
					'-c',
					`user.name=${author.name}`,
					'-c',
					`user.email=${author.email}`,
					'commit',
					'--quiet',
					'--no-edit',
					'--cleanup=verbatim',
					'--file=-',
				],
				{ input: message, allowFailure: true },
			);
			const head = await resolve(branchRef);
			if (result.code !== 0) {
				if (head !== parent) return { status: 'branchMoved', actual: head };
				throw new GitCommandError(['commit'], result.code, result.stderr);
			}
			if (head === undefined)
				throw new Error('git commit succeeded without a branch head');
			return { status: 'committed', oid: head, parent };
		},
		async diff({ staged, paths }) {
			const result = await run([
				...literal,
				'diff',
				'--no-color',
				'--no-ext-diff',
				...(staged ? ['--cached'] : []),
				'--',
				...paths,
			]);
			return text(result.stdout);
		},
		async log(depth): Promise<CommitSummary[]> {
			if ((await resolve(branchRef)) === undefined) return [];
			const result = await run([
				'log',
				`-n${depth}`,
				'--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%B%x1e',
				branchRef,
			]);
			return text(result.stdout)
				.split('\x1e')
				.map((record) => record.replace(/^\n/, ''))
				.filter((record) => record.trim() !== '')
				.map((record) => {
					const [oid, parents, name, email, timestamp, message] =
						record.split('\x1f');
					return {
						oid: oid!,
						parents: parents ? parents.split(' ') : [],
						message: message ?? '',
						author: {
							name: name!,
							email: email!,
							timestamp: Number(timestamp),
						},
					};
				});
		},
		async push(oid, signal) {
			if (remote === undefined) throw new Error('No remote is configured');
			await run(
				[
					'push',
					'--porcelain',
					remote.url,
					`${oid}:refs/heads/${remote.branch}`,
				],
				{ signal },
			);
			await run(['update-ref', trackingRef, oid]);
		},
		async fetch(signal) {
			if (remote === undefined) throw new Error('No remote is configured');
			const result = await run(
				[
					'fetch',
					'--no-tags',
					'--quiet',
					remote.url,
					`+refs/heads/${remote.branch}:${trackingRef}`,
				],
				{ signal, allowFailure: true },
			);
			if (result.code !== 0) {
				if (/couldn't find remote ref/i.test(result.stderr)) return undefined;
				throw new GitCommandError(['fetch'], result.code, result.stderr);
			}
			return resolve(trackingRef);
		},
		// The baseline is not checked here: each step carries its own file
		// condition, and other programs are met only at Git's lock files.
		async publishIncoming(plan): Promise<PublishResult> {
			if (plan.merge !== undefined) return publishMerge(plan, plan.merge);
			const { error: applyError } = await boundary.apply(plan.changes);
			if (applyError !== null) {
				if (applyError.name === 'Partial')
					return {
						status: 'partial',
						applied: applyError.applied,
						error: applyError.error,
					};
				return { status: 'refused', error: applyError };
			}
			try {
				await syncIndex(plan.nextHead, plan.paths);
			} catch (cause) {
				return {
					status: 'indexFailed',
					error: cause instanceof Error ? cause.message : String(cause),
				};
			}
			const moved = await backend.casBranch(plan.expectedHead, plan.nextHead);
			if (!moved.ok)
				return {
					status: 'branchMoved',
					actual: moved.actual,
					filesApplied: true,
				};
			return { status: 'published' };
		},
	};
	return backend;
}
