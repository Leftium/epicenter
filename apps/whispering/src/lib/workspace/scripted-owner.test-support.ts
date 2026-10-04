/**
 * The desktop shell's folder owner, scripted in memory, for tests that run
 * the production desktop adapter (`@epicenter/folder/tauri`) and everything
 * above it. A test installs `invoke` and `listen` in place of Tauri's with
 * `mock.module`, then opens the folder the way the desktop workspace does.
 *
 * Files live in a map. Each published change is applied as the Rust owner
 * applies one: exclusive creates, conditional replaces and removals, plain
 * overwrites, and moves to an absent path. A test decides when a change is
 * applied (`beforeApply`) and whether its reply is lost after it landed
 * (`loseReplies`): the adapter then sees no reply, which is the owner's
 * answer it reports as unknown. Nothing here is the Rust owner; it is a
 * stand-in for its replies, as `desktop.test.ts` scripts them.
 */
import { createHash } from 'node:crypto';

type Call = Record<string, unknown>;

/** One change as the adapter sends it over the wire. */
export type WireChange =
	| { kind: 'create' | 'overwrite'; path: string; bytes: number[] }
	| { kind: 'replace'; path: string; bytes: number[]; expectedSha256: string }
	| { kind: 'remove'; path: string; expectedSha256?: string | null }
	| { kind: 'move'; from: string; to: string; expectedSha256?: string | null };

const snapshot = () => ({
	pendingIncoming: null,
	branch: 'main',
	remote: null,
	commitOnEdit: true,
	files: { state: 'unknown', error: null },
	sync: { state: 'unknown', error: null },
	activity: Object.fromEntries(
		['scan', 'commit', 'push', 'fetch', 'pull'].map((name) => [
			name,
			{ active: false },
		]),
	),
	lastCommit: null,
	lastPush: null,
	lastFetch: null,
	lastPull: null,
	closed: false,
});

const sha256 = (bytes: Uint8Array) =>
	createHash('sha256').update(bytes).digest('hex');

export function createScriptedOwner(root = '/scripted/whispering') {
	const disk = new Map<string, Uint8Array>();
	/** Every change the owner applied, in order. */
	const applied: WireChange[] = [];
	const control = {
		/** Runs before each change is applied; await in it to hold the change. */
		beforeApply: undefined as ((change: WireChange) => Promise<void>) | undefined,
		/** How many upcoming replies are lost after their change landed. */
		loseReplies: 0,
	};

	/** A refusal the owner answers with: the adapter reads it as the folder's own. */
	const refused = (error: Record<string, unknown>) => {
		throw { name: 'Refused', error };
	};

	function apply(change: WireChange) {
		switch (change.kind) {
			case 'create':
				if (disk.has(change.path)) refused({ name: 'Exists', path: change.path });
				disk.set(change.path, Uint8Array.from(change.bytes));
				return;
			case 'overwrite':
				disk.set(change.path, Uint8Array.from(change.bytes));
				return;
			case 'replace': {
				const now = disk.get(change.path);
				const actual = now === undefined ? null : sha256(now);
				if (actual !== change.expectedSha256)
					refused({
						name: 'Conflict',
						path: change.path,
						expectedSha256: change.expectedSha256,
						actualSha256: actual,
					});
				disk.set(change.path, Uint8Array.from(change.bytes));
				return;
			}
			case 'remove': {
				const now = disk.get(change.path);
				if (now === undefined) refused({ name: 'NotFound', path: change.path });
				else if (change.expectedSha256 && sha256(now) !== change.expectedSha256)
					refused({
						name: 'Conflict',
						path: change.path,
						expectedSha256: change.expectedSha256,
						actualSha256: sha256(now),
					});
				disk.delete(change.path);
				return;
			}
			case 'move': {
				const now = disk.get(change.from);
				if (now === undefined) refused({ name: 'NotFound', path: change.from });
				else if (disk.has(change.to)) refused({ name: 'Exists', path: change.to });
				else if (change.expectedSha256 && sha256(now) !== change.expectedSha256)
					refused({
						name: 'Conflict',
						path: change.from,
						expectedSha256: change.expectedSha256,
						actualSha256: sha256(now),
					});
				else {
					disk.delete(change.from);
					disk.set(change.to, now);
				}
				return;
			}
		}
	}

	const directories = () => {
		const found = new Set<string>();
		for (const path of disk.keys()) {
			const parts = path.split('/').slice(0, -1);
			for (let depth = 1; depth <= parts.length; depth++)
				found.add(parts.slice(0, depth).join('/'));
		}
		return [...found].sort();
	};
	const read = (path: string) => {
		const bytes = disk.get(path);
		if (bytes === undefined) throw { name: 'NotFound', path };
		return { bytes: [...bytes], sha256: sha256(bytes) };
	};

	const replies: Record<string, (args: Call) => unknown> = {
		attach: () => ({ session: 1, root, sequence: 0, snapshot: snapshot() }),
		detach: () => null,
		list: () => ({
			files: [...disk].map(([path, bytes]) => ({ path, size: bytes.length })),
			directories: directories(),
		}),
		children: ({ directory }) => {
			const prefix = directory === '' ? '' : `${directory}/`;
			const below = (path: string) =>
				path.startsWith(prefix) && !path.slice(prefix.length).includes('/');
			return {
				files: [...disk.keys()].filter(below),
				directories: directories().filter(below),
			};
		},
		read: ({ path }) => read(String(path)),
		read_many: ({ paths }) =>
			(paths as string[]).map((path) => {
				try {
					return { status: 'ok', value: read(path) };
				} catch (error) {
					return { status: 'err', error };
				}
			}),
		async apply({ changes }) {
			for (const change of changes as WireChange[]) {
				await control.beforeApply?.(change);
				apply(change);
				applied.push(change);
			}
			if (control.loseReplies > 0) {
				control.loseReplies -= 1;
				throw 'the reply never reached the window';
			}
			return null;
		},
		mkdir: () => null,
		rmdir: () => null,
		status: () => ({ head: null, changes: [] }),
		commit: () => ({ status: 'unchanged', head: null, indexWarning: null }),
	};

	return {
		disk,
		applied,
		control,
		/** The text at `path`, or undefined when there is no file. */
		text(path: string) {
			const bytes = disk.get(path);
			return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
		},
		write(path: string, text: string) {
			disk.set(path, new TextEncoder().encode(text));
		},
		/** In place of Tauri's `invoke`. */
		async invoke(cmd: string, args: Call = {}) {
			const name = cmd.replace('plugin:epicenter-folder|', '');
			const reply = replies[name];
			if (reply === undefined) throw `no scripted reply for ${name}`;
			return reply(args);
		},
		/** In place of Tauri's `listen`: the owner announces nothing here. */
		async listen() {
			return () => {};
		},
	};
}
