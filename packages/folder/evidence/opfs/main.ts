/**
 * EVIDENCE: browser-folder acceptance checks in a real browser.
 *
 * Every check opens folders through the production browser opener, in this
 * origin's real OPFS, Web Locks, BroadcastChannel, and IndexedDB, under fresh
 * disposable `development` scope IDs. A same-origin iframe (`peer.ts`) is a
 * second browsing context on the same folder. The run removes its OPFS
 * directories and IndexedDB databases when it finishes.
 *
 * Every outcome is visible on the page: one list item per check whose
 * `.status` reads PASS, FAIL, or NOTE with its detail, `#state` with
 * `data-state="done"` and the totals, and a layout table that pairs each
 * logical path with the stored OPFS file it is. "Reload persistence check"
 * (`?reload=1`) writes a folder and reads it back after a page reload at
 * `?reload=2`; that page then drops the query, so "Run again" or a plain
 * reload starts a full run. `?reload=2` reached any other way says the check
 * was not run.
 *
 * The recovery checks build a pending incoming update the way a tab that
 * closed mid-publication leaves one: the record, the branch at the admitted
 * commit, and files partly written; or an empty record, as a tab leaves one
 * that closed before its admission finished. They write those raw entries
 * with the browser's own OPFS API, then use only `git.recoverIncoming()` and
 * the folder's public methods. No remote is reached.
 *
 * The migration check writes an earlier version's IndexedDB database with
 * raw IndexedDB, holding real history made in a scratch folder, then opens
 * the folder. The editor check drives the public row editor.
 *
 * Not covered here: quota exhaustion, eviction, and a real crash during a
 * stream close. The Bun suites cover interruption at each step over an
 * in-memory stand-in.
 */
import type { Result } from 'wellcrafted/result';
import {
	defineFolder,
	defineTable,
	type Folder,
	field,
	hashBytes,
	openFolder,
} from '../../src/browser.js';
import {
	type LegacyContents,
	seedLegacyFolder,
} from '../../src/legacy.test-support.js';
import type { PeerReply, PeerRequest } from './peer.js';

type Status = 'pass' | 'fail' | 'note';

const definition = defineFolder({
	kv: {},
	tables: { rows: defineTable({ fields: { title: field.string() } }) },
});
const scope = { channel: 'development' as const };
const author = { name: 'Evidence', email: 'evidence@example.test' };
/** Never reached: merges and pulls are refused before any transfer here. */
const remote = { url: 'http://127.0.0.1:9/unreachable.git', branch: 'main' };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const used = new Set<string>();
const opened: Folder<typeof definition>[] = [];
let runId = '';
let totals = { pass: 0, fail: 0 };

const element = (id: string) => document.getElementById(id)!;

