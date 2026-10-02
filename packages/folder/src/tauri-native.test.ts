/**
 * Tauri Folder Adapter Conformance Tests (real native owner)
 *
 * The adapter in `tauri.ts` against the Rust folder owner itself: every
 * `invoke` here crosses Tauri's real command handler on its mock runtime, and
 * the folder is a real directory with a real Git repository. Two "windows"
 * share one owner, as two pages of a shell do.
 *
 * This needs a Rust toolchain and the plugin's dependencies, so it runs only
 * when `EPICENTER_FOLDER_BRIDGE=1`:
 *
 *     EPICENTER_FOLDER_BRIDGE=1 bun test --isolate src/tauri-native.test.ts
 *
 * `EPICENTER_FOLDER_BRIDGE_BINARY` names an already built test binary of the
 * plugin to run instead of building one.
 *
 * Key behaviors:
 * - A window attaches only to a scope registered for it, and learns the root
 * - Tables, raw files, and Git work through the adapter, and the owner
 *   commits a save on its own when the folder is free
 * - A page built for the previous protocol is refused at attach
 * - Two windows saving over one version: one lands, one conflicts
 * - A row another window changed after a table's directory read is still an
 *   exact-sha256 conflict
 * - A terminal command holds nothing: another window saves, and runs a whole
 *   terminal command of its own, between its steps, and the owner commits a
 *   terminal's save like any other
 * - A terminal's rewrite of a file it read is refused when another window
 *   wrote between its steps, and the steps before it stay landed
 * - A terminal `git fetch` in flight at the remote delays no save and no commit
 * - Closing a page mid-command stops the command's later steps; the save the
 *   owner already admitted lands and is committed without the page
 * - Closing one window's folder leaves the other window and the owner working,
 *   and the commit the owner admitted for its last save still finishes
 *
 * See also:
 * - `tauri.test.ts` for what the adapter decides on its own
 * - `native-best-effort.test.ts` for what file-backed tables do not promise
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import { realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileSink } from 'bun';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { defineFolder, defineTable, field } from './contract.js';
import {
	createBareRemote,
	git,
	gitHttpFetch,
	scratch,
} from './git-http.test-support.js';
import { hashBytes } from './capture.js';

const enabled = process.env.EPICENTER_FOLDER_BRIDGE === '1';
const MANIFEST = join(
	import.meta.dir,
	'../../tauri-plugin-epicenter-folder/Cargo.toml',
);
/** A prebuilt plugin test binary to run instead of building one with cargo. */
const PREBUILT = process.env.EPICENTER_FOLDER_BRIDGE_BINARY;

type Listener = (event: { payload: unknown }) => void;

