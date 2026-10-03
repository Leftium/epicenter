/**
 * A just-bash shell over an opened folder, reached through `folder.terminal()`.
 *
 * The shell reads and writes the same files as the app through the folder's
 * accounted storage; there is no scratch copy. Redirection and `rm` act on
 * whatever is at a path. Each successful content write
 * follows the folder's automatic history policy. A command that
 * rewrites a file it read in the same command writes against the sha256 it
 * read, so an intervening replacement is refused; a plain redirection is a
 * deliberate overwrite.
 *
 * `git` is a real command over the folder's history: status, diff, log, add,
 * commit -m, push, fetch, and pull --ff-only. Staged authoring requires
 * `commitOnEdit: false`. Other Git commands are refused.
 */
import { Buffer } from 'buffer/';
import {
	Bash,
	type CommandName,
	defineCommand,
	type IFileSystem,
} from 'just-bash';
import type { FileChange, FolderStorage, Submission } from './boundary.js';
import { hashBytes, ownBytes } from './capture.js';
import type { ApplyError, FileError } from './errors.js';
import type { FolderGit } from './folder.js';
import { reserveSubmission } from './storage.js';

export type TerminalResult = {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
};

export type FolderTerminal = {
	/** The working directory the next command starts in. */
	readonly cwd: string;
	exec(
		command: string,
		options?: { signal?: AbortSignal },
	): Promise<TerminalResult>;
};

const COMMANDS: CommandName[] = [
	'cat',
	'ls',
	'pwd',
	'sed',
	'awk',
	'echo',
	'printf',
	'grep',
	'rg',
	'head',
	'tail',
	'wc',
	'find',
	'tree',
	'mkdir',
	'rmdir',
	'cp',
	'mv',
	'rm',
	'stat',
	'touch',
	'diff',
	'sort',
	'uniq',
	'cut',
	'tr',
	'tee',
	'basename',
	'dirname',
	'true',
	'false',
	'sha256sum',
	'help',
	'clear',
];

/** Just Bash recognizes filesystem codes in the message, not an error property. */
const failure = (message: string, code: string) =>
	new Error(`${code}: ${message}`);

function fail(error: FileError | ApplyError): never {
	const code =
		error.name === 'NotFound'
			? 'ENOENT'
			: error.name === 'NotAFile'
				? 'EISDIR'
				: error.name === 'NotADirectory'
					? 'ENOTDIR'
					: error.name === 'DirectoryNotEmpty'
						? 'ENOTEMPTY'
						: error.name === 'Exists'
							? 'EEXIST'
							: error.name === 'Conflict'
								? 'ESTALE'
								: 'EIO';
	throw failure(error.message, code);
}

