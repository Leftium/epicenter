/**
 * Test helper: an in-memory origin private file system.
 *
 * It models the parts of OPFS a folder relies on, as Chromium documents them:
 * handles name a path, a writable stream publishes its bytes only when it
 * closes, a `File` from `getFile` refuses to read once its file changed, and
 * names of the wrong kind raise `TypeMismatchError`. `faults` interrupts a
 * close or a removal at a chosen path. Passing here does not show that a
 * browser behaves this way; `evidence/opfs` runs the same checks in one.
 */

import type { IndexedDbEnvironment } from './browser-store.js';
import type {
	OpfsDirectoryHandle,
	OpfsEnvironment,
	OpfsFile,
	OpfsFileHandle,
	OpfsLocks,
	OpfsWritable,
} from './opfs-store.js';

type FileNode = {
	kind: 'file';
	bytes: Uint8Array;
	version: number;
	lastModified: number;
};
type DirectoryNode = { kind: 'directory'; children: Map<string, Node> };
type Node = FileNode | DirectoryNode;

/** What an interrupted close does instead of publishing normally. */
export type CloseFault =
	/** Throw before publishing: the old bytes stay. */
	| 'fail'
	/** Publish, then throw: the caller cannot tell from the call. */
	| 'lost'
	/** Publish these bytes instead, then throw: a third writer won. */
	| { readonly publish: Uint8Array };

export type Faults = {
	/** Asked before every write to a stream; `'fail'` throws before anything is published. */
	write?: (path: string) => 'fail' | undefined;
	/** Asked before every close, with the file's path from the origin root. */
	close?: (path: string) => CloseFault | undefined;
	/** Asked before every removal; `'fail'` refuses it. */
	remove?: (path: string) => 'fail' | undefined;
};

const fail = (name: string, message: string) => new DOMException(message, name);

function checkName(name: string) {
	if (name === '' || name === '.' || name === '..' || /[/\\]/.test(name))
		throw new TypeError(`Name is not allowed: ${name}`);
}

export type MemoryOpfs = {
	readonly faults: Faults;
	getDirectory(): Promise<OpfsDirectoryHandle>;
	/** Every file below `prefix`, by path relative to it, `.git` included. */
	files(prefix?: string): Map<string, Uint8Array>;
	/** Every directory below `prefix`, relative to it. */
	directories(prefix?: string): string[];
	/** Write bytes as an uncooperative writer would: no lock, no checks. */
	put(path: string, bytes: Uint8Array): void;
	/** Remove a file or directory as an uncooperative writer would. */
	drop(path: string): void;
};