/** The Rust process that owns the folder, reached line by line. */
class Bridge {
	private next = 1;
	private readonly waiting = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: unknown) => void }
	>();
	private readonly listeners = new Map<string, Set<Listener>>();
	/** Runs once, after the next directory listing returns and before the caller sees it. */
	afterListing: (() => Promise<void>) | undefined;

	private constructor(
		private readonly child: ReturnType<typeof Bun.spawn>,
		readonly root: string,
	) {}

	static async start(
		options: { manual?: boolean; remote?: string } = {},
	): Promise<Bridge> {
		const root = await realpath(await scratch('tauri-folder-'));
		const harness = [
			'tests::invoke_bridge',
			'--ignored',
			'--exact',
			'--nocapture',
		];
		const child = Bun.spawn(
			// A prebuilt test binary of the plugin is the same harness without
			// the build: `cargo test --no-run` produces it.
			PREBUILT === undefined
				? [
						'cargo',
						'test',
						'--offline',
						'--quiet',
						'--manifest-path',
						MANIFEST,
						'-p',
						'tauri-plugin-epicenter-folder',
						'--lib',
						harness[0] as string,
						'--',
						...harness.slice(1),
					]
				: [PREBUILT, ...harness],
			{
				stdin: 'pipe',
				stdout: 'pipe',
				stderr: 'inherit',
				env: {
					...process.env,
					FOLDER_BRIDGE_ROOT: root,
					...(options.manual ? { FOLDER_BRIDGE_MANUAL: '1' } : {}),
					...(options.remote ? { FOLDER_BRIDGE_REMOTE: options.remote } : {}),
				},
			},
		);
		const bridge = new Bridge(child, root);
		const { promise: ready, resolve } = Promise.withResolvers<void>();
		void bridge.pump(resolve);
		await ready;
		return bridge;
	}

	private async pump(ready: () => void) {
		const reader = (
			this.child.stdout as ReadableStream<Uint8Array>
		).getReader();
		const decoder = new TextDecoder();
		let buffered = '';
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			buffered += decoder.decode(value, { stream: true });
			let newline = buffered.indexOf('\n');
			while (newline >= 0) {
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				newline = buffered.indexOf('\n');
				// The test harness prints on the same stream; a reply can share a line.
				const at = line.indexOf('FOLDER_BRIDGE ');
				if (at < 0) continue;
				const message = JSON.parse(line.slice(at + 'FOLDER_BRIDGE '.length));
				if (message.ready) ready();
				else if (message.event !== undefined) {
					const key = `${message.window}\n${message.event}`;
					for (const listener of this.listeners.get(key) ?? [])
						listener({ payload: message.payload });
				} else if (message.id !== undefined) {
					const pending = this.waiting.get(message.id);
					this.waiting.delete(message.id);
					if ('ok' in message) pending?.resolve(message.ok);
					else pending?.reject(message.err);
				}
			}
		}
	}

	async invoke(window: string, cmd: string, args: unknown): Promise<unknown> {
		const id = this.next++;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		this.waiting.set(id, { resolve, reject });
		const stdin = this.child.stdin as FileSink;
		stdin.write(`${JSON.stringify({ id, window, cmd, args })}\n`);
		await stdin.flush();
		const reply = await promise;
		if (
			cmd === 'plugin:epicenter-folder|children' ||
			cmd === 'plugin:epicenter-folder|list'
		) {
			const hook = this.afterListing;
			this.afterListing = undefined;
			await hook?.();
		}
		return reply;
	}

	listen(window: string, event: string, listener: Listener) {
		const key = `${window}\n${event}`;
		const set = this.listeners.get(key) ?? new Set();
		this.listeners.set(key, set);
		set.add(listener);
		return () => set.delete(listener);
	}

	async stop() {
		await (this.child.stdin as FileSink).end();
		await this.child.exited;
		await rm(this.root, { recursive: true, force: true });
	}
}

let bridge: Bridge | undefined;
/** Which window the code running now belongs to. */
const windowLabel = new AsyncLocalStorage<string>();
const current = () => {
	const label = windowLabel.getStore();
	if (label === undefined) throw new Error('run this inside a window');
	return label;
};
const active = () => {
	if (bridge === undefined) throw new Error('no bridge is running');
	return bridge;
};

mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => true,
	invoke: (cmd: string, args: unknown = {}) =>
		active().invoke(current(), cmd, args),
}));
mock.module('@tauri-apps/api/event', () => ({
	listen: async (event: string, listener: Listener) =>
		active().listen(current(), event, listener),
}));

const { openFolder } = await import('./tauri.js');
const { commands, FOLDER_PROTOCOL } = await import('./native/bindings.gen.js');

const definition = defineFolder({
	id: 'so.epicenter.taurinativetest',
	kv: {},
	tables: {
		todos: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
	},
});
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Run code as one window. Everything it awaits keeps that window. */
const as =
	(label: string) =>
	<T>(work: () => Promise<T>): Promise<T> =>
		windowLabel.run(label, work);
const a = as('a');
const b = as('b');

