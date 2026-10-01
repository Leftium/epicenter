/**
 * The injected commit failure uses Git's own branch lock path, so it must
 * behave like a careful Git process: take the lock only when it is free, and
 * release only the lock it took. These run against a real repository and real
 * lock files.
 */
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DataDefinition } from '@epicenter/definition';
import type { Folder } from '@epicenter/folder/bun';
import { expectOk } from 'wellcrafted/testing';
import { openTestFolder } from '../src/lib/workspace.test-support.js';
import {
	createFailureInjection,
	LOCK_MARKER_PREFIX,
} from './failure-injection.js';
import { createHost } from './host.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function open() {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), 'whispering-lock-')),
	);
	const folder = (await openTestFolder(root, {
		commitOnEdit: false,
	})) as unknown as Folder<DataDefinition>;
	cleanups.push(async () => {
		await folder.close();
		await rm(root, { recursive: true, force: true });
	});
	return {
		root,
		folder,
		lock: join(root, '.git', 'refs', 'heads', 'main.lock'),
	};
}

const exists = (path: string) =>
	stat(path).then(
		() => true,
		() => false,
	);

test('the injected lock is created and removed by the host that owns it', async () => {
	const { root, folder, lock } = await open();
	const injection = createFailureInjection({ root, folder });

	expect((await injection.arm({ commitsBlocked: true })).commitsBlocked).toBe(
		true,
	);
	expect(await readFile(lock, 'utf8')).toMatch(LOCK_MARKER_PREFIX);

	expect((await injection.arm({ commitsBlocked: false })).commitsBlocked).toBe(
		false,
	);
	expect(await exists(lock)).toBe(false);
});

test('a lock another Git process holds is never replaced or removed', async () => {
	const { root, folder, lock } = await open();
	// What `git update-ref` writes while it holds the branch: the new value.
	const theirs = '4b825dc642cb6eb9a060e54bf8d69288fbee4904\n';
	await writeFile(lock, theirs, { flag: 'wx' });
	const injection = createFailureInjection({ root, folder });

	await expect(injection.arm({ commitsBlocked: true })).rejects.toThrow(
		'held by another Git process',
	);
	expect(injection.state.commitsBlocked).toBe(false);
	expect(await readFile(lock, 'utf8')).toBe(theirs);

	// Neither disarming nor stopping the host touches a lock it does not own.
	await injection.arm({ commitsBlocked: false });
	await injection.release();
	expect(await readFile(lock, 'utf8')).toBe(theirs);
});

test('a lock that replaced ours is theirs, and is left alone', async () => {
	const { root, folder, lock } = await open();
	const injection = createFailureInjection({ root, folder });
	await injection.arm({ commitsBlocked: true });
	// Someone cleared our lock and a Git process then took the branch.
	const theirs = '4b825dc642cb6eb9a060e54bf8d69288fbee4904\n';
	await writeFile(lock, theirs);

	await injection.arm({ commitsBlocked: false });
	await injection.release();

	expect(await readFile(lock, 'utf8')).toBe(theirs);
});

test('one debug host never releases another debug host’s lock', async () => {
	const { root, folder, lock } = await open();
	const first = createFailureInjection({ root, folder });
	const second = createFailureInjection({ root, folder });
	await first.arm({ commitsBlocked: true });
	const held = await readFile(lock, 'utf8');

	await expect(second.arm({ commitsBlocked: true })).rejects.toThrow(
		'earlier debug session',
	);
	await second.arm({ commitsBlocked: false });
	await second.release();
	expect(await readFile(lock, 'utf8')).toBe(held);

	await first.release();
	expect(await exists(lock)).toBe(false);
});

test('starting and stopping a debug host leaves an existing branch lock in place', async () => {
	const { root, lock } = await open();
	const theirs = '4b825dc642cb6eb9a060e54bf8d69288fbee4904\n';
	await writeFile(lock, theirs, { flag: 'wx' });
	const logged: string[] = [];
	const start = (env: Record<string, string>) =>
		createHost({
			root,
			token: 'test-token',
			uiDist: undefined,
			debug: true,
			fixturePath: undefined,
			inlineToken: false,
			env,
			log: (message) => logged.push(message),
		});

	const plain = await start({});
	await plain.close();
	expect(await readFile(lock, 'utf8')).toBe(theirs);

	// Asking for the injected lock at launch does not take it from its holder.
	const armed = await start({ WHISPERING_DEBUG_BLOCK_COMMITS: '1' });
	expect(logged.join('\n')).toContain('held by another Git process');
	await armed.close();
	expect(await readFile(lock, 'utf8')).toBe(theirs);
});

test('the real lock blocks a real Git ref update, and releasing it unblocks it', async () => {
	const { root, folder } = await open();
	expectOk(await folder.files.create('note.md', 'one\n'));
	expect((await folder.git.commit()).status).toBe('committed');
	const head = execFileSync('git', ['rev-parse', 'HEAD'], {
		cwd: root,
		encoding: 'utf8',
	}).trim();
	const injection = createFailureInjection({ root, folder });
	await injection.arm({ commitsBlocked: true });

	expect(() =>
		execFileSync('git', ['update-ref', 'refs/heads/main', head], {
			cwd: root,
			stdio: 'pipe',
		}),
	).toThrow();
	expectOk(await folder.files.overwrite('note.md', 'two\n'));
	expect((await folder.git.commit()).status).not.toBe('committed');
	expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('two\n');

	await injection.release();
	expect((await folder.git.commit()).status).toBe('committed');
});