function record(name: string, status: Status, detail: string) {
	if (status !== 'note') totals[status]++;
	const item = document.createElement('li');
	item.className = status;
	item.dataset.check = name;
	const label = document.createElement('span');
	label.className = 'status';
	label.textContent = status.toUpperCase();
	item.append(label, ` ${name}: ${detail}`);
	element('checks').append(item);
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function check(name: string, run: () => Promise<string>) {
	try {
		record(name, 'pass', await run());
	} catch (cause) {
		record(
			name,
			'fail',
			cause instanceof Error ? cause.message : String(cause),
		);
	}
}

function ok<T>(result: Result<T, { name: string; message: string }>): T {
	if (result.error)
		throw new Error(`${result.error.name}: ${result.error.message}`);
	return result.data;
}

async function open(id: string, options: { remote?: boolean } = {}) {
	used.add(id);
	const result = await openFolder({
		id,
		definition,
		browser: {
			scope,
			author,
			commitOnEdit: false,
			remote: options.remote ? remote : undefined,
		},
	});
	if (result.error) throw new Error(`open refused: ${result.error.message}`);
	opened.push(result.data);
	return result.data;
}

async function closeAll() {
	for (const folder of opened.splice(0)) await folder.close();
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
	a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);

function randomBytes(size: number) {
	const bytes = new Uint8Array(size);
	for (let offset = 0; offset < size; offset += 65536)
		crypto.getRandomValues(bytes.subarray(offset, offset + 65536));
	return bytes;
}

/** The folder's directory, read with the browser's own OPFS API. */
async function rawDirectory(id: string) {
	const origin = await navigator.storage.getDirectory();
	const channel = await origin.getDirectoryHandle('Epicenter Dev');
	const local = await channel.getDirectoryHandle('local');
	return local.getDirectoryHandle(id);
}

async function rawParent(id: string, path: string, create = false) {
	let directory = await rawDirectory(id);
	const parts = path.split('/');
	for (const part of parts.slice(0, -1))
		directory = await directory.getDirectoryHandle(part, { create });
	return { directory, name: parts.at(-1)! };
}

async function rawRead(id: string, path: string) {
	const { directory, name } = await rawParent(id, path);
	const file = await (await directory.getFileHandle(name)).getFile();
	return new Uint8Array(await file.arrayBuffer());
}

/** Write raw bytes as an uncooperative program would: no lock, no check. */
async function rawWrite(id: string, path: string, bytes: Uint8Array) {
	const { directory, name } = await rawParent(id, path, true);
	const handle = await directory.getFileHandle(name, { create: true });
	const writable = await handle.createWritable();
	await writable.write(bytes as Uint8Array<ArrayBuffer>);
	await writable.close();
}

async function rawRemove(id: string, path: string) {
	const { directory, name } = await rawParent(id, path);
	await directory.removeEntry(name);
}

async function rawExists(id: string, path: string) {
	try {
		await rawRead(id, path);
		return true;
	} catch {
		return false;
	}
}

type Entry = { name: string; kind: 'file' | 'directory' };
async function rawEntries(directory: FileSystemDirectoryHandle) {
	const entries: Entry[] = [];
	for await (const handle of (
		directory as unknown as {
			values(): AsyncIterable<{ name: string; kind: 'file' | 'directory' }>;
		}
	).values())
		entries.push({ name: handle.name, kind: handle.kind });
	return entries.sort((a, b) => (a.name < b.name ? -1 : 1));
}

async function countFiles(
	directory: FileSystemDirectoryHandle,
): Promise<number> {
	let count = 0;
	for (const entry of await rawEntries(directory))
		count +=
			entry.kind === 'file'
				? 1
				: await countFiles(await directory.getDirectoryHandle(entry.name));
	return count;
}

/** A second browsing context on this origin. */
async function peer() {
	const frame = document.createElement('iframe');
	frame.src = './peer.html';
	const ready = new Promise<void>((resolve) => {
		const listen = (event: MessageEvent) => {
			if (event.source === frame.contentWindow && event.data?.ready) {
				removeEventListener('message', listen);
				resolve();
			}
		};
		addEventListener('message', listen);
	});
	document.body.append(frame);
	await ready;
	let next = 0;
	return {
		ask(request: PeerRequest): Promise<PeerReply> {
			const id = ++next;
			return new Promise((resolve) => {
				const listen = (event: MessageEvent) => {
					if (event.source !== frame.contentWindow || event.data?.id !== id)
						return;
					removeEventListener('message', listen);
					resolve(event.data.reply as PeerReply);
				};
				addEventListener('message', listen);
				frame.contentWindow?.postMessage({ id, request }, location.origin);
			});
		},
		remove: () => frame.remove(),
	};
}

/** The IndexedDB database an earlier version kept this scoped folder in. */
const legacyName = (id: string) =>
	`epicenter-folder-scoped:${JSON.stringify(['development', 'local', null, id])}`;

async function cleanup() {
	await closeAll();
	const origin = await navigator.storage.getDirectory();
	for (const id of used) {
		try {
			const local = await (
				await origin.getDirectoryHandle('Epicenter Dev')
			).getDirectoryHandle('local');
			await local.removeEntry(id, { recursive: true });
		} catch {
			// Already gone.
		}
		await new Promise<void>((resolve) => {
			const deleting = indexedDB.deleteDatabase(legacyName(id));
			deleting.onsuccess = () => resolve();
			deleting.onerror = () => resolve();
			deleting.onblocked = () => resolve();
		});
	}
	used.clear();
}

/** Pair every logical path with its stored file, in the layout table. */
async function showLayout(folder: Folder<typeof definition>, id: string) {
	const table = element('layout');
	const header = document.createElement('tr');
	for (const heading of [
		'logical path',
		'stored OPFS file',
		'bytes',
		'SHA-256 read through the folder',
		'SHA-256 of the stored file',
		'same',
	]) {
		const cell = document.createElement('th');
		cell.textContent = heading;
		header.append(cell);
	}
	table.replaceChildren(header);
	let mismatches = 0;
	const listing = ok(await folder.files.list());
	for (const { path, size } of listing.files) {
		const viaFolder = ok(await folder.files.read(path)).sha256;
		const stored = await hashBytes(await rawRead(id, path));
		if (viaFolder !== stored) mismatches++;
		const row = document.createElement('tr');
		row.dataset.path = path;
		for (const text of [
			path,
			`Epicenter Dev/local/${id}/${path}`,
			String(size),
			viaFolder.slice(0, 16),
			stored.slice(0, 16),
			viaFolder === stored ? 'yes' : 'NO',
		]) {
			const cell = document.createElement('td');
			cell.textContent = text;
			row.append(cell);
		}
		table.append(row);
	}
	const git = await countFiles(
		await (await rawDirectory(id)).getDirectoryHandle('.git'),
	);
	element('layout-caption').textContent =
		`${listing.files.length} files and ${listing.directories.length} directories ` +
		`(${listing.directories.join(', ')}). Private Git state: ` +
		`Epicenter Dev/local/${id}/.git holds ${git} files and is never listed. ` +
		`${mismatches} mismatches.`;
	return mismatches;
}

const allBytes = Uint8Array.from({ length: 256 }, (_, index) => index);

async function filesAndLayout(id: string) {
	const large = randomBytes(4 * 1024 * 1024);
	await check('one path is one stored file; .git is private', async () => {
		const folder = await open(id);
		assert(
			folder.location.kind === 'opfs' &&
				folder.location.directory === `Epicenter Dev/local/${id}`,
			`location ${JSON.stringify(folder.location)}`,
		);
		ok(await folder.files.create('notes/a.md', '# A\n'));
		const raw = decoder.decode(await rawRead(id, 'notes/a.md'));
		assert(raw === '# A\n', `stored file holds ${JSON.stringify(raw)}`);
		const names = (await rawEntries(await rawDirectory(id))).map(
			(entry) => entry.name,
		);
		assert(names.includes('.git'), `stored names ${names}`);
		const listing = ok(await folder.files.list());
		assert(
			!listing.directories.some((path) => path.startsWith('.git')) &&
				!listing.files.some((file) => file.path.startsWith('.git')),
			'the listing shows .git',
		);
		return `stored names at the folder root: ${names.join(', ')}`;
	});

	await check(
		'exact bytes and empty directories survive reopening',
		async () => {
			let folder = await open(id);
			ok(await folder.files.create('bytes.bin', allBytes));
			ok(await folder.files.create('empty.txt', ''));
			ok(await folder.files.create('large.bin', large));
			ok(await folder.files.create('ünïcode/ノート.md', 'text'));
			ok(await folder.files.mkdir('empty/nested'));
			await closeAll();
			folder = await open(id);
			assert(
				sameBytes(ok(await folder.files.read('bytes.bin')).bytes, allBytes),
				'bytes.bin',
			);
			assert(
				ok(await folder.files.read('empty.txt')).bytes.byteLength === 0,
				'empty.txt',
			);
			assert(
				sameBytes(ok(await folder.files.read('large.bin')).bytes, large),
				'large.bin',
			);
			assert(
				decoder.decode(
					ok(await folder.files.read('ünïcode/ノート.md')).bytes,
				) === 'text',
				'unicode path',
			);
			const listing = ok(await folder.files.list());
			assert(listing.directories.includes('empty/nested'), 'empty/nested');
			return `${listing.files.length} files, ${listing.directories.length} directories`;
		},
	);

	await check(
		'names differing by case or Unicode form stay distinct',
		async () => {
			const folder = await open(id);
			const names = ['Case.md', 'case.md', 'é.md', 'é.md', 'a b%20c.md'];
			for (const name of names)
				ok(await folder.files.create(`names/${name}`, name));
			for (const name of names) {
				const read = decoder.decode(
					ok(await folder.files.read(`names/${name}`)).bytes,
				);
				assert(
					read === name,
					`${JSON.stringify(name)} reads ${JSON.stringify(read)}`,
				);
			}
			const stored = (
				await rawEntries(
					await (await rawDirectory(id)).getDirectoryHandle('names'),
				)
			).length;
			assert(
				stored === names.length,
				`${stored} stored files for ${names.length} names`,
			);
			return `${names.length} names, ${stored} stored files`;
		},
	);

	await check(
		'an opened Blob keeps its bytes after the path is replaced',
		async () => {
			const folder = await open(id);
			const saved = ok(await folder.files.create('take.bin', large));
			const blob = ok(await folder.files.open('take.bin'));
			const { directory, name } = await rawParent(id, 'take.bin');
			const snapshot = await (await directory.getFileHandle(name)).getFile();
			ok(await folder.files.replace(saved, 'replaced'));
			assert(
				sameBytes(new Uint8Array(await blob.arrayBuffer()), large),
				'the Blob changed',
			);
			let rawOutcome: string;
			try {
				const bytes = new Uint8Array(await snapshot.arrayBuffer());
				rawOutcome = sameBytes(bytes, large)
					? 'still read the old bytes'
					: `read ${bytes.byteLength} other bytes`;
			} catch (cause) {
				rawOutcome = `refused: ${(cause as Error).name}`;
			}
			record(
				'a raw getFile() snapshot taken before replacement',
				'note',
				rawOutcome,
			);
			return 'the Blob kept 4 MiB';
		},
	);

	await check(
		'the layout table pairs every logical path with its stored file',
		async () => {
			const folder = await open(id);
			const mismatches = await showLayout(folder, id);
			assert(
				mismatches === 0,
				`${mismatches} paths differ from their stored file`,
			);
			return 'every row reads the same SHA-256 both ways';
		},
	);
}

async function twoContexts(id: string) {
	const other = await peer();
	try {
		const joined = await other.ask({ kind: 'open', id });
		assert(joined.ok, `peer open: ${joined.error}`);

		await check(
			'across contexts, exactly one of two creates wins',
			async () => {
				const folder = await open(id);
				for (let round = 0; round < 10; round++) {
					const path = `race/create-${round}.md`;
					const [mine, theirs] = await Promise.all([
						folder.files.create(path, 'main'),
						other.ask({ kind: 'create', path, content: 'peer' }),
					]);
					const winners = Number(mine.error === null) + Number(theirs.ok);
					const loser = mine.error?.name ?? theirs.error;
					assert(
						winners === 1 && loser === 'Exists',
						`round ${round}: ${winners} winners, ${loser}`,
					);
				}
				return '10 rounds';
			},
		);

		await check(
			'across contexts, exactly one of two replacements wins',
			async () => {
				const folder = await open(id);
				for (let round = 0; round < 10; round++) {
					const path = `race/replace-${round}.md`;
					const base = ok(await folder.files.create(path, 'base'));
					const [mine, theirs] = await Promise.all([
						folder.files.replace(base, 'main'),
						other.ask({
							kind: 'replace',
							path,
							sha256: base.sha256,
							content: 'peer',
						}),
					]);
					const winners = Number(mine.error === null) + Number(theirs.ok);
					const loser = mine.error?.name ?? theirs.error;
					assert(
						winners === 1 && loser === 'Conflict',
						`round ${round}: ${winners} winners, ${loser}`,
					);
				}
				return '10 rounds';
			},
		);

		await check('a save is hinted to the other context', async () => {
			const folder = await open(id);
			ok(await folder.files.create('hinted.md', 'x'));
			for (let wait = 0; wait < 50; wait++) {
				const { hints = [] } = await other.ask({ kind: 'hints' });
				if (hints.includes('hinted.md')) return `after about ${wait * 20} ms`;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			throw new Error('no hint arrived');
		});

		await check(
			'a reader in another context sees whole old or new bytes',
			async () => {
				const folder = await open(id);
				const first = randomBytes(8 * 1024 * 1024);
				const second = randomBytes(8 * 1024 * 1024);
				const hashes = new Set([
					await hashBytes(first),
					await hashBytes(second),
				]);
				ok(await folder.files.create('big.bin', first));
				const reading = other.ask({
					kind: 'readFor',
					path: 'big.bin',
					ms: 2000,
				});
				for (let round = 0; round < 6; round++)
					ok(
						await folder.files.overwrite(
							'big.bin',
							round % 2 === 0 ? second : first,
						),
					);
				const { seen = [], failures = 0 } = await reading;
				assert(
					seen.every((hash) => hashes.has(hash)),
					`a read saw other bytes: ${seen}`,
				);
				const names = (await rawEntries(await rawDirectory(id))).map(
					(entry) => entry.name,
				);
				return `${seen.length} distinct states seen, ${failures} failed reads; stored names at the root: ${names.join(', ')}`;
			},
		);
	} finally {
		await other.ask({ kind: 'close' });
		other.remove();
	}
}

async function history(id: string) {
	await check(
		'history: commit, clean status, and the same log after reopening',
		async () => {
			let folder = await open(id);
			const commit = await folder.git.commit();
			assert(commit.status === 'committed', `commit ${commit.status}`);
			assert(
				ok(await folder.git.status()).changes.length === 0,
				'status is not clean',
			);
			await closeAll();
			folder = await open(id);
			const [head] = ok(await folder.git.log(1));
			assert(head?.oid === commit.oid, 'the log changed');
			assert(ok(await folder.git.paths()).length === 0, 'paths are not clean');
			return commit.oid;
		},
	);
}

/**
 * A folder whose last commit's publication stopped partway, as a closed tab
 * leaves it: the record names the commit before and the commit published,
 * the branch is still at the commit before, the index already matches the
 * published commit, `a.md` already holds its new bytes, and `c.md`, new in
 * the published commit, was never written.
 */
async function interrupted(id: string) {
	const folder = await open(id);
	ok(await folder.files.create('a.md', '1'));
	ok(await folder.files.create('b.md', '1'));
	const before = await folder.git.commit();
	assert(before.status === 'committed', `first commit ${before.status}`);
	ok(await folder.files.overwrite('a.md', '2'));
	ok(await folder.files.create('c.md', 'new'));
	const after = await folder.git.commit();
	assert(after.status === 'committed', `second commit ${after.status}`);
	await closeAll();
	const pending = {
		operationId: `evidence-${crypto.randomUUID()}`,
		branch: 'main',
		expectedHead: before.oid,
		nextHead: after.oid,
	};
	await rawWrite(id, '.git/refs/heads/main', encoder.encode(`${before.oid}\n`));
	await rawRemove(id, 'c.md');
	await rawWrite(
		id,
		'.git/epicenter-incoming.json',
		encoder.encode(JSON.stringify(pending)),
	);
	return pending;
}

async function waitForPending(folder: Folder<typeof definition>) {
	for (let wait = 0; wait < 100; wait++) {
		if (folder.git.snapshot.pendingIncoming !== undefined)
			return folder.git.snapshot.pendingIncoming;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return undefined;
}

async function recovery(id: string) {
	await check(
		'a pending update is shown, resumes nothing, and lets saves land',
		async () => {
			const pending = await interrupted(`${id}-pending`);
			const folder = await open(`${id}-pending`, { remote: true });
			const shown = await waitForPending(folder);
			assert(
				shown?.state === 'recorded' &&
					shown.operationId === pending.operationId,
				`snapshot shows ${JSON.stringify(shown)}`,
			);
			const commit = await folder.git.commit();
			assert(commit.status === 'blocked', `commit ${commit.status}`);
			const merge = await folder.git.mergeIncoming();
			assert(
				merge.error?.name === 'IncomingPending',
				`merge ${merge.error?.name ?? 'ok'}`,
			);
			ok(await folder.files.create('notes.md', 'saved while pending'));
			assert(
				!(await rawExists(`${id}-pending`, 'c.md')),
				'c.md was written without recovery',
			);
			assert(
				await rawExists(`${id}-pending`, '.git/epicenter-incoming.json'),
				'the record went away',
			);
			return `operation ${pending.operationId.slice(0, 18)}…; commit blocked; merge IncomingPending; notes.md saved`;
		},
	);

	await check(
		'recoverIncoming() completes it from the files it finds',
		async () => {
			const folder = await open(`${id}-pending`, { remote: true });
			await waitForPending(folder);
			const recovered = ok(await folder.git.recoverIncoming());
			assert(recovered.status === 'completed', `recovery ${recovered.status}`);
			const changed =
				recovered.status === 'completed'
					? recovered.changedPaths.join(', ')
					: '';
			assert(changed === 'a.md, c.md', `changed ${changed}`);
			assert(
				decoder.decode(await rawRead(`${id}-pending`, 'c.md')) === 'new',
				'c.md',
			);
			assert(
				!(await rawExists(`${id}-pending`, '.git/epicenter-incoming.json')),
				'the record remains',
			);
			assert(
				folder.git.snapshot.pendingIncoming === undefined,
				'the snapshot still shows it',
			);
			const changes = ok(await folder.git.status()).changes.map(
				(change) => change.path,
			);
			assert(changes.join() === 'notes.md', `status ${changes}`);
			await showLayout(folder, `${id}-pending`);
			return `completed ${changed}; status shows only notes.md`;
		},
	);

	await check(
		'a third value is refused and named; once restored, recovery completes',
		async () => {
			await interrupted(`${id}-third`);
			const folder = await open(`${id}-third`);
			await waitForPending(folder);
			const current = ok(await folder.files.read('a.md'));
			const third = ok(await folder.files.replace(current, 'third'));
			const refused = await folder.git.recoverIncoming();
			assert(
				refused.error?.name === 'RecoveryRefused' &&
					refused.error.paths.join() === 'a.md',
				`recovery ${refused.error?.name ?? 'ok'}`,
			);
			assert(
				!(await rawExists(`${id}-third`, 'c.md')),
				'a refused recovery wrote c.md',
			);
			ok(await folder.files.replace(third, '1'));
			const recovered = ok(await folder.git.recoverIncoming());
			assert(recovered.status === 'completed', `recovery ${recovered.status}`);
			return `refused naming a.md (${refused.error.message}); completed after a.md returned to its before bytes`;
		},
	);

	await check(
		'a branch already at the published commit is cleared without writing files',
		async () => {
			const pending = await interrupted(`${id}-cleared`);
			await rawWrite(
				`${id}-cleared`,
				'.git/refs/heads/main',
				encoder.encode(`${pending.nextHead}\n`),
			);
			const folder = await open(`${id}-cleared`);
			await waitForPending(folder);
			const cleared = ok(await folder.git.recoverIncoming());
			assert(cleared.status === 'cleared', `recovery ${cleared.status}`);
			assert(
				!(await rawExists(`${id}-cleared`, 'c.md')),
				'clearing wrote c.md',
			);
			const changes = ok(await folder.git.status()).changes;
			assert(
				changes.length === 1 &&
					changes[0]?.path === 'c.md' &&
					changes[0].kind === 'delete',
				`status ${JSON.stringify(changes)}`,
			);
			return 'cleared; status reports c.md deleted instead of assuming clean';
		},
	);

	await check(
		'an empty record is an admission that never finished: Git waits until recoverIncoming() removes it',
		async () => {
			const unadmitted = `${id}-unadmitted`;
			let folder = await open(unadmitted);
			ok(await folder.files.create('a.md', '1'));
			const first = await folder.git.commit();
			assert(first.status === 'committed', `first commit ${first.status}`);
			await closeAll();
			await rawWrite(
				unadmitted,
				'.git/epicenter-incoming.json',
				new Uint8Array(),
			);
			folder = await open(unadmitted);
			const shown = await waitForPending(folder);
			assert(
				shown?.state === 'unadmitted',
				`snapshot shows ${JSON.stringify(shown)}`,
			);
			ok(await folder.files.create('notes.md', 'saved while pending'));
			const blocked = await folder.git.commit();
			assert(blocked.status === 'blocked', `commit ${blocked.status}`);
			const recovered = ok(await folder.git.recoverIncoming());
			assert(
				recovered.status === 'admissionCleared',
				`recovery ${recovered.status}`,
			);
			assert(
				!(await rawExists(unadmitted, '.git/epicenter-incoming.json')),
				'the empty record remains',
			);
			assert(
				folder.git.snapshot.pendingIncoming === undefined,
				'the snapshot still shows it',
			);
			const changes = ok(await folder.git.status()).changes.map(
				(change) => change.path,
			);
			assert(changes.join() === 'notes.md', `status ${changes}`);
			const committed = await folder.git.commit();
			assert(committed.status === 'committed', `commit ${committed.status}`);
			return `pending state "${shown.state}"; commit blocked; recovery "${recovered.status}"; status then shows notes.md and a commit lands`;
		},
	);
}

async function migration(id: string) {
	await check(
		'a folder an earlier version saved in IndexedDB is copied with its history',
		async () => {
			// An earlier version kept a folder's files, directories, and Git
			// files in one IndexedDB database. Make real history in a scratch
			// folder, then write it into such a database with raw IndexedDB.
			const sourceId = `${id}-legacy-source`;
			const legacyId = `${id}-legacy`;
			used.add(legacyId);
			const source = await open(sourceId);
			ok(await source.files.create('bytes.bin', allBytes));
			ok(await source.files.mkdir('kept/empty'));
			const commit = await source.git.commit();
			assert(commit.status === 'committed', `source commit ${commit.status}`);
			await closeAll();
			const contents = await rawContents(sourceId);
			await seedLegacyFolder(
				{ indexedDB, IDBKeyRange },
				legacyName(legacyId),
				contents,
			);

			const folder = await open(legacyId);
			assert(
				sameBytes(ok(await folder.files.read('bytes.bin')).bytes, allBytes),
				'bytes',
			);
			assert(
				ok(await folder.files.list()).directories.includes('kept/empty'),
				'empty directory',
			);
			const [head] = ok(await folder.git.log(1));
			assert(head?.oid === commit.oid, 'history');
			// The database is kept as a backup, frozen at a version an earlier
			// build cannot open, so it cannot write there again.
			const earlier = await new Promise<string>((resolve) => {
				const opening = indexedDB.open(legacyName(legacyId), 1);
				opening.onsuccess = () => {
					opening.result.close();
					resolve('opened');
				};
				opening.onerror = () => resolve(opening.error?.name ?? 'error');
			});
			assert(earlier === 'VersionError', `earlier build's open: ${earlier}`);
			return `${contents.git.size} Git files and history ${commit.oid.slice(0, 12)} copied; the kept database refuses an earlier build (${earlier})`;
		},
	);
}

/** A folder's stored entries, read with the browser's own OPFS API, as an earlier version's database holds them. */
async function rawContents(id: string): Promise<LegacyContents> {
	const files = new Map<string, Uint8Array>();
	const git = new Map<string, Uint8Array>();
	const directories: string[] = [];
	async function visit(directory: FileSystemDirectoryHandle, prefix: string) {
		const entries = await rawEntries(directory);
		if (entries.length === 0 && prefix !== '' && !prefix.startsWith('.git'))
			directories.push(prefix);
		for (const entry of entries) {
			const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
			if (entry.kind === 'directory') {
				await visit(await directory.getDirectoryHandle(entry.name), path);
				continue;
			}
			const file = await (await directory.getFileHandle(entry.name)).getFile();
			const bytes = new Uint8Array(await file.arrayBuffer());
			if (path === '.git/epicenter-folder.json') continue;
			if (path.startsWith('.git/')) git.set(path.slice(5), bytes);
			else files.set(path, bytes);
		}
	}
	await visit(await rawDirectory(id), '');
	return { files, directories, git };
}

async function editing(id: string) {
	await check(
		'a row editor saves canonical text, follows an outside save while clean, and keeps input while dirty',
		async () => {
			const folder = await open(id);
			const path = 'rows/plan.md';
			ok(
				await folder.tables.rows.create({
					stem: 'plan',
					fields: { title: 'Plan' },
				}),
			);
			const editor = ok(await folder.tables.rows.edit('plan'));
			const states: string[] = [];
			const stop = editor.subscribe((state) => {
				states.push(
					state.saving !== undefined
						? 'saving'
						: state.isDirty
							? 'dirty'
							: 'clean',
				);
			});
			try {
				ok(editor.change({ fields: { title: 'Edited: a colon' } }));
				const receipt = ok(await editor.save());
				const stored = decoder.decode(await rawRead(id, path));
				assert(
					stored === receipt.canonical,
					`stored ${JSON.stringify(stored)}, saved ${JSON.stringify(receipt.canonical)}`,
				);
				assert(
					receipt.sha256 === (await hashBytes(encoder.encode(stored))),
					'the receipt names other bytes',
				);

				// An equivalent outside save in another layout: a clean editor follows.
				const outside = "---\ntitle: 'From outside'\n---\n";
				ok(await folder.files.overwrite(path, outside));
				await editor.refresh();
				const followed = editor.get();
				assert(
					!followed.isDirty &&
						followed.document.fields.title === 'From outside' &&
						followed.observation.kind === 'present' &&
						followed.observation.revision.source === outside,
					`clean editor holds ${JSON.stringify(followed.source)}`,
				);

				// A dirty editor keeps its input when the file changes again.
				ok(editor.change({ fields: { title: 'Typed' } }));
				const later = ok(await folder.files.read(path));
				ok(
					await folder.files.replace(
						later,
						'---\ntitle: Changed elsewhere\n---\n',
					),
				);
				await editor.refresh();
				const dirty = editor.get();
				assert(
					dirty.isDirty && dirty.document.fields.title === 'Typed',
					`dirty editor holds ${JSON.stringify(dirty.source)}`,
				);
				return `saved ${JSON.stringify(receipt.canonical)}; followed ${JSON.stringify(followed.source)}; kept ${JSON.stringify(dirty.source)}; states ${[...new Set(states)].join(' → ')}`;
			} finally {
				stop();
				await editor.dispose();
			}
		},
	);
}

async function closing(id: string) {
	await check('closing refuses new saves', async () => {
		const folder = await open(id);
		await folder.close();
		const late = await folder.files.create('late.md', 'x');
		assert(
			late.error?.name === 'Closed',
			`late save: ${late.error?.name ?? 'ok'}`,
		);
		return 'Closed';
	});
}

const RELOAD_KEY = 'opfs-evidence-reload';

/**
 * `?reload=1` writes a folder and reloads to `?reload=2`, which reads it back.
 * Returns whether this page finished the run; `false` while the reload is on
 * its way.
 */
async function reloadCheck(stage: string) {
	if (stage === '1') {
		const folder = await open(runId);
		ok(await folder.files.create('persist.bin', allBytes));
		await folder.close();
		sessionStorage.setItem(RELOAD_KEY, runId);
		location.search = '?reload=2';
		return false;
	}
	const id = sessionStorage.getItem(RELOAD_KEY);
	sessionStorage.removeItem(RELOAD_KEY);
	// The address bar no longer names a stage, so reloading this page or
	// "Run again" starts a full run.
	window.history.replaceState(null, '', location.pathname);
	if (id === null) {
		record(
			'bytes survive a page reload',
			'note',
			'not run: this page was not reached from a reload check that wrote a folder. Press "Reload persistence check" to run it.',
		);
		return true;
	}
	await check('bytes survive a page reload', async () => {
		const folder = await open(id);
		assert(
			sameBytes(ok(await folder.files.read('persist.bin')).bytes, allBytes),
			'bytes',
		);
		return id;
	});
	return true;
}

async function main() {
	running = true;
	runId = `opfs-evidence-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
	totals = { pass: 0, fail: 0 };
	element('checks').replaceChildren();
	element('state').dataset.state = 'running';
	element('state').textContent = 'Running…';
	const stage = new URLSearchParams(location.search).get('reload');
	let finished = true;
	try {
		record(
			'environment',
			'note',
			`${navigator.userAgent}; secure ${isSecureContext}; persisted ${await navigator.storage.persisted()}; run ${runId}`,
		);
		if (stage !== null) finished = await reloadCheck(stage);
		else {
			await filesAndLayout(runId);
			await twoContexts(runId);
			await history(runId);
			await recovery(runId);
			await migration(runId);
			await editing(`${runId}-editor`);
			await closing(runId);
		}
	} catch (cause) {
		record(
			'run',
			'fail',
			cause instanceof Error ? cause.message : String(cause),
		);
	} finally {
		if (finished) {
			await cleanup();
			element('state').dataset.state = 'done';
			element('state').textContent =
				`Done: ${totals.pass} passed, ${totals.fail} failed. Disposable storage removed.`;
			running = false;
		}
	}
}

let running = false;
element('run').onclick = () => {
	if (running) return;
	// A fresh full run, whatever stage the address bar named.
	window.history.replaceState(null, '', location.pathname);
	void main();
};
element('reload').onclick = () => {
	if (running) return;
	sessionStorage.removeItem(RELOAD_KEY);
	location.search = '?reload=1';
};
void main();
