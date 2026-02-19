import type { DocumentBinding, TableHelper } from '@epicenter/hq/static';
import type {
	CpOptions,
	FileContent,
	FsStat,
	IFileSystem,
	MkdirOptions,
	RmOptions,
} from 'just-bash';
import {
	type ContentHelpers,
	createContentHelpers,
} from './content-helpers.js';
import { FileTree } from './file-tree.js';
import { posixResolve } from './path-utils.js';
import type { FileRow } from './types.js';
import { disambiguateNames, fsError } from './validation.js';

/**
 * Table helper with a document binding attached via `.withDocument()`.
 * This is the shape that `createWorkspace()` produces for tables with document declarations.
 */
type FilesTableWithDocs = TableHelper<FileRow> & {
	docs: { content: DocumentBinding<FileRow> };
};

/** Directory entry with type information, mirroring `DirentEntry` from `just-bash` (not re-exported from package root). */
type DirentEntry = {
	name: string;
	isFile: boolean;
	isDirectory: boolean;
	isSymbolicLink: boolean;
};

/**
 * POSIX-like virtual filesystem backed by Yjs CRDTs.
 *
 * Thin orchestrator that delegates metadata operations to {@link FileTree}
 * and content I/O to {@link ContentHelpers} (backed by a
 * {@link DocumentBinding}). Every method applies `cwd` via
 * {@link posixResolve}, then calls the appropriate sub-service.
 *
 * Implements the `IFileSystem` interface from `just-bash`, which allows this
 * virtual filesystem to be used as a drop-in backend for shell emulation.
 *
 * **No symlinks** — `symlink`, `link`, and `readlink` always throw ENOSYS.
 * **Soft deletes** — `rm` sets `trashedAt` rather than destroying rows.
 * **No real permissions** — `chmod` is a validated no-op.
 */
export class YjsFileSystem implements IFileSystem {
	constructor(
		private tree: FileTree,
		/** Content I/O operations — exposed for direct content reads/writes by UI layers. */
		readonly content: ContentHelpers,
		private cwd: string = '/',
	) {}

	/** Reactive file-system indexes for path lookups and parent-child queries. */
	get index(): FileTree['index'] {
		return this.tree.index;
	}

	/**
	 * Create a `YjsFileSystem` from a files table that has a document binding.
	 *
	 * The table must have been defined with `.withDocument('content', ...)` so that
	 * `filesTable.docs.content` is available. Content doc lifecycle (creation,
	 * provider wiring, cleanup on row deletion) is handled by the binding automatically.
	 *
	 * @example
	 * ```typescript
	 * const ws = createWorkspace({ id: 'app', tables: { files: filesTable } });
	 * const fs = YjsFileSystem.create(ws.tables.files);
	 * ```
	 */
	static create(filesTable: FilesTableWithDocs, cwd?: string): YjsFileSystem {
		const tree = new FileTree(filesTable);
		const content = createContentHelpers(filesTable.docs.content);
		return new YjsFileSystem(tree, content, cwd);
	}

	/**
	 * Tear down reactive indexes.
	 *
	 * Content doc cleanup is handled by the workspace's document binding
	 * destroy cascade — no need to call `destroyAll()` here.
	 */
	destroy(): void {
		this.tree.destroy();
	}

	// ═══════════════════════════════════════════════════════════════════════
	// READS — metadata only (fast, no content doc loaded)
	// ═══════════════════════════════════════════════════════════════════════

	async readdir(path: string): Promise<string[]> {
		const abs = posixResolve(this.cwd, path);
		const id = this.tree.resolveId(abs);
		this.tree.assertDirectory(id, abs);
		const activeChildren = this.tree.activeChildren(id);
		const displayNames = disambiguateNames(activeChildren);
		return activeChildren.map((row) => displayNames.get(row.id)!).sort();
	}

