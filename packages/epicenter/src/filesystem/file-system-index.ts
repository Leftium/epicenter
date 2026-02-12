import type { TableHelper } from '../static/types.js';
import type { FileId, FileRow, FileSystemIndex } from './types.js';
import { disambiguateNames } from './validation.js';

const MAX_DEPTH = 50;

/**
 * Create runtime indexes for O(1) path lookups from a files table.
 * Subscribes to filesTable.observe() for incremental updates.
 */
export function createFileSystemIndex(
	filesTable: TableHelper<FileRow>,
): FileSystemIndex & { destroy(): void } {
	const pathToId = new Map<string, FileId>();
	const childrenOf = new Map<FileId | null, FileId[]>();

	rebuild();

	const unobserve = filesTable.observe((changedIds) => {
		update(changedIds);
	});

	function rebuild() {
		pathToId.clear();
		childrenOf.clear();

		const rows = filesTable.getAllValid();
		const activeRows = rows.filter((r) => r.trashedAt === null);

		// Build childrenOf index
		for (const row of activeRows) {
			const children = childrenOf.get(row.parentId) ?? [];
			children.push(row.id);
			childrenOf.set(row.parentId, children);
		}

		// Detect and fix circular references
		fixCircularReferences(filesTable, activeRows);

		// Detect and fix orphans
		fixOrphans(filesTable, activeRows, childrenOf);

		// Build path indexes with disambiguation
		buildPaths(filesTable, childrenOf, pathToId);
	}

	function update(_changedIds: Set<string>) {
		// Full rebuild on changes. The files table is always in memory
		// so this is fast (O(n) where n = total files).
		rebuild();
	}

	return {
		pathToId,
		childrenOf,
		destroy: unobserve,
	};
}

/** Walk parentId chain to compute a file's path */
function computePath(
	id: FileId,
	filesTable: TableHelper<FileRow>,
	displayNames: Map<string, string>,
): string | null {
	const parts: string[] = [];
	let currentId: FileId | null = id;
	let depth = 0;

	while (currentId !== null && depth < MAX_DEPTH) {
		const result = filesTable.get(currentId);
		if (result.status !== 'valid') return null;

		const displayName = displayNames.get(currentId) ?? result.row.name;
		parts.unshift(displayName);
		currentId = result.row.parentId;
		depth++;
	}

	if (depth >= MAX_DEPTH) return null; // Circular reference or unreasonably deep
	return '/' + parts.join('/');
}

/** Build path indexes for all active rows */
function buildPaths(
	filesTable: TableHelper<FileRow>,
	childrenOf: Map<FileId | null, FileId[]>,
	pathToId: Map<string, FileId>,
) {
	// Compute display names per parent (handles CRDT duplicate names)
	const allDisplayNames = new Map<string, string>();

	for (const [, childIds] of childrenOf) {
		const childRows: FileRow[] = [];
		for (const cid of childIds) {
			const result = filesTable.get(cid);
			if (result.status === 'valid' && result.row.trashedAt === null) {
				childRows.push(result.row);
			}
		}
		const names = disambiguateNames(childRows);
		for (const [id, name] of names) {
			allDisplayNames.set(id, name);
		}
	}

	// Build paths for all active files
	const rows = filesTable.getAllValid();
	for (const row of rows) {
		if (row.trashedAt !== null) continue;
		const path = computePath(row.id, filesTable, allDisplayNames);
		if (path) {
			pathToId.set(path, row.id);
		}
	}
}

/**
 * Detect circular references in parentId chains.
 * If a cycle is found, break it by setting the later-timestamped node's parentId to null.
 */
function fixCircularReferences(
	filesTable: TableHelper<FileRow>,
	activeRows: FileRow[],
) {
	const visited = new Set<FileId>();
	const inStack = new Set<FileId>();

	for (const row of activeRows) {
		if (visited.has(row.id)) continue;
		detectCycle(row.id, filesTable, visited, inStack);
	}
}

function detectCycle(
	startId: FileId,
	filesTable: TableHelper<FileRow>,
	visited: Set<FileId>,
	inStack: Set<FileId>,
) {
	const path: FileId[] = [];
	let currentId: FileId | null = startId;

	while (currentId !== null) {
		if (visited.has(currentId)) break; // Known safe — clean up and return

		if (inStack.has(currentId)) {
			// Cycle detected — break it by moving the current node to root
			// Find the node in the cycle with the latest updatedAt
			const cycleStart = path.indexOf(currentId);
			const cycleIds = path.slice(cycleStart);

			let latestId = cycleIds[0]!;
			let latestTime = 0;
			for (const cid of cycleIds) {
				const result = filesTable.get(cid);
				if (result.status === 'valid' && result.row.updatedAt > latestTime) {
					latestTime = result.row.updatedAt;
					latestId = cid;
				}
			}

			// Break cycle by moving latest-updated node to root
			filesTable.update(latestId, { parentId: null });
			return;
		}

		inStack.add(currentId);
		path.push(currentId);

		const result = filesTable.get(currentId);
		if (result.status !== 'valid') break;
		currentId = result.row.parentId;
	}

	// Mark all nodes in this path as visited
	for (const id of path) {
		visited.add(id);
		inStack.delete(id);
	}
}

/**
 * Detect orphaned files (parentId references a deleted or non-existent row).
 * Move orphans to root by setting parentId to null.
 */
function fixOrphans(
	filesTable: TableHelper<FileRow>,
	activeRows: FileRow[],
	childrenOf: Map<FileId | null, FileId[]>,
) {
	const activeIds = new Set(activeRows.map((r) => r.id));

	for (const row of activeRows) {
		if (row.parentId === null) continue;
		if (activeIds.has(row.parentId)) continue;

		// Parent doesn't exist among active rows — orphan
		filesTable.update(row.id, { parentId: null });

		// Update childrenOf index
		const oldChildren = childrenOf.get(row.parentId) ?? [];
		childrenOf.set(
			row.parentId,
			oldChildren.filter((id) => id !== row.id),
		);
		const rootChildren = childrenOf.get(null) ?? [];
		rootChildren.push(row.id);
		childrenOf.set(null, rootChildren);
	}
}
