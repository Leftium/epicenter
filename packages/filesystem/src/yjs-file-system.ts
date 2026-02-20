import type { DocumentBinding, TableHelper } from '@epicenter/hq/static';
import type { IFileSystem } from 'just-bash';
import {
	type ContentHelpers,
	createContentHelpers,
} from './content-helpers.js';
import { FileTree } from './file-tree.js';
import { posixResolve } from './path-utils.js';
import type { FileId, FileRow } from './types.js';
import { disambiguateNames, fsError } from './validation.js';

/**
 * Table helper with a document binding attached via `.withDocument()`.
 * This is the shape that `createWorkspace()` produces for tables with document declarations.
 */
type FilesTableWithDocs = TableHelper<FileRow> & {
	docs: { content: DocumentBinding<FileRow> };
};

/** Validate `fs` extends {@link IFileSystem} while preserving the full inferred type (avoids excess-property errors from `satisfies`). */
function FileSystem<T extends IFileSystem>(fs: T): T {
	return fs;
}

/**
 * Create a POSIX-like virtual filesystem backed by Yjs CRDTs.
 *
 * Thin orchestrator that delegates metadata operations to {@link FileTree}
 * and content I/O to {@link ContentHelpers} (backed by a
 * {@link DocumentBinding}). Every method applies `cwd` via
 * {@link posixResolve}, then calls the appropriate sub-service.
 *
 * The returned object satisfies the `IFileSystem` interface from `just-bash`,
 * which allows this virtual filesystem to be used as a drop-in backend for
 * shell emulation — while also exposing extra members (`content`, `index`,
 * `lookupId`, `destroy`) that aren't part of `IFileSystem`.
 *
 * **No symlinks** — `symlink`, `link`, and `readlink` always throw ENOSYS.
 * **Soft deletes** — `rm` sets `trashedAt` rather than destroying rows.
 * **No real permissions** — `chmod` is a validated no-op.
 *
 * @example
 * ```typescript
 * const ws = createWorkspace({ id: 'app', tables: { files: filesTable } });
 * const fs = createYjsFileSystem(ws.tables.files);
 * ```
 */