	async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
		const abs = posixResolve(this.cwd, path);
		const id = this.tree.resolveId(abs);
		this.tree.assertDirectory(id, abs);
		const activeChildren = this.tree.activeChildren(id);
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
		const abs = posixResolve(this.cwd, path);
		if (abs === '/') {
			return {
				isFile: false,
				isDirectory: true,
				isSymbolicLink: false,
				size: 0,
				mtime: new Date(0),
				mode: 0o755,
			};
		}
		const id = this.tree.resolveId(abs)!;
		const row = this.tree.getRow(id, abs);
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
		return this.stat(path);
	}

	async exists(path: string): Promise<boolean> {
		const abs = posixResolve(this.cwd, path);
		return this.tree.exists(abs);
	}

	// ═══════════════════════════════════════════════════════════════════════
	// READS — content (may load a per-file content doc)
	// ═══════════════════════════════════════════════════════════════════════

	async readFile(
		path: string,
		_options?: { encoding?: string | null } | string,
	): Promise<string> {
		const abs = posixResolve(this.cwd, path);
		const id = this.tree.resolveId(abs)!;
		const row = this.tree.getRow(id, abs);
		if (row.type === 'folder') throw fsError('EISDIR', abs);
		return this.content.read(id);
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		const abs = posixResolve(this.cwd, path);
		const id = this.tree.resolveId(abs)!;
		const row = this.tree.getRow(id, abs);
		if (row.type === 'folder') throw fsError('EISDIR', abs);
		return this.content.readBuffer(id);
	}

	// ═══════════════════════════════════════════════════════════════════════
	// WRITES
	// ═══════════════════════════════════════════════════════════════════════

	async writeFile(
		path: string,
		data: FileContent,
		_options?: { encoding?: string } | string,
	): Promise<void> {
		const abs = posixResolve(this.cwd, path);
		let id = this.tree.lookupId(abs);

		if (id) {
			const row = this.tree.getRow(id, abs);
			if (row.type === 'folder') throw fsError('EISDIR', abs);
		}

		if (!id) {
			const { parentId, name } = this.tree.parsePath(abs);
			const size =
				typeof data === 'string'
					? new TextEncoder().encode(data).byteLength
					: data.byteLength;
			id = this.tree.create({ name, parentId, type: 'file', size });
		}

		const size = await this.content.write(id, data);
		this.tree.touch(id, size);
	}

	async appendFile(
		path: string,
		data: FileContent,
		_options?: { encoding?: string } | string,
	): Promise<void> {
		const abs = posixResolve(this.cwd, path);
		const content =
			typeof data === 'string' ? data : new TextDecoder().decode(data);
		const id = this.tree.lookupId(abs);
		if (!id) return this.writeFile(abs, data, _options);

		const row = this.tree.getRow(id, abs);
		if (row.type === 'folder') throw fsError('EISDIR', abs);

		const newSize = await this.content.append(id, content);
		if (newSize === null) {
			await this.writeFile(path, data);
			return;
		}
		this.tree.touch(id, newSize);
	}

	// ═══════════════════════════════════════════════════════════════════════
	// STRUCTURE — mkdir, rm, cp, mv
	// ═══════════════════════════════════════════════════════════════════════

	async mkdir(path: string, options?: MkdirOptions): Promise<void> {
		const abs = posixResolve(this.cwd, path);
		if (this.tree.exists(abs)) {
			const existingId = this.tree.lookupId(abs);
			if (existingId) {
				const row = this.tree.getRow(existingId, abs);
				if (row.type === 'file') throw fsError('EEXIST', abs);
			}
			return;
		}

		if (options?.recursive) {
			const parts = abs.split('/').filter(Boolean);
			let currentPath = '';
			for (const part of parts) {
				currentPath += '/' + part;
				if (this.tree.exists(currentPath)) {
					const existingId = this.tree.lookupId(currentPath);
					if (existingId) {
						const existingRow = this.tree.getRow(existingId, currentPath);
						if (existingRow.type === 'file')
							throw fsError('ENOTDIR', currentPath);
					}
					continue;
				}
				const { parentId } = this.tree.parsePath(currentPath);
				this.tree.create({
					name: part,
					parentId,
					type: 'folder',
					size: 0,
				});
			}
		} else {
			const { parentId, name } = this.tree.parsePath(abs);
			this.tree.create({ name, parentId, type: 'folder', size: 0 });
		}
	}

	async rm(path: string, options?: RmOptions): Promise<void> {
		const abs = posixResolve(this.cwd, path);
		const id = this.tree.lookupId(abs);
		if (!id) {
			if (options?.force) return;
			throw fsError('ENOENT', abs);
		}
		const row = this.tree.getRow(id, abs);

		if (row.type === 'folder' && !options?.recursive) {
			if (this.tree.activeChildren(id).length > 0)
				throw fsError('ENOTEMPTY', abs);
		}

		// Soft-delete the row. The document binding's table observer
		// automatically cleans up the associated content doc.
		this.tree.softDelete(id);

		if (row.type === 'folder' && options?.recursive) {
			for (const did of this.tree.descendantIds(id)) {
				this.tree.softDelete(did);
			}
		}
	}

	async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
		const resolvedSrc = posixResolve(this.cwd, src);
		const resolvedDest = posixResolve(this.cwd, dest);
		const srcId = this.tree.resolveId(resolvedSrc);
		if (srcId === null) throw fsError('EISDIR', resolvedSrc);
		const srcRow = this.tree.getRow(srcId, resolvedSrc);

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
			const srcBuffer = await this.content.readBuffer(srcId);
			const srcText = await this.content.read(srcId);
			if (srcText === '' && srcBuffer.length === 0) {
				await this.writeFile(resolvedDest, '');
			} else {
				// Check if content is binary by comparing text encoding roundtrip
				const textBytes = new TextEncoder().encode(srcText);
				const isBinary =
					srcBuffer.length > 0 &&
					(srcBuffer.length !== textBytes.length ||
						!srcBuffer.every((b, i) => b === textBytes[i]));
				if (isBinary) {
					await this.writeFile(resolvedDest, srcBuffer);
				} else {
					await this.writeFile(resolvedDest, srcText);
				}
			}
		}
	}

	async mv(src: string, dest: string): Promise<void> {
		const resolvedSrc = posixResolve(this.cwd, src);
		const resolvedDest = posixResolve(this.cwd, dest);
		const id = this.tree.resolveId(resolvedSrc);
		if (id === null) throw fsError('EISDIR', resolvedSrc);
		this.tree.getRow(id, resolvedSrc);
		const { parentId: newParentId, name: newName } =
			this.tree.parsePath(resolvedDest);
		this.tree.move(id, newParentId, newName);
	}

	// ═══════════════════════════════════════════════════════════════════════
	// PATH RESOLUTION
	// ═══════════════════════════════════════════════════════════════════════

	resolvePath(base: string, path: string): string {
		return posixResolve(base, path);
	}

	async realpath(path: string): Promise<string> {
		const abs = posixResolve(this.cwd, path);
		if (!(await this.exists(abs))) throw fsError('ENOENT', abs);
		return abs;
	}

	getAllPaths(): string[] {
		return this.tree.allPaths();
	}

	// ═══════════════════════════════════════════════════════════════════════
	// PERMISSIONS / TIMESTAMPS — no-op in a collaborative system
	// ═══════════════════════════════════════════════════════════════════════

	async chmod(path: string, _mode: number): Promise<void> {
		const abs = posixResolve(this.cwd, path);
		this.tree.resolveId(abs);
	}

	async utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
		const abs = posixResolve(this.cwd, path);
		const id = this.tree.resolveId(abs);
		if (id === null) return;
		this.tree.setMtime(id, mtime);
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
}