export function memoryOpfs(): MemoryOpfs {
	const root: DirectoryNode = { kind: 'directory', children: new Map() };
	const faults: Faults = {};
	let clock = 0;

	function resolve(path: readonly string[]): Node | undefined {
		let node: Node = root;
		for (const segment of path) {
			if (node.kind !== 'directory') return undefined;
			const next: Node | undefined = node.children.get(segment);
			if (next === undefined) return undefined;
			node = next;
		}
		return node;
	}

	function directoryAt(path: readonly string[]): DirectoryNode {
		const node = resolve(path);
		if (node === undefined)
			throw fail('NotFoundError', `${path.join('/')} was not found`);
		if (node.kind !== 'directory')
			throw fail('TypeMismatchError', `${path.join('/')} is not a directory`);
		return node;
	}

	function fileAt(path: readonly string[]): FileNode {
		const node = resolve(path);
		if (node === undefined)
			throw fail('NotFoundError', `${path.join('/')} was not found`);
		if (node.kind !== 'file')
			throw fail('TypeMismatchError', `${path.join('/')} is not a file`);
		return node;
	}

	function fileHandle(path: readonly string[]): OpfsFileHandle {
		return {
			kind: 'file',
			name: path.at(-1)!,
			async getFile(): Promise<OpfsFile & { lastModified: number }> {
				const node = fileAt(path);
				const { version, bytes, lastModified } = node;
				return {
					size: bytes.byteLength,
					lastModified,
					async arrayBuffer() {
						const now = resolve(path);
						if (now !== node || node.version !== version)
							throw fail(
								'NotReadableError',
								'The file changed after this snapshot was taken',
							);
						return bytes.slice().buffer as ArrayBuffer;
					},
				};
			},
			async createWritable(options) {
				const node = fileAt(path);
				let buffer = options?.keepExistingData
					? node.bytes.slice()
					: new Uint8Array();
				let done = false;
				const publish = (bytes: Uint8Array) => {
					const target = fileAt(path);
					target.bytes = bytes;
					target.version++;
					target.lastModified = Math.max(Date.now(), ++clock);
				};
				const writable: OpfsWritable = {
					async write(data) {
						if (done) throw new TypeError('The stream is closed');
						if (faults.write?.(path.join('/')) === 'fail')
							throw fail('QuotaExceededError', 'Injected write failure');
						const next = new Uint8Array(buffer.byteLength + data.byteLength);
						next.set(buffer);
						next.set(data, buffer.byteLength);
						buffer = next;
					},
					async close() {
						if (done) throw new TypeError('The stream is closed');
						done = true;
						const fault = faults.close?.(path.join('/'));
						if (fault === 'fail')
							throw fail('InvalidStateError', 'Injected close failure');
						if (fault === 'lost') {
							publish(buffer);
							throw fail('AbortError', 'Injected lost close reply');
						}
						if (fault !== undefined) {
							publish(fault.publish.slice());
							throw fail('AbortError', 'Injected close with other bytes');
						}
						publish(buffer);
					},
					async abort() {
						done = true;
					},
				};
				return writable;
			},
		};
	}

	function directoryHandle(path: readonly string[]): OpfsDirectoryHandle {
		return {
			kind: 'directory',
			name: path.at(-1) ?? '',
			async getDirectoryHandle(name, options) {
				checkName(name);
				const directory = directoryAt(path);
				const existing = directory.children.get(name);
				if (existing?.kind === 'file')
					throw fail('TypeMismatchError', `${name} is a file`);
				if (existing === undefined) {
					if (!options?.create)
						throw fail('NotFoundError', `${name} was not found`);
					directory.children.set(name, {
						kind: 'directory',
						children: new Map(),
					});
				}
				return directoryHandle([...path, name]);
			},
			async getFileHandle(name, options) {
				checkName(name);
				const directory = directoryAt(path);
				const existing = directory.children.get(name);
				if (existing?.kind === 'directory')
					throw fail('TypeMismatchError', `${name} is a directory`);
				if (existing === undefined) {
					if (!options?.create)
						throw fail('NotFoundError', `${name} was not found`);
					directory.children.set(name, {
						kind: 'file',
						bytes: new Uint8Array(),
						version: 0,
						lastModified: Math.max(Date.now(), ++clock),
					});
				}
				return fileHandle([...path, name]);
			},
			async removeEntry(name, options) {
				checkName(name);
				const directory = directoryAt(path);
				const existing = directory.children.get(name);
				if (existing === undefined)
					throw fail('NotFoundError', `${name} was not found`);
				if (faults.remove?.([...path, name].join('/')) === 'fail')
					throw fail('InvalidStateError', 'Injected removal failure');
				if (
					existing.kind === 'directory' &&
					existing.children.size > 0 &&
					!options?.recursive
				)
					throw fail('InvalidModificationError', `${name} is not empty`);
				directory.children.delete(name);
			},
			async *values() {
				const directory = directoryAt(path);
				for (const [name, node] of [...directory.children]) {
					if (directory.children.get(name) !== node) continue;
					yield node.kind === 'file'
						? fileHandle([...path, name])
						: directoryHandle([...path, name]);
				}
			},
		};
	}

	const split = (path: string) => path.split('/').filter((part) => part !== '');

	function list(prefix: string) {
		const files = new Map<string, Uint8Array>();
		const directories: string[] = [];
		const start = resolve(split(prefix));
		function visit(node: Node, at: string) {
			if (node.kind === 'file') {
				files.set(at, node.bytes.slice());
				return;
			}
			if (at !== '') directories.push(at);
			for (const [name, child] of node.children)
				visit(child, at === '' ? name : `${at}/${name}`);
		}
		if (start !== undefined) visit(start, '');
		return { files, directories: directories.sort() };
	}

	return {
		faults,
		getDirectory: async () => directoryHandle([]),
		files: (prefix = '') => list(prefix).files,
		directories: (prefix = '') => list(prefix).directories,
		put(path, bytes) {
			const parts = split(path);
			let directory = root;
			for (const part of parts.slice(0, -1)) {
				let next = directory.children.get(part);
				if (next === undefined) {
					next = { kind: 'directory', children: new Map() };
					directory.children.set(part, next);
				}
				if (next.kind !== 'directory') throw new Error(`${part} is a file`);
				directory = next;
			}
			const name = parts.at(-1)!;
			const existing = directory.children.get(name);
			if (existing?.kind === 'file') {
				existing.bytes = bytes.slice();
				existing.version++;
			} else
				directory.children.set(name, {
					kind: 'file',
					bytes: bytes.slice(),
					version: 0,
					lastModified: Math.max(Date.now(), ++clock),
				});
		},
		drop(path) {
			const parts = split(path);
			const parent = resolve(parts.slice(0, -1));
			if (parent?.kind === 'directory') parent.children.delete(parts.at(-1)!);
		},
	};
}

/**
 * An environment over `opfs` and `indexedDb` whose locks are whatever
 * `navigator.locks` is when a lock is asked for. Use with `useWebLocks()`.
 */
export function opfsEnvironment(
	opfs: MemoryOpfs,
	indexedDb: IndexedDbEnvironment,
	options: { BroadcastChannel?: typeof BroadcastChannel } = {},
): OpfsEnvironment {
	const locks: OpfsLocks = {
		request: (name, requestOptions, work) =>
			(globalThis.navigator as unknown as { locks: OpfsLocks }).locks.request(
				name,
				requestOptions,
				work,
			),
	};
	return {
		getDirectory: () => opfs.getDirectory(),
		locks,
		indexedDb,
		BroadcastChannel: options.BroadcastChannel,
	};
}