async function setup(options: { manual?: boolean; remote?: string } = {}) {
	bridge = await Bridge.start(options);
	const running = bridge;
	const attach = (window: ReturnType<typeof as>) =>
		window(async () => expectOk(await openFolder({ id: 'notes', definition })));
	const folder = await attach(a);
	const other = await attach(b);
	return {
		root: running.root,
		folder,
		other,
		todos: folder.tables.todos,
		/** A write from window B, landing right after window A's next directory read. */
		interleave(path: string, text: string) {
			running.afterListing = () =>
				b(async () => {
					expectOk(await other.files.overwrite(path, text));
				});
		},
		files: async () => {
			const listed = await a(() => folder.files.children('todos'));
			return listed.error ? [] : listed.data.files;
		},
		/**
		 * Return once no commit the owner admitted is still running. `paths`
		 * takes the owner's Git lock, which an admitted commit holds from before
		 * its save returned until it has recorded its outcome.
		 */
		async settled() {
			expectOk(await b(() => other.git.paths()));
			// Its last snapshot event may still be on its way to this window.
			for (let waited = 0; waited < 600; waited++) {
				const { activity, lastCommit } = folder.git.snapshot;
				if (!activity.commit.active && lastCommit) return;
				await Bun.sleep(10);
			}
			throw new Error('no settled commit reached the snapshot');
		},
	};
}

afterEach(async () => {
	await bridge?.stop();
	bridge = undefined;
});

/**
 * How a terminal command failed. A file step the folder refused ends the
 * command, as a failed result or as the folder's own error thrown out of a
 * redirection.
 */
const failure = (running: Promise<{ exitCode: number; stderr: string }>) =>
	running.then(
		(result) => {
			expect(result.exitCode).not.toBe(0);
			return result.stderr;
		},
		(error: Error) => error.message,
	);

/**
 * A bare remote with one commit, served over real Git smart HTTP on a local
 * port. Every request waits until `release`, so a `git fetch` the owner
 * started stays in flight for as long as the test needs.
 */
class HeldRemote {
	private constructor(
		private readonly server: ReturnType<typeof Bun.serve>,
		private readonly directory: string,
		private readonly gate: PromiseWithResolvers<void>,
		private readonly counts: { answered: number },
		readonly url: string,
		/** The remote branch's commit. */
		readonly head: string,
		/** Resolves when the first request has reached the remote. */
		readonly arrived: Promise<void>,
	) {}

	static async start(): Promise<HeldRemote> {
		const directory = await realpath(await scratch('tauri-folder-remote-'));
		const bare = await createBareRemote(directory);
		const seed = join(directory, 'seed');
		await git(directory, 'init', '--quiet', '--initial-branch=main', seed);
		await writeFile(join(seed, 'upstream.md'), 'from the remote\n');
		await git(seed, 'add', '--all');
		await git(seed, 'commit', '--quiet', '-m', 'upstream');
		await git(seed, 'push', '--quiet', bare, 'main');
		const head = await git(seed, 'rev-parse', 'HEAD');

		const backend = await gitHttpFetch(directory);
		const gate = Promise.withResolvers<void>();
		const arrived = Promise.withResolvers<void>();
		const counts = { answered: 0 };
		const server = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			idleTimeout: 255,
			async fetch(request) {
				arrived.resolve();
				const body =
					request.method === 'GET' ? undefined : await request.arrayBuffer();
				await gate.promise;
				counts.answered++;
				const { pathname, search } = new URL(request.url);
				return backend(`http://git.test${pathname}${search}`, {
					method: request.method,
					headers: request.headers,
					body,
				});
			},
		});
		return new HeldRemote(
			server,
			directory,
			gate,
			counts,
			`http://127.0.0.1:${server.port}/remote.git`,
			head,
			arrived.promise,
		);
	}

	/** How many requests the remote has answered. */
	answered() {
		return this.counts.answered;
	}

	release() {
		this.gate.resolve();
	}

	async stop() {
		await this.server.stop(true);
		await rm(this.directory, { recursive: true, force: true });
	}
}

const row = (stem: string) => ({
	stem,
	fields: { title: stem, done: false },
});
const IMAGE = new Uint8Array([1, 2, 3]);

