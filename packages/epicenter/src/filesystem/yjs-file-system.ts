import type {
	CpOptions,
	FileContent,
	FsStat,
	IFileSystem,
	MkdirOptions,
	RmOptions,
} from 'just-bash';
import type { ProviderFactory } from '../dynamic/provider-types.js';
import type { TableHelper } from '../static/types.js';

/** Directory entry with type information, mirroring `DirentEntry` from `just-bash` (not re-exported from package root). */
type DirentEntry = {
	name: string;
	isFile: boolean;
	isDirectory: boolean;
	isSymbolicLink: boolean;
};

import { createContentDocStore } from './content-doc-store.js';
import { createFileSystemIndex } from './file-system-index.js';
import {
	getCurrentEntry,
	getEntryMode,
	getTimeline,
	pushBinaryEntry,
	pushTextEntry,
	readEntryAsBuffer,
	readEntryAsString,
} from './timeline-helpers.js';
import type {
	ContentDocStore,
	FileId,
	FileRow,
	FileSystemIndex,
} from './types.js';
import { generateFileId } from './types.js';
import {
	assertUniqueName,
	disambiguateNames,
	fsError,
	validateName,
} from './validation.js';

/**
 * POSIX-like virtual filesystem backed by Yjs CRDTs.
 *
 * File metadata (name, parent, size, timestamps) lives in a `TableHelper<FileRow>`,
 * which is a Y.Map inside the workspace's main Y.Doc. File content lives in
 * per-file Y.Docs managed by a `ContentDocStore`, using a timeline-based storage
 * model (Y.Array of entries) that supports both text (collaborative Y.Text) and
 * binary (atomic Uint8Array) content.
 *
 * Implements the `IFileSystem` interface from `just-bash`, which allows this
 * virtual filesystem to be used as a drop-in backend for shell emulation.
 *
 * **No symlinks** — `symlink`, `link`, and `readlink` always throw ENOSYS.
 * **Soft deletes** — `rm` sets `trashedAt` rather than destroying rows.
 * **No real permissions** — `chmod` is a validated no-op.
 */
export class YjsFileSystem implements IFileSystem {
	private index: FileSystemIndex & { destroy(): void };
	private store: ContentDocStore;

	constructor(
		private filesTable: TableHelper<FileRow>,
		private cwd: string = '/',
		options?: { providers?: ProviderFactory[] },
	) {
		this.index = createFileSystemIndex(filesTable);
		this.store = createContentDocStore(options?.providers);
	}

	/** Tear down reactive indexes and release all content docs. */
	async destroy(): Promise<void> {
		this.index.destroy();
		await this.store.destroyAll();
	}

	// ═══════════════════════════════════════════════════════════════════════
	// READS — metadata only (fast, no content doc loaded)
	// ═══════════════════════════════════════════════════════════════════════

	async readdir(path: string): Promise<string[]> {
		const resolved = YjsFileSystem.posixResolve(this.cwd, path);
		const id = this.resolveId(resolved);
		this.assertDirectory(id, resolved);
		const childIds = this.index.childrenOf.get(id) ?? [];
		const activeChildren = this.getActiveChildren(childIds);
		const displayNames = disambiguateNames(activeChildren);
		return activeChildren.map((row) => displayNames.get(row.id)!).sort();
	}

