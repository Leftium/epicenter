import type { IFileSystem, FsStat, CpOptions, MkdirOptions, RmOptions, FileContent } from 'just-bash';
import type { TableHelper } from '../static/types.js';
import { generateGuid } from '../dynamic/schema/fields/id.js';
import type { ContentDocPool, FileRow, FileSystemIndex } from './types.js';
import { ROOT_ID } from './types.js';
import {
	parseFrontmatter,
	updateYMapFromRecord,
	updateYXmlFragmentFromString,
} from './markdown-helpers.js';
import { assertUniqueName, disambiguateNames, fsError, validateName } from './validation.js';
import { getExtensionCategory } from './convert-on-switch.js';

type DirentEntry = {
	name: string;
	isFile: boolean;
	isDirectory: boolean;
	isSymbolicLink: boolean;
};

function posixResolve(base: string, path: string): string {
	// If path is absolute, use it directly
	let resolved = path.startsWith('/') ? path : base.replace(/\/$/, '') + '/' + path;

	// Normalize: remove double slashes, resolve . and ..
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

export class YjsFileSystem implements IFileSystem {
	constructor(
		private filesTable: TableHelper<FileRow>,
		private index: FileSystemIndex,
		private pool: ContentDocPool,
		private cwd: string = '/',
	) {}

	// ═══════════════════════════════════════════════════════════════════════
	// READS (metadata only — fast)
	// ═══════════════════════════════════════════════════════════════════════

	async readdir(path: string): Promise<string[]> {
		const resolved = posixResolve(this.cwd, path);
		const id = this.resolveId(resolved);
		this.assertDirectory(id, resolved);
		const childIds = this.index.childrenOf.get(id) ?? [];
		const activeChildren = this.getActiveChildren(childIds);
		const displayNames = disambiguateNames(activeChildren);
		return activeChildren.map((row) => displayNames.get(row.id)!).sort();
	}

	async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
		const resolved = posixResolve(this.cwd, path);
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
		const resolved = posixResolve(this.cwd, path);
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
		const id = this.resolveId(resolved);
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
		const resolved = posixResolve(this.cwd, path);
		return resolved === '/' || this.index.pathToId.has(resolved);
	}

	// ═══════════════════════════════════════════════════════════════════════
	// READS (content — may load content doc)
	// ═══════════════════════════════════════════════════════════════════════

	async readFile(path: string, _options?: { encoding?: string | null } | string): Promise<string> {
		const resolved = posixResolve(this.cwd, path);
		const id = this.resolveId(resolved);
		const row = this.getRow(id, resolved);
		if (row.type === 'folder') throw fsError('EISDIR', resolved);

		// Fast path: plaintext cache
		const cached = this.index.plaintext.get(id);
		if (cached !== undefined) return cached;

		// Slow path: load content doc
		const text = this.pool.loadAndCache(id, row.name);
		this.index.plaintext.set(id, text);
		return text;
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		const text = await this.readFile(path);
		return new TextEncoder().encode(text);
	}

	// ═══════════════════════════════════════════════════════════════════════
	// WRITES
	// ═══════════════════════════════════════════════════════════════════════

	async writeFile(path: string, data: FileContent, _options?: { encoding?: string } | string): Promise<void> {
		const resolved = posixResolve(this.cwd, path);
		const content = typeof data === 'string' ? data : new TextDecoder().decode(data);
		let id = this.index.pathToId.get(resolved);

		if (!id) {
			// Create file: parse path into parentId + name, ensure parent exists
			const { parentId, name } = this.parsePath(resolved);
			validateName(name);
			assertUniqueName(this.filesTable, this.index.childrenOf, parentId, name);
			id = generateGuid();
			this.filesTable.set({
				id,
				name,
				parentId,
				type: 'file',
				size: new TextEncoder().encode(content).byteLength,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				trashedAt: null,
			});
		}

		// Write content through Yjs
		const row = this.getRow(id, resolved);
		const handle = this.pool.acquire(id, row.name);
		try {
			if (handle.type === 'text') {
				handle.ydoc.transact(() => {
					handle.content.delete(0, handle.content.length);
					handle.content.insert(0, content);
				});
			} else {
				const { frontmatter, body } = parseFrontmatter(content);
				updateYMapFromRecord(handle.frontmatter, frontmatter);
				updateYXmlFragmentFromString(handle.content, body);
			}
		} finally {
			this.pool.release(id);
		}

		this.filesTable.update(id, {
			size: new TextEncoder().encode(content).byteLength,
			updatedAt: Date.now(),
		});
		this.index.plaintext.set(id, content);
	}

	async appendFile(path: string, data: FileContent, _options?: { encoding?: string } | string): Promise<void> {
		const resolved = posixResolve(this.cwd, path);
		const content = typeof data === 'string' ? data : new TextDecoder().decode(data);
		const id = this.index.pathToId.get(resolved);
		if (!id) return this.writeFile(resolved, data, _options);

		// Read existing content, append, and do a full write
		const existing = await this.readFile(resolved);
		const fullText = existing + content;
		await this.writeFile(resolved, fullText);
	}

	// ═══════════════════════════════════════════════════════════════════════
	// STRUCTURE
	// ═══════════════════════════════════════════════════════════════════════

	async mkdir(path: string, options?: MkdirOptions): Promise<void> {
		const resolved = posixResolve(this.cwd, path);
		if (await this.exists(resolved)) return; // mkdir on existing dir is a no-op

		if (options?.recursive) {
			// Create all missing ancestors from root down
			const parts = resolved.split('/').filter(Boolean);
			let currentPath = '';
			for (const part of parts) {
				currentPath += '/' + part;
				if (await this.exists(currentPath)) continue;
				validateName(part);
				const { parentId } = this.parsePath(currentPath);
				assertUniqueName(this.filesTable, this.index.childrenOf, parentId, part);
				this.filesTable.set({
					id: generateGuid(),
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
				id: generateGuid(),
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
		const resolved = posixResolve(this.cwd, path);
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
		this.index.plaintext.delete(id);

		// If recursive, soft-delete children too
		if (row.type === 'folder' && options?.recursive) {
			this.softDeleteDescendants(id);
		}
	}

	async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
		const resolvedSrc = posixResolve(this.cwd, src);
		const resolvedDest = posixResolve(this.cwd, dest);
		const srcId = this.resolveId(resolvedSrc);
		const srcRow = this.getRow(srcId, resolvedSrc);

		if (srcRow.type === 'folder') {
			if (!options?.recursive) throw fsError('EISDIR', resolvedSrc);
			await this.mkdir(resolvedDest, { recursive: true });
			const children = await this.readdir(resolvedSrc);
			for (const child of children) {
				await this.cp(`${resolvedSrc}/${child}`, `${resolvedDest}/${child}`, options);
			}
		} else {
			const content = await this.readFile(resolvedSrc);
			await this.writeFile(resolvedDest, content);
		}
	}

	async mv(src: string, dest: string): Promise<void> {
		const resolvedSrc = posixResolve(this.cwd, src);
		const resolvedDest = posixResolve(this.cwd, dest);
		const id = this.resolveId(resolvedSrc);
		const row = this.getRow(id, resolvedSrc);
		const { parentId: newParentId, name: newName } = this.parsePath(resolvedDest);
		validateName(newName);
		assertUniqueName(this.filesTable, this.index.childrenOf, newParentId, newName, id);

		// Detect extension category change and re-write content through new type
		if (row.type === 'file') {
			const fromCategory = getExtensionCategory(row.name);
			const toCategory = getExtensionCategory(newName);
			if (fromCategory !== toCategory) {
				// Read existing content before any changes
				const content = await this.readFile(resolvedSrc);
				this.index.plaintext.delete(id);
				// Update metadata first (triggers index rebuild, new path resolves)
				this.filesTable.update(id, {
					name: newName,
					parentId: newParentId,
					updatedAt: Date.now(),
				});
				// Re-write content through the new type handler
				await this.writeFile(resolvedDest, content);
				return;
			}
		}

		this.filesTable.update(id, {
			name: newName,
			parentId: newParentId,
			updatedAt: Date.now(),
		});
	}

	// ═══════════════════════════════════════════════════════════════════════
	// PERMISSIONS (no-op in collaborative system)
	// ═══════════════════════════════════════════════════════════════════════

	async chmod(path: string, _mode: number): Promise<void> {
		const resolved = posixResolve(this.cwd, path);
		this.resolveId(resolved); // throws ENOENT if doesn't exist
	}

	async utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
		const resolved = posixResolve(this.cwd, path);
		const id = this.resolveId(resolved);
		this.filesTable.update(id, { updatedAt: mtime.getTime() });
	}

	// ═══════════════════════════════════════════════════════════════════════
	// SYMLINKS / LINKS (not supported)
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
	// PATH RESOLUTION
	// ═══════════════════════════════════════════════════════════════════════

	resolvePath(base: string, path: string): string {
		return posixResolve(base, path);
	}

	async realpath(path: string): Promise<string> {
		const resolved = posixResolve(this.cwd, path);
		if (!(await this.exists(resolved))) throw fsError('ENOENT', resolved);
		return resolved;
	}

	getAllPaths(): string[] {
		return Array.from(this.index.pathToId.keys()).filter((p) => p !== '/');
	}

	// ═══════════════════════════════════════════════════════════════════════
	// PRIVATE HELPERS
	// ═══════════════════════════════════════════════════════════════════════

	private resolveId(path: string): string {
		if (path === '/') return ROOT_ID;
		const id = this.index.pathToId.get(path);
		if (!id) throw fsError('ENOENT', path);
		return id;
	}

	private getRow(id: string, path: string): FileRow {
		const result = this.filesTable.get(id);
		if (result.status !== 'valid') throw fsError('ENOENT', path);
		return result.row;
	}

	private assertDirectory(id: string, path: string): void {
		if (id === ROOT_ID) return;
		const row = this.getRow(id, path);
		if (row.type !== 'folder') throw fsError('ENOTDIR', path);
	}

	private getActiveChildren(childIds: string[]): FileRow[] {
		const rows: FileRow[] = [];
		for (const cid of childIds) {
			const result = this.filesTable.get(cid);
			if (result.status === 'valid' && result.row.trashedAt === null) {
				rows.push(result.row);
			}
		}
		return rows;
	}

	private parsePath(path: string): { parentId: string | null; name: string } {
		const normalized = posixResolve(this.cwd, path);
		const lastSlash = normalized.lastIndexOf('/');
		const name = normalized.substring(lastSlash + 1);
		const parentPath = normalized.substring(0, lastSlash) || '/';
		if (parentPath === '/') return { parentId: null, name };
		const parentId = this.index.pathToId.get(parentPath);
		if (!parentId) throw fsError('ENOENT', parentPath);
		return { parentId, name };
	}

	private softDeleteDescendants(parentId: string): void {
		const children = this.index.childrenOf.get(parentId) ?? [];
		for (const cid of children) {
			const result = this.filesTable.get(cid);
			if (result.status !== 'valid' || result.row.trashedAt !== null) continue;
			this.filesTable.update(cid, { trashedAt: Date.now() });
			this.index.plaintext.delete(cid);
			if (result.row.type === 'folder') {
				this.softDeleteDescendants(cid);
			}
		}
	}
}