describe.skipIf(!enabled)('tauri folder against the native owner', () => {
	test('a window attaches only to a scope registered for it, and learns the root', async () => {
		bridge = await Bridge.start();
		const { root } = bridge;

		const intruder = expectErr(
			await as('intruder')(() => openFolder({ id: 'notes', definition })),
		);
		const unknown = expectErr(
			await a(() => openFolder({ id: 'elsewhere', definition })),
		);
		// The definition's own ID names no folder this shell registered.
		const byDefinition = expectErr(await a(() => openFolder({ definition })));
		const folder = expectOk(
			await a(() => openFolder({ id: 'notes', definition })),
		);

		expect(intruder.name).toBe('WindowNotPermitted');
		expect(unknown.name).toBe('UnknownScope');
		expect(byDefinition).toMatchObject({
			name: 'UnknownScope',
			scope: 'so.epicenter.taurinativetest',
		});
		expect(folder.location).toEqual({ kind: 'directory', root });
		expect(folder.git.snapshot.branch).toBe('main');
		expect(folder.git.snapshot.activity.commit).toEqual({ active: false });

		// A page built for the previous protocol is refused by the real owner.
		const old = await a(() => commands.attach('notes', FOLDER_PROTOCOL - 1));
		expect(old.error).toEqual({
			name: 'Incompatible',
			host: FOLDER_PROTOCOL,
			page: FOLDER_PROTOCOL - 1,
		});
	});

	test('a batch of audio and its row is one publication the owner commits once, and the snapshot says so', async () => {
		const { folder, todos, root, settled } = await setup();
		const statuses: (string | undefined)[] = [];
		folder.git.subscribe((snapshot) =>
			statuses.push(snapshot.lastCommit?.status),
		);

		const receipt = expectOk(
			await a(() =>
				folder.batch((batch) => {
					batch.files.create('todos/take.png', IMAGE);
					batch.tables.todos.create(row('take'));
				}),
			),
		);
		await settled();

		expect(receipt.steps.map((step) => step.kind)).toEqual(['write', 'write']);
		expect(await git(root, 'log', '--format=%s')).toBe('Update 2 files');
		expect(await git(root, 'ls-tree', '-r', '--name-only', 'HEAD')).toBe(
			'todos/take.md\ntodos/take.png',
		);
		expect(statuses.at(-1)).toBe('committed');
		expect(folder.git.snapshot.commitOnEdit).toBe(true);
		expect(expectOk(await a(() => folder.git.status())).changes).toEqual([]);
		// The receipt's captures are the versions the owner now reads back.
		const reread = expectOk(await a(() => todos.get('take')));
		const rowStep = receipt.steps[1];
		if (reread === undefined) throw new Error('the row is missing');
		expect(rowStep?.kind === 'write' && rowStep.file).toEqual({
			path: 'todos/take.md',
			sha256: reread.sha256,
		});
		const image = expectOk(await a(() => folder.files.read('todos/take.png')));
		const imageStep = receipt.steps[0];
		expect(imageStep?.kind === 'write' && imageStep.file.sha256).toEqual(
			image.sha256,
		);
		expect(image.sha256).toEqual(await hashBytes(IMAGE));

		// Deleting the row leaves the image: the owner removes one file.
		expectOk(await a(() => todos.delete(reread)));
		expect(
			expectOk(await a(() => folder.files.children('todos'))).files,
		).toEqual(['take.png']);
		const log = expectOk(await a(() => folder.git.log(5)));
		expect(log[0]?.author.name).toBe('Test Author');
		expect(await a(() => folder.git.push())).toEqual({ status: 'noRemote' });
		expect(expectErr(await a(() => folder.git.fetch())).name).toBe('NoRemote');
		expect(expectErr(await a(() => folder.git.stage('all'))).name).toBe(
			'AutomaticHistory',
		);
	});

	test('raw bytes round-trip exactly and the returned sha256 is the content hash', async () => {
		const { folder, other } = await setup({ manual: true });
		const bytes = Uint8Array.from({ length: 4096 }, (_, index) => index % 256);

		const created = expectOk(
			await a(() => folder.files.create('audio/take.wav', bytes)),
		);
		const read = expectOk(await b(() => other.files.read('audio/take.wav')));

		expect(created).toEqual({
			path: 'audio/take.wav',
			sha256: await hashBytes(bytes),
		});
		expect(read.sha256).toEqual(created.sha256);
		expect(read.bytes).toEqual(bytes);
		expect(
			expectErr(await a(() => folder.files.overwrite('../outside.md', 'x')))
				.name,
		).toBe('InvalidPath');
	});

	test('a capture stays the bytes that were saved while another window replaces the file', async () => {
		const { folder, other } = await setup({ manual: true });
		const mine = expectOk(await a(() => folder.files.create('a.md', 'mine')));
		const theirs = expectOk(
			await b(() => other.files.overwrite('a.md', 'theirs')),
		);

		// The save's capture did not follow the file. It is still the save.
		expect(mine.sha256).toEqual(await hashBytes(encoder.encode('mine')));
		const stale = expectErr(
			await a(() => folder.files.replace(mine, 'built on mine')),
		);
		expect(stale.name).toBe('Conflict');
		if (stale.name === 'Conflict')
			expect(stale.actualSha256).toEqual(theirs.sha256);
		expect(expectErr(await a(() => folder.files.remove(mine))).name).toBe(
			'Conflict',
		);
		expect(expectErr(await a(() => folder.files.move(mine, 'b.md'))).name).toBe(
			'Conflict',
		);

		// A read is the new observation, and a save built on it lands.
		const observed = expectOk(await a(() => folder.files.read('a.md')));
		expect(decoder.decode(observed.bytes)).toBe('theirs');
		const next = expectOk(
			await a(() => folder.files.replace(observed, 'built on theirs')),
		);
		expect(expectOk(await b(() => other.files.read('a.md'))).sha256).toEqual(
			next.sha256,
		);
	});

	test('two windows saving over one version: one lands and one conflicts', async () => {
		const { folder, other } = await setup({ manual: true });
		const base = expectOk(await a(() => folder.files.create('a.md', 'base')));

		const results = await Promise.all([
			a(() => folder.files.replace(base, 'from a')),
			b(() => other.files.replace(base, 'from b')),
		]);

		expect(results.filter((result) => result.error === null)).toHaveLength(1);
		const lost = results.find((result) => result.error !== null)?.error;
		expect(lost?.name).toBe('Conflict');
		const now = expectOk(await a(() => folder.files.read('a.md')));
		expect(['from a', 'from b']).toContain(decoder.decode(now.bytes));
		if (lost?.name === 'Conflict')
			expect(lost.actualSha256).toEqual(now.sha256);
	});

	test('a row another window changed after the directory read is an exact-sha256 conflict', async () => {
		const { folder, todos, interleave, files } = await setup({ manual: true });
		expectOk(await a(() => folder.files.create('todos/take.png', IMAGE)));
		const entry = expectOk(await a(() => todos.create(row('take'))));
		const changed = '---\ntitle: Changed\ndone: true\n---\n';
		interleave('todos/take.md', changed);

		// A rename reads the directory for its destination check, then moves
		// the row under the sha256 the entry captured.
		const refused = expectErr(await a(() => todos.rename(entry, 'next')));

		expect(refused.name).toBe('Conflict');
		if (refused.name !== 'Conflict') return;
		expect(refused.path).toBe('todos/take.md');
		expect(refused.expectedSha256).toEqual(entry.sha256);
		expect(refused.actualSha256).toEqual(
			await hashBytes(encoder.encode(changed)),
		);
		expect(await files()).toEqual(['take.md', 'take.png']);
	});

	test('a terminal command holds nothing: another window saves and runs its own terminal between its steps', async () => {
		const { folder, other, root, settled } = await setup();
		const terminal = folder.terminal();
		// Window A's command is stopped mid-run, inside its first listing.
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		active().afterListing = () => {
			reached.resolve();
			return release.promise;
		};
		const command = a(() =>
			terminal.exec('mkdir notes && echo "from the terminal" > notes/a.md'),
		);
		await reached.promise;

		// Window B does not wait for it: a save lands and the owner commits it,
		// and a whole terminal command of B's own runs to its end.
		expectOk(await b(() => other.files.create('from-b.md', 'did not wait')));
		await settled();
		expect(await git(root, 'log', '--format=%s')).toBe('Add from-b.md');
		const theirs = await b(() =>
			other.terminal().exec('echo "b ran" > b.md && cat b.md'),
		);
		expect(theirs).toEqual({ stdout: 'b ran\n', stderr: '', exitCode: 0 });
		// A's next save should find the gates free. A save made while B's
		// commit is still running would correctly skip its automatic attempt.
		await settled();
		const before = await git(root, 'rev-parse', 'HEAD');

		release.resolve();
		expect(await command).toEqual({ stdout: '', stderr: '', exitCode: 0 });
		expect(
			decoder.decode(
				expectOk(await a(() => folder.files.read('notes/a.md'))).bytes,
			),
		).toBe('from the terminal\n');

		// A terminal's save follows the folder's ordinary history policy: the
		// owner committed it on its own, with no explicit commit from anyone.
		await settled();
		const tracked = await git(root, 'ls-tree', '-r', '--name-only', 'HEAD');
		expect(tracked.split('\n')).toEqual(
			expect.arrayContaining(['b.md', 'from-b.md', 'notes/a.md']),
		);
		// That checkpoint may also contain B's content write if B's second
		// attempt was skipped. Its subject describes all captured changes.
		expect(await git(root, 'rev-parse', 'HEAD')).not.toBe(before);
		// A redirection publishes the empty file and then its content, one
		// attempt each. A second that found the first still running stays
		// uncommitted until the next commit, as it would from any page.
		expect((await a(() => terminal.exec('git status'))).exitCode).toBe(0);
		expect(['committed', 'unchanged']).toContain(
			(await a(() => folder.git.commit())).status,
		);
		expect(await git(root, 'status', '--porcelain')).toBe('');
		expect(await git(root, 'show', 'HEAD:notes/a.md')).toBe(
			'from the terminal',
		);
	});

	test('a terminal rewrite of a file it read is refused when another window wrote between its steps', async () => {
		const { folder, other, root } = await setup({ manual: true });
		expectOk(await a(() => folder.files.create('note.md', 'first\n')));
		const terminal = folder.terminal();
		const running = active();
		// After the command has read the file and made its directory, window B
		// replaces the file. The command's next step is its rewrite.
		const interleave = async () => {
			if (!existsSync(join(root, 'made'))) {
				running.afterListing = interleave;
				return;
			}
			await b(async () => {
				expectOk(await other.files.overwrite('note.md', 'from window b\n'));
			});
		};
		running.afterListing = interleave;

		const refused = await failure(
			a(() =>
				terminal.exec(
					'cat note.md && mkdir made && echo replaced > note.md && echo late > late.md',
				),
			),
		);

		// The rewrite named the sha256 the command read, and the owner
		// refused it. Nothing was merged or retried.
		expect(refused).toContain(
			"The file at 'note.md' does not match the captured SHA-256",
		);
		expect(
			decoder.decode(
				expectOk(await a(() => folder.files.read('note.md'))).bytes,
			),
		).toBe('from window b\n');
		// The step before it landed and stays; the step after it never ran.
		expect(existsSync(join(root, 'made'))).toBe(true);
		expect(existsSync(join(root, 'late.md'))).toBe(false);
		// A command that reads again builds on what is there now.
		expect(
			(await a(() => terminal.exec('cat note.md && echo next > note.md')))
				.exitCode,
		).toBe(0);
		expect(
			decoder.decode(
				expectOk(await b(() => other.files.read('note.md'))).bytes,
			),
		).toBe('next\n');
	});

	test('a terminal fetch in flight at the remote holds no save and no commit back', async () => {
		const remote = await HeldRemote.start();
		try {
			const { folder, other, root, settled } = await setup({
				remote: remote.url,
			});
			const terminal = folder.terminal();

			// The owner starts a real `git fetch`, and the remote does not answer.
			const fetching = a(() => terminal.exec('git fetch'));
			await remote.arrived;

			// With that transport in flight, both windows save, the owner commits
			// each save on its own, and explicit Git work runs.
			expectOk(await b(() => other.files.create('from-b.md', 'did not wait')));
			await settled();
			expect(await git(root, 'log', '--format=%s')).toBe('Add from-b.md');
			expectOk(await a(() => folder.files.create('from-a.md', 'nor did this')));
			await settled();
			expect((await git(root, 'log', '--format=%s')).split('\n')[0]).toBe(
				'Add from-a.md',
			);
			expect(expectOk(await a(() => folder.git.status())).changes).toEqual([]);
			expect(remote.answered()).toBe(0);
			let settledEarly = false;
			void fetching.then(() => {
				settledEarly = true;
			});
			await Bun.sleep(50);
			expect(settledEarly).toBe(false);

			// The remote answers, and the fetch brings in its commit.
			remote.release();
			const fetched = await fetching;
			expect(fetched.exitCode).toBe(0);
			expect(fetched.stdout).toContain(remote.head.slice(0, 7));
			expect(await git(root, 'rev-parse', 'refs/remotes/origin/main')).toBe(
				remote.head,
			);
		} finally {
			remote.release();
			await bridge?.stop();
			bridge = undefined;
			await remote.stop();
		}
	});

	test('closing a page mid-command stops its later steps; the save already admitted lands and is committed', async () => {
		const { folder, other, root } = await setup();
		const terminal = folder.terminal();
		const running = active();
		// Close window A's folder once the command's first file has landed,
		// from inside the listing that follows that save.
		let closing: Promise<void> | undefined;
		const closeAfterFirstSave = async () => {
			if (!existsSync(join(root, 'one.md'))) {
				running.afterListing = closeAfterFirstSave;
				return;
			}
			// Not awaited here: closing waits for this very listing.
			closing = a(() => folder.close());
		};
		running.afterListing = closeAfterFirstSave;

		const stopped = await failure(
			a(() => terminal.exec('echo one > one.md && echo two > two.md')),
		);
		await closing;

		expect(stopped).toMatch(/The folder is closed|execution aborted/);
		// The save the owner had admitted is in the folder; nothing after it is.
		expect(existsSync(join(root, 'one.md'))).toBe(true);
		expect(existsSync(join(root, 'two.md'))).toBe(false);
		expect(await a(() => terminal.exec('echo late > late.md'))).toEqual({
			stdout: '',
			stderr: 'The folder is closed\n',
			exitCode: 1,
		});
		expect(existsSync(join(root, 'late.md'))).toBe(false);

		// The owner finished that save's commit without the page, and window B
		// carries on.
		expectOk(await b(() => other.git.paths()));
		expect(await git(root, 'log', '--format=%s')).toBe('Add one.md');
		expectOk(await b(() => other.files.create('after.md', 'b carries on')));
		expectOk(await b(() => other.git.paths()));
		expect(await git(root, 'ls-tree', '-r', '--name-only', 'HEAD')).toBe(
			'after.md\none.md',
		);
	});

	test('closing one window leaves the other, and the commit admitted for its last save still finishes', async () => {
		const { folder, other, root } = await setup();
		const heard: (readonly string[])[] = [];
		other.onFilesChanged((paths) => heard.push(paths));

		// The folder is free, so the owner admits this save's commit before the
		// save returns. The page closes without waiting for it.
		expectOk(
			await a(() => folder.files.create('last.md', 'saved as the page closed')),
		);
		await a(() => folder.close());

		expect(expectErr(await a(() => folder.files.read('last.md'))).name).toBe(
			'Closed',
		);
		// The owner itself no longer knows window A's session.
		const session = await a(() => commands.list(1));
		expect(session.error?.name).toBe('Denied');

		// Window B waits on the owner's Git lock: the admitted commit finished
		// without the page that saved. Closing committed nothing itself.
		expectOk(await b(() => other.git.paths()));
		expect(await git(root, 'log', '--format=%s')).toBe('Add last.md');

		expectOk(
			await b(() => other.files.create('after.md', 'window b carries on')),
		);
		expectOk(await b(() => other.git.paths()));
		expect(await git(root, 'ls-tree', '-r', '--name-only', 'HEAD')).toBe(
			'after.md\nlast.md',
		);
		expect(heard.flat()).toEqual(
			expect.arrayContaining(['last.md', 'after.md']),
		);
		expect(other.git.snapshot.closed).toBe(false);
	});
});
