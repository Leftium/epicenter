import type { TableHelper } from '../static/types.js';
import { createFileSystemIndex, type FileSystemIndex } from './file-system-index.js';
import { posixResolve } from './path-utils.js';
import type { FileId, FileRow } from './types.js';
import { generateFileId } from './types.js';
import { assertUniqueName, fsError, validateName } from './validation.js';

/**
 * Metadata tree operations for a POSIX-like virtual filesystem.
 *
 * Owns the files table and the derived path/children indexes.
 * All methods work with absolute paths (never sees `cwd`).
 * Has no knowledge of file content — only structure and metadata.
 */
export class FileTree {
	private index: FileSystemIndex;

	constructor(private filesTable: TableHelper<FileRow>) {
		this.index = createFileSystemIndex(filesTable);
	}

	// ═══════════════════════════════════════════════════════════════════════
	// LOOKUPS
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Look up the `FileId` for a resolved absolute path.
	 * Returns `null` for the root path `/` (which has no table row).
	 * @throws ENOENT if the path doesn't exist in the index.
	 */
	resolveId(path: string): FileId | null {
		if (path === '/') return null;
		const id = this.index.pathToId.get(path);
		if (!id) throw fsError('ENOENT', path);
		return id;
	}

	/**
	 * Look up the `FileId` for a path without throwing.
	 * Returns `undefined` if the path doesn't exist.
	 */
	lookupId(path: string): FileId | undefined {
		return this.index.pathToId.get(path);
	}

	/**
	 * Fetch the `FileRow` for a given ID, throwing ENOENT if it's been
	 * deleted or is otherwise invalid.
	 */
	getRow(id: FileId, path: string): FileRow {
		const result = this.filesTable.get(id);
		if (result.status !== 'valid') throw fsError('ENOENT', path);
		return result.row;
	}

	/**
	 * Split an absolute path into its parent ID and base name.
	 * @throws ENOENT if the parent directory doesn't exist.
	 */
	parsePath(path: string): { parentId: FileId | null; name: string } {
		const normalized = posixResolve('/', path);
		const lastSlash = normalized.lastIndexOf('/');
		const name = normalized.substring(lastSlash + 1);
		const parentPath = normalized.substring(0, lastSlash) || '/';
		if (parentPath === '/') return { parentId: null, name };
		const parentId = this.index.pathToId.get(parentPath);
		if (!parentId) throw fsError('ENOENT', parentPath);
		return { parentId, name };
	}

	/** Assert that a resolved ID points to a directory (root `/` always passes). */
	assertDirectory(id: FileId | null, path: string): void {
		if (id === null) return;
		const row = this.getRow(id, path);
		if (row.type !== 'folder') throw fsError('ENOTDIR', path);
	}

	// ═══════════════════════════════════════════════════════════════════════
	// QUERIES
	// ═══════════════════════════════════════════════════════════════════════

	/** Get the child IDs of a parent (null = root). */
	childIds(parentId: FileId | null): FileId[] {
		return this.index.childrenOf.get(parentId) ?? [];
	}

	/** Filter child IDs down to non-trashed, valid rows. */
	activeChildren(parentId: FileId | null): FileRow[] {
		const ids = this.index.childrenOf.get(parentId) ?? [];
		const rows: FileRow[] = [];
		for (const cid of ids) {
			const result = this.filesTable.get(cid);
			if (result.status === 'valid' && result.row.trashedAt === null) {
				rows.push(result.row);
			}
		}
		return rows;
	}

	/**
	 * Collect all active descendant IDs of a folder (recursive).
	 * Returns a flat array of IDs — the caller decides what to do with them.
	 */
	descendantIds(parentId: FileId): FileId[] {
		const result: FileId[] = [];
		const children = this.index.childrenOf.get(parentId) ?? [];
		for (const cid of children) {
			const row = this.filesTable.get(cid);
			if (row.status !== 'valid' || row.row.trashedAt !== null) continue;
			result.push(cid);
			if (row.row.type === 'folder') {
				result.push(...this.descendantIds(cid));
			}
		}
		return result;
	}

	exists(path: string): boolean {
		return path === '/' || this.index.pathToId.has(path);
	}

	allPaths(): string[] {
		return Array.from(this.index.pathToId.keys());
	}

	// ═══════════════════════════════════════════════════════════════════════
	// MUTATIONS
	// ═══════════════════════════════════════════════════════════════════════

	/** Create a new file or folder. Validates name and uniqueness. Returns the new FileId. */
	create(opts: {
		name: string;
		parentId: FileId | null;
		type: 'file' | 'folder';
		size: number;
	}): FileId {
		validateName(opts.name);
		assertUniqueName(
			this.filesTable,
			this.index.childrenOf,
			opts.parentId,
			opts.name,
		);
		const id = generateFileId();
		this.filesTable.set({
			id,
			name: opts.name,
			parentId: opts.parentId,
			type: opts.type,
			size: opts.size,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			trashedAt: null,
		});
		return id;
	}

	/** Soft-delete a file or folder by setting trashedAt. */
	softDelete(id: FileId): void {
		this.filesTable.update(id, { trashedAt: Date.now() });
	}

	/** Move/rename a file or folder. Validates name and uniqueness. */
	move(id: FileId, newParentId: FileId | null, newName: string): void {
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

	/** Update size and updatedAt after a content write. */
	touch(id: FileId, size: number): void {
		this.filesTable.update(id, { size, updatedAt: Date.now() });
	}

	/** Update updatedAt only (for utimes). */
	setMtime(id: FileId, mtime: Date): void {
		this.filesTable.update(id, { updatedAt: mtime.getTime() });
	}

	// ═══════════════════════════════════════════════════════════════════════
	// LIFECYCLE
	// ═══════════════════════════════════════════════════════════════════════

	destroy(): void {
		this.index.destroy();
	}
}