export function createTerminal(
	{ storage, git }: { storage: FolderStorage; git: FolderGit },
	{ cwd: initialCwd = '/' }: { cwd?: string } = {},
): FolderTerminal {
	let cwd = initialCwd;
	let files = new Map<string, number>();
	let directories = new Set<string>(['']);
	/** Versions read during the current command, by folder-relative path. */
	const observed = new Map<string, string>();

	async function refresh() {
		const listing = await storage.list();
		if (listing.error) fail(listing.error);
		files = new Map(listing.data.files.map((file) => [file.path, file.size]));
		directories = new Set(['', ...listing.data.directories]);
	}

	function resolvePath(base: string, path: string): string {
		const parts = path.startsWith('/') ? [] : base.split('/').filter(Boolean);
		for (const part of path.split('/')) {
			if (part === '' || part === '.') continue;
			if (part === '..') parts.pop();
			else parts.push(part);
		}
		return `/${parts.join('/')}`;
	}
	const relative = (path: string) => resolvePath('/', path).slice(1);

	function isFile(path: string) {
		return files.has(relative(path));
	}
	function isDirectory(path: string) {
		return directories.has(relative(path));
	}

	/** Snapshot descendants before a tree operation starts changing storage. */
	function descendantsOf(name: string) {
		const prefix = `${name}/`;
		return {
			prefix,
			files: [...files.keys()].filter((path) => path.startsWith(prefix)),
			directories: [...directories].filter((path) => path.startsWith(prefix)),
		};
	}

	async function readBytes(path: string): Promise<Uint8Array> {
		const name = relative(path);
		const read = await storage.read(name);
		if (read.error) fail(read.error);
		observed.set(name, read.data.sha256);
		return read.data.bytes;
	}

	/**
	 * Maintain command observations for every confirmed step, including
	 * partial progress. Each file step reserves its `submission` when it is
	 * entered, like any other save of the page.
	 */
	async function applyChanges(
		changes: readonly FileChange[],
		submission: Submission,
	) {
		if (changes.length === 0) return;
		const result = await storage.apply(changes, submission);
		const applied =
			result.error === null
				? changes
				: result.error.name === 'Partial'
					? result.error.applied
					: [];
		for (const step of applied) {
			if (step.kind === 'remove') observed.delete(step.path);
			else if (step.kind === 'move') {
				const sha256 = observed.get(step.from);
				observed.delete(step.from);
				if (sha256 === undefined) observed.delete(step.to);
				else observed.set(step.to, sha256);
			} else {
				const write = changes.find(
					(change) =>
						change.kind !== 'move' &&
						change.kind !== 'remove' &&
						change.path === step.path,
				);
				// A native move can publish its destination before retiring its source fails.
				const move = changes.find(
					(change) => change.kind === 'move' && change.to === step.path,
				);
				const sha256 =
					write && 'sha256' in write
						? write.sha256
						: move?.kind === 'move'
							? observed.get(move.from)
							: undefined;
				if (sha256 === undefined) observed.delete(step.path);
				else observed.set(step.path, sha256);
			}
		}
		if (result.error) {
			if (applied.length > 0 || result.error.name === 'Unconfirmed')
				await refresh().catch(() => {});
			fail(result.error);
		}
		await refresh();
	}

	async function removeDirectories(paths: readonly string[]) {
		for (const path of paths) {
			const removed = await storage.rmdir(path);
			if (removed.error && removed.error.name !== 'NotFound')
				fail(removed.error);
			// Derived directories can disappear with their last file.
			directories.delete(path);
		}
		await refresh();
	}

	async function writeBytes(
		path: string,
		content: string | Uint8Array,
		submission = reserveSubmission(),
	) {
		const name = relative(path);
		const bytes = ownBytes(content);
		// A rewrite of bytes this command read is conditional; otherwise the
		// shell deliberately overwrites or creates the path.
		const expectedSha256 = observed.get(name);
		const sha256 = await hashBytes(bytes);
		await applyChanges(
			[
				expectedSha256 === undefined
					? { kind: 'overwrite', path: name, bytes, sha256 }
					: { kind: 'replace', path: name, bytes, sha256, expectedSha256 },
			],
			submission,
		);
	}

	const fs: IFileSystem = {
		resolvePath,
		getAllPaths: () =>
			[
				...[...directories].map((directory) => `/${directory}`),
				...[...files.keys()].map((file) => `/${file}`),
			].sort(),
		async readFile(path, options) {
			const bytes = await readBytes(path);
			const encoding =
				typeof options === 'string' ? options : options?.encoding;
			return Buffer.from(bytes).toString(encoding ?? 'utf8');
		},
		readFileBuffer: readBytes,
		writeFile: async (path, content, options) => {
			const encoding =
				typeof options === 'string' ? options : options?.encoding;
			await writeBytes(
				path,
				typeof content === 'string'
					? Buffer.from(content, encoding ?? 'utf8')
					: content,
			);
		},
		async appendFile(path, content, options) {
			const submission = reserveSubmission();
			const encoding =
				typeof options === 'string' ? options : options?.encoding;
			const addition =
				typeof content === 'string'
					? Buffer.from(content, encoding ?? 'utf8')
					: ownBytes(content);
			const name = relative(path);
			const read = await storage.read(name);
			if (read.error) {
				if (read.error.name !== 'NotFound') fail(read.error);
				await applyChanges(
					[
						{
							kind: 'create',
							path: name,
							bytes: addition,
							sha256: await hashBytes(addition),
						},
					],
					submission,
				);
				return;
			}
			observed.set(name, read.data.sha256);
			if (addition.length === 0) return;
			const next = new Uint8Array(read.data.bytes.length + addition.length);
			next.set(read.data.bytes);
			next.set(addition, read.data.bytes.length);
			await writeBytes(path, next, submission);
		},
		exists: async (path) => isFile(path) || isDirectory(path),
		async stat(path) {
			const file = isFile(path);
			if (!file && !isDirectory(path))
				throw failure(`No such file or directory: ${path}`, 'ENOENT');
			return {
				// Identity belongs to a literal Folder entry, not a native inode.
				identity: resolvePath('/', path),
				isFile: file,
				isDirectory: !file,
				isSymbolicLink: false,
				mode: file ? 0o644 : 0o755,
				size: file ? (files.get(relative(path)) ?? 0) : 0,
				mtime: new Date(0),
			};
		},
		lstat: (path) => fs.stat(path),
		async realpath(path) {
			if (!(await fs.exists(path)))
				throw failure(`No such file or directory: ${path}`, 'ENOENT');
			return resolvePath('/', path);
		},
		async mkdir(path, options) {
			const name = relative(path);
			if (isDirectory(path) && options?.recursive) return;
			if (isFile(path) || isDirectory(path))
				throw failure(`File exists: ${path}`, 'EEXIST');
			const parent = resolvePath(path, '..');
			if (isFile(parent))
				throw failure(`Not a directory: ${parent}`, 'ENOTDIR');
			if (!options?.recursive && !isDirectory(parent))
				throw failure(`No such file or directory: ${parent}`, 'ENOENT');
			const made = await storage.mkdir(name);
			if (made.error) fail(made.error);
			await refresh();
		},
		async readdir(path) {
			if (!isDirectory(path))
				throw isFile(path)
					? failure(`Not a directory: ${path}`, 'ENOTDIR')
					: failure(`No such file or directory: ${path}`, 'ENOENT');
			const name = relative(path);
			const prefix = name === '' ? '' : `${name}/`;
			return [
				...new Set(
					[...directories, ...files.keys()]
						.filter((entry) => entry !== name && entry.startsWith(prefix))
						.map((entry) => entry.slice(prefix.length).split('/')[0]!),
				),
			].sort();
		},
		async rm(path, options) {
			const submission = reserveSubmission();
			const name = relative(path);
			if (isFile(path)) {
				await applyChanges(
					[{ kind: 'remove', path: name, expectedSha256: observed.get(name) }],
					submission,
				);
				return;
			}
			if (!isDirectory(path)) {
				if (options?.force) return;
				throw failure(`No such file or directory: ${path}`, 'ENOENT');
			}
			const { files: nestedFiles, directories: nestedDirectories } =
				descendantsOf(name);
			nestedDirectories.sort((a, b) => b.length - a.length);
			if (
				(nestedFiles.length > 0 || nestedDirectories.length > 0) &&
				!options?.recursive
			)
				throw failure(`Directory not empty: ${path}`, 'ENOTEMPTY');
			await applyChanges(
				nestedFiles.map((path) => ({
					kind: 'remove',
					path,
					expectedSha256: observed.get(path),
				})),
				submission,
			);
			await removeDirectories([...nestedDirectories, name]);
		},
		async cp(source, destination, options) {
			if (!isDirectory(source)) {
				const submission = reserveSubmission();
				await writeBytes(destination, await readBytes(source), submission);
				return;
			}
			if (!options?.recursive)
				throw failure(`Copying a directory requires -r: ${source}`, 'EISDIR');
			const {
				prefix,
				files: sourceFiles,
				directories: sourceDirectories,
			} = descendantsOf(relative(source));
			for (const path of [relative(source), ...sourceDirectories]) {
				const target =
					path === relative(source)
						? destination
						: `${destination}/${path.slice(prefix.length)}`;
				await fs.mkdir(target, { recursive: true });
			}
			for (const file of sourceFiles) {
				// Each copied file is its own save, placed before its source is
				// read, as a single-file copy is.
				const submission = reserveSubmission();
				await writeBytes(
					resolvePath('/', `${destination}/${file.slice(prefix.length)}`),
					await readBytes(`/${file}`),
					submission,
				);
			}
		},
		async mv(source, destination) {
			const submission = reserveSubmission();
			const from = relative(source);
			const to = relative(destination);
			if (isFile(source)) {
				await applyChanges(
					[{ kind: 'move', from, to, expectedSha256: observed.get(from) }],
					submission,
				);
				return;
			}
			if (!isDirectory(source))
				throw failure(`No such file or directory: ${source}`, 'ENOENT');
			if (isFile(destination) || isDirectory(destination))
				throw failure(`File exists: ${destination}`, 'EEXIST');
			const {
				prefix,
				files: sourceFiles,
				directories: sourceDirectories,
			} = descendantsOf(from);
			for (const path of [from, ...sourceDirectories]) {
				const target =
					path === from ? to : `${to}/${path.slice(prefix.length)}`;
				await fs.mkdir(`/${target}`, { recursive: true });
			}
			await applyChanges(
				sourceFiles.map((path) => ({
					kind: 'move',
					from: path,
					to: `${to}/${path.slice(prefix.length)}`,
					expectedSha256: observed.get(path),
				})),
				submission,
			);
			await removeDirectories([
				...sourceDirectories.sort((a, b) => b.length - a.length),
				from,
			]);
		},
		async chmod(path) {
			if (!(await fs.exists(path)))
				throw failure(`No such file or directory: ${path}`, 'ENOENT');
		},
		async utimes(path) {
			if (!(await fs.exists(path)))
				throw failure(`No such file or directory: ${path}`, 'ENOENT');
		},
		async symlink() {
			throw failure('Symbolic links are not portable folder files', 'EPERM');
		},
		async link() {
			throw failure('Hard links are not portable folder files', 'EPERM');
		},
		async readlink(path) {
			throw failure(`Not a symbolic link: ${path}`, 'EINVAL');
		},
	};

	const gitCommand = defineCommand('git', async (args, context) => {
		const result = await runGit(git, args, (path) =>
			relative(context.fs.resolvePath(context.cwd, path)),
		);
		if (args[0] === 'pull' && result.exitCode === 0) await refresh();
		return result;
	});

	const bash = new Bash({
		fs,
		cwd: initialCwd,
		customCommands: [gitCommand],
		commands: COMMANDS,
		defenseInDepth: false,
	});

	let queue: Promise<unknown> = Promise.resolve();

	return {
		get cwd() {
			return cwd;
		},
		exec(command, { signal } = {}) {
			const run = queue.then(async (): Promise<TerminalResult> => {
				observed.clear();
				try {
					await refresh();
				} catch (cause) {
					return {
						stdout: '',
						stderr: `${(cause as Error).message}\n`,
						exitCode: 1,
					};
				}
				const result = await bash.exec(command, { cwd, signal });
				const next = result.env?.PWD;
				if (next !== undefined && isDirectory(next)) cwd = next;
				return {
					stdout: result.stdout,
					stderr: result.stderr,
					exitCode: result.exitCode,
				};
			});
			queue = run.catch(() => {});
			return run;
		},
	};
}