export function createYjsFileSystem(
	filesTable: FilesTableWithDocs,
	cwd: string = '/',
) {
	const tree = new FileTree(filesTable);
	const content = createContentHelpers(filesTable.docs.content);

	return FileSystem({
		/** Content I/O operations — exposed for direct content reads/writes by UI layers. */
		content,

		/** Reactive file-system indexes for path lookups and parent-child queries. */
		get index(): FileTree['index'] {
			return tree.index;
		},

		/**
		 * Look up the internal file ID for a resolved absolute path.
		 *
		 * Returns `undefined` if the path doesn't exist. Useful for content-layer
		 * operations that need the ID to open a document binding directly.
		 *
		 * @example
		 * ```typescript
		 * const fileId = fs.lookupId('/docs/readme.md');
		 * if (fileId) {
		 *   const doc = await binding.open(fileId);
		 * }
		 * ```
		 */
		lookupId(path: string): FileId | undefined {
			const abs = posixResolve(cwd, path);
			return tree.lookupId(abs);
		},

		/**
		 * Tear down reactive indexes.
		 *
		 * Content doc cleanup is handled by the workspace's document binding
		 * destroy cascade — no need to call `destroyAll()` here.
		 */
		destroy() {
			tree.destroy();
		},

		// ═══════════════════════════════════════════════════════════════════════
		// READS — metadata only (fast, no content doc loaded)
		// ═══════════════════════════════════════════════════════════════════════

		async readdir(path) {
			const abs = posixResolve(cwd, path);
			const id = tree.resolveId(abs);
			tree.assertDirectory(id, abs);
			const activeChildren = tree.activeChildren(id);
			const displayNames = disambiguateNames(activeChildren);
			return activeChildren.map((row) => displayNames.get(row.id)!).sort();
		},

		async readdirWithFileTypes(path) {
			const abs = posixResolve(cwd, path);
			const id = tree.resolveId(abs);
			tree.assertDirectory(id, abs);
			const activeChildren = tree.activeChildren(id);
			const displayNames = disambiguateNames(activeChildren);
			return activeChildren
				.map((row) => ({
					name: displayNames.get(row.id)!,
					isFile: row.type === 'file',
					isDirectory: row.type === 'folder',
					isSymbolicLink: false,
				}))
				.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		},

		async stat(path) {
			const abs = posixResolve(cwd, path);
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
			const id = tree.resolveId(abs)!;
			const row = tree.getRow(id, abs);
			return {
				isFile: row.type === 'file',
				isDirectory: row.type === 'folder',
				isSymbolicLink: false,
				size: row.size,
				mtime: new Date(row.updatedAt),
				mode: row.type === 'folder' ? 0o755 : 0o644,
			};
		},

		async lstat(path) {
			return this.stat(path);
		},

		async exists(path) {
			const abs = posixResolve(cwd, path);
			return tree.exists(abs);
		},

		// ═══════════════════════════════════════════════════════════════════════
		// READS — content (may load a per-file content doc)
		// ═══════════════════════════════════════════════════════════════════════

		async readFile(path, _options?) {
			const abs = posixResolve(cwd, path);
			const id = tree.resolveId(abs)!;
			const row = tree.getRow(id, abs);
			if (row.type === 'folder') throw fsError('EISDIR', abs);
			return content.read(id);
		},

		async readFileBuffer(path) {
			const abs = posixResolve(cwd, path);
			const id = tree.resolveId(abs)!;
			const row = tree.getRow(id, abs);
			if (row.type === 'folder') throw fsError('EISDIR', abs);
			return content.readBuffer(id);
		},

		// ═══════════════════════════════════════════════════════════════════════
		// WRITES
		// ═══════════════════════════════════════════════════════════════════════

		async writeFile(path, data, _options?) {
			const abs = posixResolve(cwd, path);
			let id = tree.lookupId(abs);

			if (id) {
				const row = tree.getRow(id, abs);
				if (row.type === 'folder') throw fsError('EISDIR', abs);
			}

			if (!id) {
				const { parentId, name } = tree.parsePath(abs);
				const size =
					typeof data === 'string'
						? new TextEncoder().encode(data).byteLength
						: data.byteLength;
				id = tree.create({ name, parentId, type: 'file', size });
			}

			const size = await content.write(id, data);
			tree.touch(id, size);
		},

		async appendFile(path, data, _options?) {
			const abs = posixResolve(cwd, path);
			const text =
				typeof data === 'string' ? data : new TextDecoder().decode(data);
			const id = tree.lookupId(abs);
			if (!id) return this.writeFile(abs, data, _options);

			const row = tree.getRow(id, abs);
			if (row.type === 'folder') throw fsError('EISDIR', abs);

			const newSize = await content.append(id, text);
			if (newSize === null) {
				await this.writeFile(path, data);
				return;
			}
			tree.touch(id, newSize);
		},

		// ═══════════════════════════════════════════════════════════════════════
		// STRUCTURE — mkdir, rm, cp, mv
		// ═══════════════════════════════════════════════════════════════════════

		async mkdir(path, options?) {
			const abs = posixResolve(cwd, path);
			if (tree.exists(abs)) {
				const existingId = tree.lookupId(abs);
				if (existingId) {
					const row = tree.getRow(existingId, abs);
					if (row.type === 'file') throw fsError('EEXIST', abs);
				}
				return;
			}

			if (options?.recursive) {
				const parts = abs.split('/').filter(Boolean);
				let currentPath = '';
				for (const part of parts) {
					currentPath += '/' + part;
					if (tree.exists(currentPath)) {
						const existingId = tree.lookupId(currentPath);
						if (existingId) {
							const existingRow = tree.getRow(existingId, currentPath);
							if (existingRow.type === 'file')
								throw fsError('ENOTDIR', currentPath);
						}
						continue;
					}
					const { parentId } = tree.parsePath(currentPath);
					tree.create({
						name: part,
						parentId,
						type: 'folder',
						size: 0,
					});
				}
			} else {
				const { parentId, name } = tree.parsePath(abs);
				tree.create({ name, parentId, type: 'folder', size: 0 });
			}
		},

		async rm(path, options?) {
			const abs = posixResolve(cwd, path);
			const id = tree.lookupId(abs);
			if (!id) {
				if (options?.force) return;
				throw fsError('ENOENT', abs);
			}
			const row = tree.getRow(id, abs);

			if (row.type === 'folder' && !options?.recursive) {
				if (tree.activeChildren(id).length > 0) throw fsError('ENOTEMPTY', abs);
			}

			// Soft-delete the row. The document binding's table observer
			// automatically cleans up the associated content doc.
			tree.softDelete(id);

			if (row.type === 'folder' && options?.recursive) {
				for (const did of tree.descendantIds(id)) {
					tree.softDelete(did);
				}
			}
		},

		async cp(src, dest, options?) {
			const resolvedSrc = posixResolve(cwd, src);
			const resolvedDest = posixResolve(cwd, dest);
			const srcId = tree.resolveId(resolvedSrc);
			if (srcId === null) throw fsError('EISDIR', resolvedSrc);
			const srcRow = tree.getRow(srcId, resolvedSrc);

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
				const srcBuffer = await content.readBuffer(srcId);
				const srcText = await content.read(srcId);
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
		},

		async mv(src, dest) {
			const resolvedSrc = posixResolve(cwd, src);
			const resolvedDest = posixResolve(cwd, dest);
			const id = tree.resolveId(resolvedSrc);
			if (id === null) throw fsError('EISDIR', resolvedSrc);
			tree.getRow(id, resolvedSrc);
			const { parentId: newParentId, name: newName } =
				tree.parsePath(resolvedDest);
			tree.move(id, newParentId, newName);
		},

		// ═══════════════════════════════════════════════════════════════════════
		// PATH RESOLUTION
		// ═══════════════════════════════════════════════════════════════════════

		resolvePath(base, path) {
			return posixResolve(base, path);
		},

		async realpath(path) {
			const abs = posixResolve(cwd, path);
			if (!tree.exists(abs)) throw fsError('ENOENT', abs);
			return abs;
		},

		getAllPaths() {
			return tree.allPaths();
		},

		// ═══════════════════════════════════════════════════════════════════════
		// PERMISSIONS / TIMESTAMPS — no-op in a collaborative system
		// ═══════════════════════════════════════════════════════════════════════

		async chmod(path, _mode) {
			const abs = posixResolve(cwd, path);
			tree.resolveId(abs);
		},

		async utimes(path, _atime, mtime) {
			const abs = posixResolve(cwd, path);
			const id = tree.resolveId(abs);
			if (id === null) return;
			tree.setMtime(id, mtime);
		},

		// ═══════════════════════════════════════════════════════════════════════
		// SYMLINKS / LINKS — not supported (always throws ENOSYS)
		// ═══════════════════════════════════════════════════════════════════════

		async symlink(_target, _linkPath) {
			throw fsError('ENOSYS', 'symlinks not supported');
		},

		async link(_existingPath, _newPath) {
			throw fsError('ENOSYS', 'hard links not supported');
		},

		async readlink(_path) {
			throw fsError('ENOSYS', 'symlinks not supported');
		},
	});
}

/** Inferred type of the virtual filesystem returned by {@link createYjsFileSystem}. */
export type YjsFileSystem = ReturnType<typeof createYjsFileSystem>;
