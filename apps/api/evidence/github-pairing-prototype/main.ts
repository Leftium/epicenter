// Throwaway demo. Real local Git; simulated GitHub connection and repository IDs.
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { authorizeTransfer, type Connection } from './pairing.js';

const root = await mkdtemp(
	join(tmpdir(), 'epicenter-github-pairing-prototype-'),
);
const home = join(root, 'isolated-home');
await mkdir(home);
// No inherited credentials, global Git config, helpers, or repository overrides.
const env = {
	PATH: process.env.PATH,
	HOME: home,
	XDG_CONFIG_HOME: home,
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_TERMINAL_PROMPT: '0',
	GIT_AUTHOR_NAME: 'Prototype',
	GIT_AUTHOR_EMAIL: 'prototype@example.invalid',
	GIT_COMMITTER_NAME: 'Prototype',
	GIT_COMMITTER_EMAIL: 'prototype@example.invalid',
};
async function git(cwd: string, ...args: string[]) {
	const child = Bun.spawn(
		[
			'git',
			'-c',
			'core.hooksPath=/dev/null',
			'-c',
			'commit.gpgSign=false',
			...args,
		],
		{
			cwd,
			env,
			stdout: 'pipe',
			stderr: 'pipe',
		},
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}
async function run(cwd: string, ...args: string[]) {
	const result = await git(cwd, ...args);
	if (result.code !== 0) throw new Error(`${args.join(' ')}: ${result.stderr}`);
	return result.stdout;
}
async function commit(path: string, file: string, text: string) {
	await Bun.write(join(path, file), text);
	await run(path, 'add', '--', file);
	await run(path, 'commit', '-m', text.trim());
}
async function head(path: string) {
	return run(path, 'rev-parse', 'HEAD');
}
function expect(condition: boolean, message: string) {
	if (!condition) throw new Error(`Unexpected outcome: ${message}`);
	return message;
}

const notesRemote = join(root, 'notes.git');
const todosRemote = join(root, 'todos.git');
const notesA = join(root, 'notes-A');
const notesB = join(root, 'notes-B');
const notesOffline = join(root, 'notes-offline');
const todosA = join(root, 'todos-A');
const connection: Connection = {
	principal: 'account-A',
	isConnected: true,
	repositoryIds: [101, 102],
};
const notesPairing = { folder: 'so.epicenter.notes', repositoryId: 101 };
const todosPairing = { folder: 'so.epicenter.todos', repositoryId: 102 };
let notesRepository = { id: 101, url: notesRemote, isPrivate: true };
let notesOrigin = notesRemote;
const checkpoints: string[] = [];

const steps = [
	{
		title: 'One connection, two independent folders',
		async execute() {
			for (const [remote, local, file, text] of [
				[notesRemote, notesA, 'note.md', 'Notes from device A\n'],
				[todosRemote, todosA, 'todo.md', 'Buy milk\n'],
			]) {
				await run(root, 'init', '--bare', '--initial-branch=main', remote!);
				await run(root, 'init', '--initial-branch=main', local!);
				await commit(local!, file!, text!);
				await run(local!, 'remote', 'add', 'origin', remote!);
				await run(local!, 'push', '-u', 'origin', 'main');
			}
			const allowed = authorizeTransfer(
				connection,
				notesPairing,
				notesRepository,
				{ principal: 'account-A', origin: notesOrigin },
			);
			return expect(
				(await head(notesA)) !== (await head(todosA)) && allowed === 'Allowed',
				'Two separate root commits uploaded independently. Simulated pairing authorizes Notes.',
			);
		},
	},
	{
		title: 'Second device downloads before editing',
		async execute() {
			await run(root, 'clone', notesRemote, notesB);
			await commit(notesB, 'note.md', 'Updated on device B\n');
			await run(notesB, 'push', 'origin', 'main');
			await run(notesA, 'fetch', 'origin');
			await run(notesA, 'merge', '--ff-only', 'origin/main');
			return expect(
				(await head(notesA)) === (await head(notesB)) &&
					(await Bun.file(join(notesA, 'note.md')).text()) ===
						(await Bun.file(join(notesB, 'note.md')).text()),
				'Both devices now have the exact same Notes history and file.',
			);
		},
	},
	{
		title: 'Notes diverges; Todos still uploads',
		async execute() {
			await commit(notesA, 'note.md', 'Concurrent A edit\n');
			await commit(notesB, 'note.md', 'Concurrent B edit\n');
			await run(notesB, 'push', 'origin', 'main');
			const before = await head(notesA);
			const push = await git(notesA, 'push', 'origin', 'main');
			await run(notesA, 'fetch', 'origin');
			const adopt = await git(notesA, 'merge', '--ff-only', 'origin/main');
			await commit(todosA, 'todo.md', 'Buy milk and bread\n');
			await run(todosA, 'push', 'origin', 'main');
			return expect(
				push.code !== 0 && adopt.code !== 0 && before === (await head(notesA)),
				'Notes push and fast-forward refused; its edit survived. Todos uploaded successfully.',
			);
		},
	},
	{
		title: 'Same folder started independently offline',
		async execute() {
			await run(root, 'init', '--initial-branch=main', notesOffline);
			await commit(notesOffline, 'offline.md', 'Independent device content\n');
			await run(notesOffline, 'remote', 'add', 'origin', notesRemote);
			await run(notesOffline, 'fetch', 'origin');
			const before = await head(notesOffline);
			const base = await git(notesOffline, 'merge-base', 'HEAD', 'origin/main');
			const merge = await git(notesOffline, 'merge', 'origin/main');
			return expect(
				base.code === 1 &&
					merge.code !== 0 &&
					before === (await head(notesOffline)),
				'No shared ancestor. Ordinary merge refused and both histories survived, even with different filenames.',
			);
		},
	},
	{
		title: 'Saved is not uploaded',
		async execute() {
			await Bun.write(
				join(todosA, 'saved-but-uncommitted.md'),
				'This is only on the device\n',
			);
			await run(todosA, 'push', 'origin', 'main');
			const remoteFiles = await run(
				todosRemote,
				'ls-tree',
				'-r',
				'--name-only',
				'main',
			);
			return expect(
				!remoteFiles.includes('saved-but-uncommitted'),
				'A successful push omitted the saved but uncommitted file.',
			);
		},
	},
	{
		title: 'Repository renamed: same ID, stale origin',
		async execute() {
			notesRepository = {
				...notesRepository,
				url: join(root, 'renamed-notes.git'),
			};
			await rename(notesRemote, notesRepository.url);
			const result = authorizeTransfer(
				connection,
				notesPairing,
				notesRepository,
				{ principal: 'account-A', origin: notesOrigin },
			);
			return expect(
				result === 'Origin needs explicit review',
				`Simulated authorization: ${result}. No automatic remote rewrite.`,
			);
		},
	},
	{
		title: 'Old repository name reused',
		async execute() {
			await run(root, 'init', '--bare', '--initial-branch=main', notesRemote);
			notesRepository = { id: 999, url: notesRemote, isPrivate: true };
			const result = authorizeTransfer(
				connection,
				notesPairing,
				notesRepository,
				{ principal: 'account-A', origin: notesOrigin },
			);
			// Demonstrate native Git's lack of repository-ID checking separately.
			await run(notesOffline, 'push', 'origin', 'main');
			return expect(
				result === 'Repository was replaced' &&
					(await head(notesOffline)) ===
						(await run(notesRemote, 'rev-parse', 'main')),
				'Model refused the replacement ID. Raw Git nevertheless accepted an old history into an empty replacement.',
			);
		},
	},
	{
		title: 'Account isolation and disconnect',
		async execute() {
			const repository = { id: 102, url: todosRemote, isPrivate: true };
			const other = authorizeTransfer(connection, todosPairing, repository, {
				principal: 'account-B',
				origin: todosRemote,
			});
			const removed = authorizeTransfer(
				{ ...connection, repositoryIds: [] },
				todosPairing,
				repository,
				{ principal: 'account-A', origin: todosRemote },
			);
			connection.isConnected = false;
			const disconnected = authorizeTransfer(
				connection,
				todosPairing,
				repository,
				{ principal: 'account-A', origin: todosRemote },
			);
			return expect(
				other === 'Wrong Epicenter account' &&
					removed === 'Installation lacks access' &&
					disconnected === 'GitHub disconnected',
				'Simulated checks refused another account, removed repository access, and a disconnected connection. Local files survived.',
			);
		},
	},
];

async function snapshot() {
	const repositories = [];
	for (const [name, path] of [
		['Notes A', notesA],
		['Notes B', notesB],
		['Notes offline', notesOffline],
		['Todos A', todosA],
	]) {
		if (!(await Bun.file(join(path!, '.git/HEAD')).exists())) continue;
		repositories.push({
			checkout: name,
			head: (await head(path!)).slice(0, 8),
			files: await run(path!, 'status', '--short'),
			history: await run(path!, 'log', '--all', '--graph', '--oneline', '-5'),
		});
	}
	return {
		connection,
		pairings: [notesPairing, todosPairing],
		observedNotesRepository: notesRepository,
		notesOrigin,
		repositories,
	};
}

const isAutomatic = process.argv.includes('--all');
const terminal = isAutomatic
	? undefined
	: createInterface({ input: process.stdin, output: process.stdout });
try {
	console.log(
		'PROTOTYPE: real local Git; simulated GitHub permissions. No network or real credentials.',
	);
	if (terminal) console.log(JSON.stringify(await snapshot(), null, 2));
	for (const [index, step] of steps.entries()) {
		if (terminal) {
			const answer = await terminal.question(
				`[Enter] ${step.title}  [q] quit: `,
			);
			if (answer.trim() === 'q') break;
			console.clear();
		}
		const outcome = await step.execute();
		checkpoints.push(outcome);
		console.log(`${index + 1}. ${step.title}\n   ${outcome}`);
		console.log(JSON.stringify(await snapshot(), null, 2));
	}
	console.log(
		`Completed ${checkpoints.length}/${steps.length} scenarios. Temporary Git repositories removed on exit.`,
	);
} finally {
	terminal?.close();
	await rm(root, { recursive: true, force: true });
}
