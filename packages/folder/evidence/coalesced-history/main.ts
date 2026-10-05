/**
 * Manual acceptance app over production OPFS and the public row editor.
 * A real Web Lock creates contention. The one-shot lock adapter rejection
 * creates a controlled failure before Git work; all persistence is real OPFS.
 * Reload retains the disposable folder on this dedicated evidence origin.
 */
import {
	defineFolder,
	defineTable,
	field,
	openFolder,
} from '../../src/browser.js';
import { commitTree, readBlob, readTreeFiles } from '../../src/git/objects.js';
import { createOpfsGitStore } from '../../src/git/opfs-git.js';
import type { OpfsDirectoryHandle, OpfsLocks } from '../../src/opfs-store.js';

const id = 'so.epicenter.evidence.coalesced-history';
const address = JSON.stringify(['development', 'local', null, id]);
const gitLock = `epicenter-folder-opfs-git:${address}`;
const filesLock = `epicenter-folder-opfs-files:${address}`;
const definition = defineFolder({
	kv: {},
	tables: { notes: defineTable({ fields: { title: field.string() } }) },
});
const element = (id: string) => {
	const found = document.getElementById(id);
	if (found === null) throw new Error(`Missing #${id}`);
	return found;
};
const text = element('editor') as HTMLTextAreaElement;
let failNext = false;
let holdBranch = false;
let releaseBranch: (() => void) | undefined;
/** Gate the actual OPFS ref stream after objects and the candidate tree exist. */
function directory(
	handle: FileSystemDirectoryHandle,
	path = '',
): FileSystemDirectoryHandle {
	return new Proxy(handle, {
		get(target, key) {
			if (key === 'getDirectoryHandle')
				return async (name: string, options?: FileSystemGetDirectoryOptions) =>
					directory(
						await target.getDirectoryHandle(name, options),
						`${path}/${name}`,
					);
			if (key === 'getFileHandle')
				return async (name: string, options?: FileSystemGetFileOptions) => {
					const file = await target.getFileHandle(name, options);
					if (!`${path}/${name}`.endsWith('/.git/refs/heads/main')) return file;
					return new Proxy(file, {
						get(source, property) {
							if (property === 'createWritable')
								return async (options?: FileSystemCreateWritableOptions) => {
									const stream = await source.createWritable(options);
									return new Proxy(stream, {
										get(writer, method) {
											if (method === 'close')
												return async () => {
													if (holdBranch) {
														holdBranch = false;
														element('gate').textContent =
															'Commit held at branch publication';
														await new Promise<void>((resolve) => {
															releaseBranch = resolve;
														});
														releaseBranch = undefined;
													}
													await writer.close();
												};
											const value = Reflect.get(writer, method, writer);
											return typeof value === 'function'
												? value.bind(writer)
												: value;
										},
									});
								};
							const value = Reflect.get(source, property, source);
							return typeof value === 'function' ? value.bind(source) : value;
						},
					});
				};
			const value = Reflect.get(target, key, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}
const locks: OpfsLocks = {
	request(name, options, work) {
		if (name === gitLock && failNext) {
			failNext = false;
			return Promise.reject(new Error('Controlled Git admission failure'));
		}
		return (navigator.locks as unknown as OpfsLocks).request(
			name,
			options,
			work,
		);
	},
};
const opened = await openFolder({
	id,
	definition,
	browser: {
		scope: { channel: 'development' },
		opfs: {
			getDirectory: async () =>
				directory(
					await navigator.storage.getDirectory(),
				) as unknown as OpfsDirectoryHandle,
			locks,
			BroadcastChannel,
		},
	},
});
if (opened.error) throw new Error(opened.error.message);
const folder = opened.data;
const existing = await folder.files.read('notes/note.md');
if (existing.error?.name === 'NotFound')
	await folder.files.create(
		'notes/note.md',
		'---\ntitle: Disposable note\n---\nInitial text.\n',
	);
const acquired = await folder.tables.notes.edit('note');
if (acquired.error) throw new Error(acquired.error.message);
const editor = acquired.data;
const current = await folder.files.read('notes/note.md');
if (current.error) throw new Error(current.error.message);
text.value = new TextDecoder().decode(current.data.bytes);
text.oninput = () => editor.setText(text.value);
const showSave = () => {
	element('save').textContent = `Save: ${editor.get().save.status}`;
};
editor.subscribe(showSave);
showSave();
folder.git.subscribe((snapshot) => {
	element('activity').textContent = JSON.stringify(
		{
			active: snapshot.activity.commit.active,
			lastCommit: snapshot.lastCommit,
		},
		null,
		2,
	);
});
let release: (() => void) | undefined;
element('hold').onclick = () => {
	if (release) return;
	void navigator.locks.request(gitLock, async () => {
		element('gate').textContent = 'Git protection held';
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		release = undefined;
		element('gate').textContent = 'Git protection available';
	});
};
element('release').onclick = () => release?.();
element('failure').onclick = () => {
	failNext = true;
	element('gate').textContent = 'Next Git admission will fail once';
};
element('hold-branch').onclick = () => {
	holdBranch = true;
	element('gate').textContent = 'Next branch publication will wait';
};
element('release-branch').onclick = () => {
	releaseBranch?.();
	element('gate').textContent = 'Branch publication released';
};
element('checkpoint').onclick = () =>
	void folder.git.commit().then((outcome) => {
		element('gate').textContent = `Explicit checkpoint: ${outcome.status}`;
	});
element('close').onclick = async () => {
	await editor.flush();
	await folder.close();
	text.disabled = true;
	element('gate').textContent = 'Folder closed; reload to reopen';
};

async function inspect() {
	await editor.flush();
	const saved = await folder.files.read('notes/note.md');
	element('saved').textContent = saved.error
		? saved.error.message
		: new TextDecoder().decode(saved.data.bytes);
	const logged = await folder.git.log(8);
	if (logged.error) throw new Error(logged.error.message);
	element('history').textContent = logged.data
		.map((commit) => `${commit.oid} ${commit.message}`)
		.join('\n');
	const head = logged.data[0]?.oid;
	if (!head) {
		element('committed').textContent = '(no commits)';
		return;
	}
	let root = await navigator.storage.getDirectory();
	for (const part of ['Epicenter Dev', 'local', id])
		root = await root.getDirectoryHandle(part);
	const store = createOpfsGitStore({
		root: root as unknown as OpfsDirectoryHandle,
		locks,
		filesLock,
		branch: 'main',
		landed: () => {},
	});
	const access = { fs: store.session().fs, gitdir: '/git', cache: {} };
	const entries = await readTreeFiles(access, await commitTree(access, head));
	const entry = entries.get('notes/note.md');
	element('committed').textContent = entry
		? new TextDecoder().decode(await readBlob(access, entry.oid))
		: '(not committed)';
}
element('inspect').onclick = () => void inspect();
await inspect();
