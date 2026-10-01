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
 *   commits a save on its own
 * - Two windows saving over one version: one lands, one conflicts
 * - A row another window changed after a table's directory read is still an
 *   exact-version conflict
 * - A terminal command holds the folder against another window for its run
 * - Closing one window's folder leaves the other window and the owner working
 *
 * See also:
 * - `tauri.test.ts` for what the adapter decides on its own
 * - `native-best-effort.test.ts` for what file-backed tables do not promise
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileSink } from 'bun';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { defineFolder, defineTable, field } from './contract.js';
import { git, scratch } from './git-http.test-support.js';
import { captureVersion } from './version.js';

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

	static async start(options: { manual?: boolean } = {}): Promise<Bridge> {
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
const { commands } = await import('./native/bindings.gen.js');

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

async function setup(options: { manual?: boolean } = {}) {
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
		/** Wait until the owner has committed and has no pass running or queued. */
		async settled() {
			for (let waited = 0; waited < 600; waited++) {
				const { activity, lastCommit } = folder.git.snapshot;
				if (!activity.commit.active && !activity.commit.pending && lastCommit)
					return;
				await Bun.sleep(10);
			}
			throw new Error('the commit queue did not drain');
		},
	};
}

afterEach(async () => {
	await bridge?.stop();
	bridge = undefined;
});

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
			version: reread.version,
		});
		const image = expectOk(await a(() => folder.files.read('todos/take.png')));
		const imageStep = receipt.steps[0];
		expect(imageStep?.kind === 'write' && imageStep.file.version).toEqual(
			image.version,
		);
		expect(image.version).toEqual(await captureVersion(IMAGE));

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

	test('raw bytes round-trip exactly and the returned version is the content version', async () => {
		const { folder, other } = await setup({ manual: true });
		const bytes = Uint8Array.from({ length: 4096 }, (_, index) => index % 256);

		const created = expectOk(
			await a(() => folder.files.create('audio/take.wav', bytes)),
		);
		const read = expectOk(await b(() => other.files.read('audio/take.wav')));

		expect(created).toEqual({
			path: 'audio/take.wav',
			version: await captureVersion(bytes),
		});
		expect(read.version).toEqual(created.version);
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
		expect(mine.version).toEqual(await captureVersion(encoder.encode('mine')));
		const stale = expectErr(
			await a(() => folder.files.replace(mine, 'built on mine')),
		);
		expect(stale.name).toBe('Conflict');
		if (stale.name === 'Conflict') expect(stale.actual).toEqual(theirs.version);
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
		expect(expectOk(await b(() => other.files.read('a.md'))).version).toEqual(
			next.version,
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
		if (lost?.name === 'Conflict') expect(lost.actual).toEqual(now.version);
	});

	test('a row another window changed after the directory read is an exact-version conflict', async () => {
		const { folder, todos, interleave, files } = await setup({ manual: true });
		expectOk(await a(() => folder.files.create('todos/take.png', IMAGE)));
		const entry = expectOk(await a(() => todos.create(row('take'))));
		const changed = '---\ntitle: Changed\ndone: true\n---\n';
		interleave('todos/take.md', changed);

		// A rename reads the directory for its destination check, then moves
		// the row under the version the entry captured.
		const refused = expectErr(await a(() => todos.rename(entry, 'next')));

		expect(refused.name).toBe('Conflict');
		if (refused.name !== 'Conflict') return;
		expect(refused.path).toBe('todos/take.md');
		expect(refused.expected).toEqual(entry.version);
		expect(refused.actual).toEqual(
			await captureVersion(encoder.encode(changed)),
		);
		expect(await files()).toEqual(['take.md', 'take.png']);
	});

	test('a terminal command holds the folder against another window until it ends', async () => {
		const { folder, other, root, settled } = await setup();
		const terminal = folder.terminal();
		// Hold the lease open from inside the command: its first listing waits.
		const { promise: release, resolve: finish } = Promise.withResolvers<void>();
		const running = active();
		running.afterListing = () => release;

		const command = a(() =>
			terminal.exec('mkdir notes && echo "from the terminal" > notes/a.md'),
		);
		const save = b(() =>
			other.files.create('from-b.md', 'waited for the terminal'),
		);
		const first = await Promise.race([
			save.then(() => 'save'),
			Bun.sleep(300).then(() => 'still waiting'),
		]);
		finish();
		const result = await command;
		expectOk(await save);
		await settled();

		expect(first).toBe('still waiting');
		expect(result).toEqual({ stdout: '', stderr: '', exitCode: 0 });
		expect(
			decoder.decode(
				expectOk(await a(() => folder.files.read('notes/a.md'))).bytes,
			),
		).toBe('from the terminal\n');
		const status = await a(() => terminal.exec('git status'));
		expect(status.exitCode).toBe(0);
		expect(await git(root, 'status', '--porcelain')).toBe('');
		expect(await git(root, 'ls-tree', '-r', '--name-only', 'HEAD')).toBe(
			'from-b.md\nnotes/a.md',
		);
	});

	test('closing one window leaves the other, and a save made just before closing is still committed', async () => {
		const { folder, other, root } = await setup();
		const heard: (readonly string[])[] = [];
		other.onFilesChanged((paths) => heard.push(paths));

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

		expectOk(
			await b(() => other.files.create('after.md', 'window b carries on')),
		);
		for (let waited = 0; waited < 600; waited++) {
			const { activity, lastCommit } = other.git.snapshot;
			if (!activity.commit.active && !activity.commit.pending && lastCommit)
				break;
			await Bun.sleep(10);
		}
		expect(await git(root, 'ls-tree', '-r', '--name-only', 'HEAD')).toBe(
			'after.md\nlast.md',
		);
		expect(heard.flat()).toEqual(
			expect.arrayContaining(['last.md', 'after.md']),
		);
		expect(other.git.snapshot.closed).toBe(false);
	});
});
