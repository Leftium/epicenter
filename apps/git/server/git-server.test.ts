/**
 * Disposable smart HTTP remote tests.
 * A fresh experiment has a new URL, a restarted experiment keeps its URL,
 * and real Git can clone and push the seeded repository over HTTP.
 */
import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitHandler, prepareGitSession } from './git-server.js';

async function git(cwd: string, ...args: string[]) {
	const child = Bun.spawn(['git', ...args], {
		cwd,
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(code, stderr).toBe(0);
	return stdout.trim();
}

test('fresh sessions have distinct URLs and real Git clones and pushes the seed', async () => {
	const first = await prepareGitSession(0);
	const second = await prepareGitSession(0);
	const client = await mkdtemp(join(tmpdir(), 'git-lab-http-client-'));
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: await createGitHandler(first),
	});
	try {
		expect(first.remoteUrl).not.toBe(second.remoteUrl);
		const url = `http://127.0.0.1:${server.port}${first.browserRemotePath}`;
		await git(client, 'clone', '--quiet', url, 'copy');
		const copy = join(client, 'copy');
		expect(await Bun.file(join(copy, 'notes/color.txt')).text()).toBe(
			'color=blue\n',
		);
		expect(await Bun.file(join(copy, 'README.md')).text()).toContain(
			'# Git lab',
		);
		await writeFile(join(copy, 'pushed.txt'), 'explicit push\n');
		await git(copy, 'add', 'pushed.txt');
		await git(
			copy,
			'-c',
			'user.name=Test',
			'-c',
			'user.email=test@localhost',
			'commit',
			'-qm',
			'Explicit push',
		);
		await git(copy, 'push', '--quiet');
		expect(
			await git(first.root, '--git-dir', first.bare, 'show', 'main:pushed.txt'),
		).toBe('explicit push');
		expect(
			(await fetch(`http://127.0.0.1:${server.port}/git/other.git/info/refs`))
				.status,
		).toBe(404);
		expect(
			(await fetch(`${url}/info/refs?service=git-upload-pack`)).headers.get(
				'access-control-allow-origin',
			),
		).toBeNull();
	} finally {
		server.stop(true);
		await Promise.all(
			[first.root, second.root, client].map((path) =>
				rm(path, { recursive: true, force: true }),
			),
		);
	}
}, 15000);

test('reopening the marked temporary root retains its remote identity and history', async () => {
	const first = await prepareGitSession(0);
	const previous = process.env.GIT_LAB_DEMO_ROOT;
	try {
		process.env.GIT_LAB_DEMO_ROOT = first.root;
		const reopened = await prepareGitSession(0);
		expect(reopened.remoteUrl).toBe(first.remoteUrl);
		expect(
			await git(first.root, '--git-dir', first.bare, 'rev-parse', 'main'),
		).toBe(
			await git(reopened.root, '--git-dir', reopened.bare, 'rev-parse', 'main'),
		);
	} finally {
		if (previous === undefined) delete process.env.GIT_LAB_DEMO_ROOT;
		else process.env.GIT_LAB_DEMO_ROOT = previous;
		await rm(first.root, { recursive: true, force: true });
	}
});
