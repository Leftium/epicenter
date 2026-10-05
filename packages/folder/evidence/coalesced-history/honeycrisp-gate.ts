/** Read-only actual-app inspection; the gate is Honeycrisp's real Git Web Lock. */
import { ensureBufferGlobal } from '../../src/buffer-global.js';
import {
	commitTree,
	logCommits,
	readBlob,
	readTreeFiles,
	type TreeFile,
} from '../../src/git/objects.js';
import { createOpfsGitStore } from '../../src/git/opfs-git.js';
import type { OpfsDirectoryHandle, OpfsLocks } from '../../src/opfs-store.js';

const id = 'so.epicenter.honeycrisp';
const address = JSON.stringify(['release', 'local', null, id]);
const gitLock = `epicenter-folder-opfs-git:${address}`;
const filesLock = `epicenter-folder-opfs-files:${address}`;
const element = (id: string) => {
	const found = document.getElementById(id);
	if (found === null) throw new Error(`Missing #${id}`);
	return found;
};
ensureBufferGlobal();
let release: (() => void) | undefined;
element('hold').onclick = () => {
	if (release) return;
	void navigator.locks.request(gitLock, async () => {
		element('state').textContent = 'Honeycrisp Git held';
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		release = undefined;
		element('state').textContent = 'Honeycrisp Git available';
	});
};
element('release').onclick = () => release?.();
async function inspect() {
	let root = await navigator.storage.getDirectory();
	for (const part of ['Epicenter', 'local', id])
		root = await root.getDirectoryHandle(part);
	const store = createOpfsGitStore({
		root: root as unknown as OpfsDirectoryHandle,
		locks: navigator.locks as unknown as OpfsLocks,
		filesLock,
		branch: 'main',
		landed: () => {},
	});
	const access = { fs: store.session().fs, gitdir: '/git', cache: {} };
	const ref = await store.readPrivate('/git/refs/heads/main');
	const head = ref ? new TextDecoder().decode(ref).trim() : undefined;
	const committed = head
		? await readTreeFiles(access, await commitTree(access, head))
		: new Map<string, TreeFile>();
	const notes = await root.getDirectoryHandle('notes');
	const lines = [`HEAD: ${head ?? '(none)'}`];
	for await (const file of (notes as unknown as OpfsDirectoryHandle).values()) {
		if (file.kind !== 'file') continue;
		const name = file.name;
		const saved = new TextDecoder().decode(
			await (await file.getFile()).arrayBuffer(),
		);
		const entry = committed.get(`notes/${name}`);
		const recorded = entry
			? new TextDecoder().decode(await readBlob(access, entry.oid))
			: '(not committed)';
		lines.push(`${name}\nSaved:\n${saved}\nCommitted:\n${recorded}`);
	}
	if (head)
		lines.push(
			'History:',
			...(await logCommits(access, head, 8)).map(
				(commit) => `${commit.oid} ${commit.message}`,
			),
		);
	element('notes').textContent = lines.join('\n\n');
}
element('inspect').onclick = () => void inspect();
await inspect();