const short = (oid: string | undefined) =>
	oid === undefined ? '(none)' : oid.slice(0, 7);

async function runGit(
	git: FolderGit,
	args: string[],
	toPath: (path: string) => string,
): Promise<TerminalResult> {
	const ok = (stdout: string): TerminalResult => ({
		stdout,
		stderr: '',
		exitCode: 0,
	});
	const error = (message: string, exitCode = 1): TerminalResult => ({
		stdout: '',
		stderr: message.endsWith('\n') ? message : `${message}\n`,
		exitCode,
	});
	const [subcommand, ...rest] = args;
	switch (subcommand) {
		case 'status': {
			const unsupported = rest.filter(
				(arg) =>
					!['-s', '--short', '--porcelain', '-b', '--branch'].includes(arg),
			);
			if (unsupported.length > 0)
				return error(`git status: unsupported option ${unsupported[0]}`, 129);
			const paths = await git.paths();
			if (paths.error) return error(paths.error.message);
			const snapshot = git.snapshot;
			const sync =
				snapshot.sync.state === 'observed' ? snapshot.sync.value : undefined;
			let header = `## ${snapshot.branch}`;
			if (sync?.remote !== undefined && snapshot.remote !== undefined) {
				header += `...origin/${snapshot.remote.branch}`;
				const counts = [
					sync.ahead > 0 ? `ahead ${sync.ahead}` : '',
					sync.behind > 0 ? `behind ${sync.behind}` : '',
				].filter(Boolean);
				if (counts.length > 0) header += ` [${counts.join(', ')}]`;
			}
			const lines = paths.data.map((path) =>
				path.index === '?' || path.worktree === '?'
					? `?? ${path.path}`
					: `${path.index}${path.worktree} ${path.path}`,
			);
			if (lines.length === 0)
				return ok(`${header}\nnothing to commit, working tree clean\n`);
			return ok(`${header}\n${lines.join('\n')}\n`);
		}
		case 'diff': {
			let staged = false;
			const paths: string[] = [];
			for (const arg of rest) {
				if (arg === '--cached' || arg === '--staged') staged = true;
				else if (arg === '--') continue;
				else if (arg.startsWith('-'))
					return error(`git diff: unsupported option ${arg}`, 129);
				else paths.push(toPath(arg));
			}
			const diff = await git.diff({
				staged,
				paths: paths.map((path) => path || '.'),
			});
			if (diff.error) return error(diff.error.message);
			return ok(diff.data);
		}
		case 'log': {
			let depth = 20;
			let oneline = false;
			for (let index = 0; index < rest.length; index++) {
				const arg = rest[index]!;
				if (arg === '--oneline') oneline = true;
				else if (arg === '-n') depth = Number(rest[++index]);
				else if (/^-n\d+$/.test(arg)) depth = Number(arg.slice(2));
				else if (/^-\d+$/.test(arg)) depth = Number(arg.slice(1));
				else if (/^--max-count=\d+$/.test(arg))
					depth = Number(arg.split('=')[1]);
				else return error(`git log: unsupported argument ${arg}`, 129);
			}
			if (!Number.isInteger(depth) || depth < 1)
				return error('git log: invalid count', 129);
			const log = await git.log(depth);
			if (log.error) return error(log.error.message);
			if (log.data.length === 0)
				return error(
					`fatal: your current branch '${git.snapshot.branch}' does not have any commits yet`,
					128,
				);
			if (oneline)
				return ok(
					log.data
						.map(
							(commit) =>
								`${short(commit.oid)} ${commit.message.split('\n')[0]}`,
						)
						.join('\n') + '\n',
				);
			return ok(
				log.data
					.map((commit) => {
						const date = new Date(commit.author.timestamp * 1000).toISOString();
						const body = commit.message
							.replace(/\n+$/, '')
							.split('\n')
							.map((line) => `    ${line}`)
							.join('\n');
						return `commit ${commit.oid}\nAuthor: ${commit.author.name} <${commit.author.email}>\nDate:   ${date}\n\n${body}\n`;
					})
					.join('\n'),
			);
		}
		case 'add': {
			if (rest.length === 0)
				return error(
					"Nothing specified, nothing added.\nhint: Maybe you wanted to say 'git add .'?",
				);
			let all = false;
			const paths: string[] = [];
			for (const arg of rest) {
				if (arg === '-A' || arg === '--all') all = true;
				else if (arg === '--') continue;
				else if (arg.startsWith('-'))
					return error(`git add: unsupported option ${arg}`, 129);
				else paths.push(toPath(arg));
			}
			const target = all || paths.includes('') ? 'all' : paths;
			const staged = await git.stage(target);
			if (staged.error) return error(`fatal: ${staged.error.message}`, 128);
			return ok('');
		}
		case 'commit': {
			const messages: string[] = [];
			for (let index = 0; index < rest.length; index++) {
				const arg = rest[index]!;
				if (arg === '-m' || arg === '--message') {
					const value = rest[++index];
					if (value === undefined)
						return error(`error: switch \`m' requires a value`, 129);
					messages.push(value);
				} else if (arg.startsWith('--message='))
					messages.push(arg.slice('--message='.length));
				else if (arg.startsWith('-m') && arg.length > 2)
					messages.push(arg.slice(2));
				else
					return error(
						`git commit: unsupported argument ${arg}; use git add, then git commit -m <message>`,
						129,
					);
			}
			if (messages.length === 0)
				return error(
					'git commit: a message is required: git commit -m <message>',
					129,
				);
			const committed = await git.commitStaged(messages.join('\n\n'));
			if (committed.error) {
				if (committed.error.name === 'NothingToCommit')
					return error('nothing added to commit', 1);
				return error(committed.error.message);
			}
			const subject = messages[0]!.split('\n')[0];
			return ok(
				`[${git.snapshot.branch} ${short(committed.data.oid)}] ${subject}\n`,
			);
		}
		case 'push': {
			if (rest.length > 0)
				return error(
					'git push: arguments are not supported; the folder pushes its branch to its configured remote',
					129,
				);
			const pushed = await git.push();
			switch (pushed.status) {
				case 'pushed':
					return ok(
						`To ${git.snapshot.remote?.url}\n   ${short(pushed.oid)} -> ${git.snapshot.remote?.branch}\n`,
					);
				case 'noRemote':
					return error('fatal: No configured push destination.', 128);
				case 'nothingToPush':
					return error(
						'error: src refspec does not match any: there are no commits yet',
					);
				case 'failed':
					return error(
						`error: failed to push ${short(pushed.oid)}: ${pushed.error}`,
					);
				case 'unconfirmed':
					return error(`error: push not confirmed: ${pushed.error}`);
				case 'cancelled':
				case 'closed':
				case 'skipped':
					return error(`error: push ${pushed.status}`);
			}
			return error('error: push did not complete');
		}
		case 'fetch': {
			if (rest.length > 0)
				return error(
					'git fetch: arguments are not supported; the folder fetches its configured remote branch',
					129,
				);
			const fetched = await git.fetch();
			if (fetched.error) return error(fetched.error.message);
			const remote = git.snapshot.remote;
			if (fetched.data.oid === undefined)
				return ok(`The remote has no ${remote?.branch} branch yet\n`);
			return ok(
				`From ${remote?.url}\n * ${remote?.branch} -> origin/${remote?.branch} (${short(fetched.data.oid)})\n`,
			);
		}
		case 'pull': {
			if (
				!rest.includes('--ff-only') ||
				rest.some((arg) => arg !== '--ff-only')
			)
				return error('git pull: only `git pull --ff-only` is supported', 129);
			const fetched = await git.fetch();
			if (fetched.error) return error(fetched.error.message);
			const pulled = await git.pullFastForward();
			if (pulled.error) return error(`fatal: ${pulled.error.message}`, 128);
			switch (pulled.data.status) {
				case 'upToDate':
					return ok('Already up to date.\n');
				case 'ahead':
					return ok(
						'Already up to date. Local commits are ahead of the remote.\n',
					);
				case 'fastForwarded':
					return ok(
						`Updating ${short(pulled.data.from)}..${short(pulled.data.to)}\nFast-forward\n${pulled.data.changedPaths
							.map((path) => ` ${path}`)
							.join(
								'\n',
							)}\n ${pulled.data.changedPaths.length} files changed\n`,
					);
			}
			return error('pull did not complete');
		}
		case undefined:
		case 'help':
		case '--help':
			return ok(
				`Supported: git status, git diff [--cached] [paths], git log [-n N] [--oneline]${git.snapshot.commitOnEdit ? '' : ', git add <paths>|-A, git commit -m <message>'}, git push, git fetch, git pull --ff-only\n`,
			);
		default:
			return error(
				`git: '${subcommand}' is not supported in this folder terminal`,
				1,
			);
	}
}