	async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
		const resolved = YjsFileSystem.posixResolve(this.cwd, path);
		const id = this.resolveId(resolved);
		this.assertDirectory(id, resolved);
		const childIds = this.index.childrenOf.get(id) ?? [];
		const activeChildren = this.getActiveChildren(childIds);
		const displayNames = disambiguateNames(activeChildren);
		return activeChildren
			.map((row) => ({
				name: displayNames.get(row.id)!,
				isFile: row.type === 'file',
				isDirectory: row.type === 'folder',
				isSymbolicLink: false,
			}))
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	}

	async stat(path: string): Promise<FsStat> {
		const resolved = YjsFileSystem.posixResolve(this.cwd, path);
		if (resolved === '/') {
			return {
				isFile: false,
				isDirectory: true,
				isSymbolicLink: false,
				size: 0,
				mtime: new Date(0),
				mode: 0o755,
			};
		}
		const id = this.resolveId(resolved)!;
		const row = this.getRow(id, resolved);
		return {
			isFile: row.type === 'file',
			isDirectory: row.type === 'folder',
			isSymbolicLink: false,
			size: row.size,
			mtime: new Date(row.updatedAt),
			mode: row.type === 'folder' ? 0o755 : 0o644,
		};
	}

	async lstat(path: string): Promise<FsStat> {
		// No symlinks — lstat is identical to stat
		return this.stat(path);
	}

	async exists(path: string): Promise<boolean> {
		const resolved = YjsFileSystem.posixResolve(this.cwd, path);
		return resolved === '/' || this.index.pathToId.has(resolved);
	}

	// ═══════════════════════════════════════════════════════════════════════
	// READS — content (may load a per-file content doc)
	// ═══════════════════════════════════════════════════════════════════════

	async readFile(
		path: string,
		_options?: { encoding?: string | null } | string,
	): Promise<string> {
		const resolved = YjsFileSystem.posixResolve(this.cwd, path);
		const id = this.resolveId(resolved)!;
		const row = this.getRow(id, resolved);
		if (row.type === 'folder') throw fsError('EISDIR', resolved);

		const ydoc = await this.store.ensure(id);
		const entry = getCurrentEntry(getTimeline(ydoc));
		if (!entry) return '';
		return readEntryAsString(entry);
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		const resolved = YjsFileSystem.posixResolve(this.cwd, path);
		const id = this.resolveId(resolved)!;
		const row = this.getRow(id, resolved);
		if (row.type === 'folder') throw fsError('EISDIR', resolved);

		const ydoc = await this.store.ensure(id);
		const entry = getCurrentEntry(getTimeline(ydoc));
		if (!entry) return new Uint8Array();
		return readEntryAsBuffer(entry);
	}

	// ═══════════════════════════════════════════════════════════════════════
	// WRITES
	// ═══════════════════════════════════════════════════════════════════════

	async writeFile(
		path: string,
		data: FileContent,
		_options?: { encoding?: string } | string,
	): Promise<void> {
		const resolved = YjsFileSystem.posixResolve(this.cwd, path);
		const size =
			typeof data === 'string'
				? new TextEncoder().encode(data).byteLength
				: data.byteLength;
		let id = this.index.pathToId.get(resolved);

		if (id) {
			const row = this.getRow(id, resolved);
			if (row.type === 'folder') throw fsError('EISDIR', resolved);
		}

		if (!id) {
			const { parentId, name } = this.parsePath(resolved);
			validateName(name);
			assertUniqueName(this.filesTable, this.index.childrenOf, parentId, name);
			id = generateFileId();
			this.filesTable.set({
				id,
				name,
				parentId,
				type: 'file',
				size,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				trashedAt: null,
			});
		}

		const ydoc = await this.store.ensure(id);
		const timeline = getTimeline(ydoc);
		const current = getCurrentEntry(timeline);

		if (typeof data === 'string') {
			if (current && getEntryMode(current) === 'text') {
				// Same-mode text: edit existing Y.Text in place (timeline doesn't grow)
				const ytext = current.get('content') as import('yjs').Text;
				ydoc.transact(() => {
					ytext.delete(0, ytext.length);
					ytext.insert(0, data);
				});
			} else {
				// Mode switch or first write: push new text entry
				ydoc.transact(() => pushTextEntry(timeline, data));
			}
		} else {
			// Binary: always push new entry (atomic, no CRDT merge)
			ydoc.transact(() => pushBinaryEntry(timeline, data));
		}

		this.filesTable.update(id, { size, updatedAt: Date.now() });
	}

	async appendFile(
		path: string,
		data: FileContent,
		_options?: { encoding?: string } | string,
	): Promise<void> {
		const resolved = YjsFileSystem.posixResolve(this.cwd, path);
		const content =
			typeof data === 'string' ? data : new TextDecoder().decode(data);
		const id = this.index.pathToId.get(resolved);
		if (!id) return this.writeFile(resolved, data, _options);

		const row = this.getRow(id, resolved);
		if (row.type === 'folder') throw fsError('EISDIR', resolved);

		const ydoc = await this.store.ensure(id);
		const timeline = getTimeline(ydoc);
		const current = getCurrentEntry(timeline);

		if (current && getEntryMode(current) === 'text') {
			// Incremental append to existing Y.Text
			const ytext = current.get('content') as import('yjs').Text;
			ydoc.transact(() => ytext.insert(ytext.length, content));
		} else if (current && getEntryMode(current) === 'binary') {
			// Binary entry: decode existing, concat, push new text entry
			const existing = new TextDecoder().decode(
				current.get('content') as Uint8Array,
			);
			ydoc.transact(() => pushTextEntry(timeline, existing + content));
		} else {
			// No current entry: same as writeFile
			await this.writeFile(path, data);
			return;
		}

		// Size from current entry's full content
		const updatedEntry = getCurrentEntry(timeline)!;
		const newSize =
			getEntryMode(updatedEntry) === 'text'
				? new TextEncoder().encode(
						(updatedEntry.get('content') as import('yjs').Text).toString(),
					).byteLength
				: (updatedEntry.get('content') as Uint8Array).byteLength;
		this.filesTable.update(id, { size: newSize, updatedAt: Date.now() });
	}

	// ═══════════════════════════════════════════════════════════════════════
	// STRUCTURE — mkdir, rm, cp, mv
	// ═══════════════════════════════════════════════════════════════════════

	async mkdir(path: string, options?: MkdirOptions): Promise<void> {
		const resolved = YjsFileSystem.posixResolve(this.cwd, path);
		if (await this.exists(resolved)) {
			const existingId = this.index.pathToId.get(resolved);
			if (existingId) {
				const row = this.getRow(existingId, resolved);
				if (row.type === 'file') throw fsError('EEXIST', resolved);
			}
			return; // existing directory — no-op
		}

		if (options?.recursive) {
			// Create all missing ancestors from root down
			const parts = resolved.split('/').filter(Boolean);
			let currentPath = '';
			for (const part of parts) {
				currentPath += '/' + part;
				if (await this.exists(currentPath)) {
					const existingId = this.index.pathToId.get(currentPath);
					if (existingId) {
						const existingRow = this.getRow(existingId, currentPath);
						if (existingRow.type === 'file')
							throw fsError('ENOTDIR', currentPath);
					}
					continue;
				}
				validateName(part);
				const { parentId } = this.parsePath(currentPath);
				assertUniqueName(
					this.filesTable,
					this.index.childrenOf,
					parentId,
					part,
				);
				this.filesTable.set({
					id: generateFileId(),
					name: part,
					parentId,
					type: 'folder',
					size: 0,
					createdAt: Date.now(),
					updatedAt: Date.now(),
					trashedAt: null,
				});
			}
		} else {
			const { parentId, name } = this.parsePath(resolved);
			validateName(name);
			assertUniqueName(this.filesTable, this.index.childrenOf, parentId, name);
			this.filesTable.set({
				id: generateFileId(),
				name,
				parentId,
				type: 'folder',
				size: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				trashedAt: null,
			});
		}
	}

	async rm(path: string, options?: RmOptions): Promise<void> {
		const resolved = YjsFileSystem.posixResolve(this.cwd, path);
		const id = this.index.pathToId.get(resolved);
		if (!id) {
			if (options?.force) return;
			throw fsError('ENOENT', resolved);
		}
		const row = this.getRow(id, resolved);

		if (row.type === 'folder' && !options?.recursive) {
			const children = this.index.childrenOf.get(id) ?? [];
			const activeChildren = this.getActiveChildren(children);
			if (activeChildren.length > 0) throw fsError('ENOTEMPTY', resolved);
		}

		// Soft delete
		this.filesTable.update(id, { trashedAt: Date.now() });
		await this.store.destroy(id);

		// If recursive, soft-delete children too
		if (row.type === 'folder' && options?.recursive) {
			await this.softDeleteDescendants(id);
		}
	}

	async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
		const resolvedSrc = YjsFileSystem.posixResolve(this.cwd, src);
		const resolvedDest = YjsFileSystem.posixResolve(this.cwd, dest);
		const srcId = this.resolveId(resolvedSrc);
		if (srcId === null) throw fsError('EISDIR', resolvedSrc);
		const srcRow = this.getRow(srcId, resolvedSrc);

		if (srcRow.type === 'folder') {
			if (!options?.recursive) throw fsError('EISDIR', resolvedSrc);
			await this.mkdir(resolvedDest, { recursive: true });
			const children = await this.readdir(resolvedSrc);
			for (const child of children) {
				await this.cp(
					`${resolvedSrc}/${child}`,
					`${resolvedDest}/${child}`,
					options,
				);
			}
		} else {
			// Read from source timeline entry, write via writeFile
			const srcDoc = await this.store.ensure(srcId);
			const entry = getCurrentEntry(getTimeline(srcDoc));
			if (!entry) {
				await this.writeFile(resolvedDest, '');
			} else if (getEntryMode(entry) === 'binary') {
				await this.writeFile(resolvedDest, entry.get('content') as Uint8Array);
			} else {
				await this.writeFile(resolvedDest, readEntryAsString(entry));
			}
		}
	}

	async mv(src: string, dest: string): Promise<void> {
		const resolvedSrc = YjsFileSystem.posixResolve(this.cwd, src);
		const resolvedDest = YjsFileSystem.posixResolve(this.cwd, dest);
		const id = this.resolveId(resolvedSrc);
		if (id === null) throw fsError('EISDIR', resolvedSrc);
		this.getRow(id, resolvedSrc); // validate exists
		const { parentId: newParentId, name: newName } =
			this.parsePath(resolvedDest);
		validateName(newName);
		assertUniqueName(
			this.filesTable,
			this.index.childrenOf,
			newParentId,
			newName,
			id,
		);

		this.filesTable.update(id, {
			name: newName,
			parentId: newParentId,
			updatedAt: Date.now(),
		});
	}

	// ═══════════════════════════════════════════════════════════════════════
	// PATH RESOLUTION
	// ═══════════════════════════════════════════════════════════════════════

	resolvePath(base: string, path: string): string {
		return YjsFileSystem.posixResolve(base, path);
	}

	async realpath(path: string): Promise<string> {
		const resolved = YjsFileSystem.posixResolve(this.cwd, path);
		if (!(await this.exists(resolved))) throw fsError('ENOENT', resolved);
		return resolved;
	}

	getAllPaths(): string[] {
		return Array.from(this.index.pathToId.keys());
	}

	// ═══════════════════════════════════════════════════════════════════════
	// PERMISSIONS / TIMESTAMPS — no-op in a collaborative system
	// ═══════════════════════════════════════════════════════════════════════

	async chmod(path: string, _mode: number): Promise<void> {
		const resolved = YjsFileSystem.posixResolve(this.cwd, path);
		this.resolveId(resolved); // throws ENOENT if doesn't exist
	}

	async utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
		const resolved = YjsFileSystem.posixResolve(this.cwd, path);
		const id = this.resolveId(resolved);
		if (id === null) return; // root has no metadata to update
		this.filesTable.update(id, { updatedAt: mtime.getTime() });
	}

	// ═══════════════════════════════════════════════════════════════════════
	// SYMLINKS / LINKS — not supported (always throws ENOSYS)
	// ═══════════════════════════════════════════════════════════════════════

	async symlink(): Promise<void> {
		throw fsError('ENOSYS', 'symlinks not supported');
	}

	async link(): Promise<void> {
		throw fsError('ENOSYS', 'hard links not supported');
	}

	async readlink(): Promise<string> {
		throw fsError('ENOSYS', 'symlinks not supported');
	}

	// ═══════════════════════════════════════════════════════════════════════
	// PRIVATE — path & ID resolution
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Resolve a POSIX-style path the same way `path.resolve` does in Node:
	 * absolute paths are used as-is, relative paths are joined onto `base`,
	 * and `.` / `..` segments are normalized away.
	 */
	private static posixResolve(base: string, path: string): string {
		const resolved = path.startsWith('/')
			? path
			: base.replace(/\/$/, '') + '/' + path;
		const parts = resolved.split('/');
		const stack: string[] = [];
		for (const part of parts) {
			if (part === '' || part === '.') continue;
			if (part === '..') {
				stack.pop();
			} else {
				stack.push(part);
			}
		}
		return '/' + stack.join('/');
	}

	/**
	 * Look up the `FileId` for a resolved absolute path.
	 * Returns `null` for the root path `/` (which has no table row).
	 * @throws ENOENT if the path doesn't exist in the index.
	 */
	private resolveId(path: string): FileId | null {
		if (path === '/') return null;
		const id = this.index.pathToId.get(path);
		if (!id) throw fsError('ENOENT', path);
		return id;
	}

	/**
	 * Fetch the `FileRow` for a given ID, throwing ENOENT if it's been
	 * deleted or is otherwise invalid.
	 */
	private getRow(id: FileId, path: string): FileRow {
		const result = this.filesTable.get(id);
		if (result.status !== 'valid') throw fsError('ENOENT', path);
		return result.row;
	}

	/**
	 * Split an absolute path into its parent ID and base name.
	 * @throws ENOENT if the parent directory doesn't exist.
	 */
	private parsePath(path: string): { parentId: FileId | null; name: string } {
		const normalized = YjsFileSystem.posixResolve(this.cwd, path);
		const lastSlash = normalized.lastIndexOf('/');
		const name = normalized.substring(lastSlash + 1);
		const parentPath = normalized.substring(0, lastSlash) || '/';
		if (parentPath === '/') return { parentId: null, name };
		const parentId = this.index.pathToId.get(parentPath);
		if (!parentId) throw fsError('ENOENT', parentPath);
		return { parentId, name };
	}

	// ═══════════════════════════════════════════════════════════════════════
	// PRIVATE — tree queries
	// ═══════════════════════════════════════════════════════════════════════

	/** Assert that a resolved ID points to a directory (root `/` always passes). */
	private assertDirectory(id: FileId | null, path: string): void {
		if (id === null) return;
		const row = this.getRow(id, path);
		if (row.type !== 'folder') throw fsError('ENOTDIR', path);
	}

	/** Filter a list of child IDs down to non-trashed, valid rows. */
	private getActiveChildren(childIds: FileId[]): FileRow[] {
		const rows: FileRow[] = [];
		for (const cid of childIds) {
			const result = this.filesTable.get(cid);
			if (result.status === 'valid' && result.row.trashedAt === null) {
				rows.push(result.row);
			}
		}
		return rows;
	}

	/** Recursively soft-delete all descendants of a folder. */
	private async softDeleteDescendants(parentId: FileId): Promise<void> {
		const children = this.index.childrenOf.get(parentId) ?? [];
		for (const cid of children) {
			const result = this.filesTable.get(cid);
			if (result.status !== 'valid' || result.row.trashedAt !== null) continue;
			this.filesTable.update(cid, { trashedAt: Date.now() });
			await this.store.destroy(cid);
			if (result.row.type === 'folder') {
				await this.softDeleteDescendants(cid);
			}
		}
	}
}
