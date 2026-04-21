import type { Table } from '@epicenter/workspace';
import type { FileId } from '../ids.js';
import type { FileRow } from '../table.js';
import { disambiguateNames } from './naming.js';

const MAX_DEPTH = 50;

/** Path-relevant fields tracked per row for incremental change detection. */
type RowSnapshot = {
	name: string;
	parentId: FileId | null;
	trashedAt: number | null;
};

function snapFrom(row: FileRow): RowSnapshot {
	return { name: row.name, parentId: row.parentId, trashedAt: row.trashedAt };
}

/**
 * Create runtime indexes for O(1) path lookups from a files table.
 *
 * Uses incremental updates: the observer classifies each changed row and
 * patches only the affected index entries instead of rebuilding everything.
 * Touch-only changes (size/updatedAt) are detected via a snapshot of
 * path-relevant fields and skipped entirely—O(1) per editing mutation.
 */
export function createFileSystemIndex(filesTable: Table<FileRow>) {
	/** "/docs/api.md" → FileId */
	const pathToId = new Map<string, FileId>();
	/** FileId → "/docs/api.md" (reverse lookup) */
	const idToPath = new Map<FileId, string>();
	/** parentId (null = root) → set of childIds */
	const childrenOf = new Map<FileId | null, Set<FileId>>();

	/** Previous path-relevant state for change detection. */
	const snapshot = new Map<FileId, RowSnapshot>();
	/** FileId → display name (may differ from row.name when disambiguated). */
	const displayName = new Map<FileId, string>();

	/** Suppresses the observer during rebuild to avoid processing partial state. */
	let rebuilding = false;

	rebuild();

	const unobserve = filesTable.observe((changedIds) => {
		if (rebuilding) return;
		processChanges(changedIds);
	});

	// ═══════════════════════════════════════════════════════════════════════
	// FULL REBUILD — initial load and recovery
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Recompute all indexes from scratch: childrenOf, path mappings,
	 * and self-healing fixes for circular refs and orphans.
	 *
	 * Called once at construction. Can be called manually for recovery.
	 */
	function rebuild() {
		rebuilding = true;
		pathToId.clear();
		idToPath.clear();
		childrenOf.clear();
		snapshot.clear();
		displayName.clear();

		// getAllValid() returns fresh objects (parseRow spreads input), so we
		// can safely mutate parentId on these locals to track fix-up changes
		// without re-scanning the whole table.
		const activeRows = filesTable
			.getAllValid()
			.filter((r) => r.trashedAt === null);

		for (const id of fixCircularReferences(filesTable, activeRows)) {
			const row = activeRows.find((r) => r.id === id);
			if (row) row.parentId = null;
		}

		for (const row of activeRows) {
			addChild(row.parentId, row.id);
		}

		for (const id of fixOrphans(filesTable, activeRows, childrenOf)) {
			const row = activeRows.find((r) => r.id === id);
			if (row) row.parentId = null;
		}

		for (const [, childIds] of childrenOf) {
			disambiguateFolder(childIds);
		}

		buildPathsFromRoot();

		for (const row of activeRows) {
			snapshot.set(row.id, snapFrom(row));
		}
		rebuilding = false;
	}

	// ═══════════════════════════════════════════════════════════════════════
	// INCREMENTAL UPDATE — the hot path
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Process a set of changed row IDs incrementally.
	 *
	 * Classifies each change by comparing current state against the snapshot,
	 * then patches only the affected index entries. Touch-only changes
	 * (size/updatedAt) are O(1) — detected and skipped immediately.
	 */
	function processChanges(changedIds: ReadonlySet<string>) {
		const foldersToDisambiguate = new Set<FileId | null>();
		const idsNeedingPaths = new Set<FileId>();

		for (const rawId of changedIds) {
			const id = rawId as FileId;
			const result = filesTable.get(id);
			const prev = snapshot.get(id);

			const isActive =
				result.status === 'valid' && result.row.trashedAt === null;
			const wasActive = prev !== undefined && prev.trashedAt === null;

			if (!wasActive && !isActive) {
				// Was inactive, still inactive. Keep the snapshot current for
				// inactive rows so transitions later classify correctly.
				if (prev && result.status === 'valid') {
					snapshot.set(id, snapFrom(result.row));
				}
				continue;
			}

			if (!wasActive && isActive) {
				// CREATED or RESTORED
				const row = (result as { status: 'valid'; row: FileRow }).row;
				addChild(row.parentId, id);
				snapshot.set(id, snapFrom(row));
				foldersToDisambiguate.add(row.parentId);
				idsNeedingPaths.add(id);
				continue;
			}

			// Both remaining branches require prev — this is unreachable since
			// wasActive implies prev !== undefined, but the guard gives TS
			// narrowing without non-null assertions.
			if (!prev) continue;

			if (wasActive && !isActive) {
				// TRASHED or DELETED
				clearPathsRecursive(id);
				removeChild(prev.parentId, id);

				// Children of this node become orphans at the index level.
				// Move them to root in the index (don't mutate table — rebuild handles that).
				const orphanedChildren = childrenOf.get(id);
				if (orphanedChildren && orphanedChildren.size > 0) {
					// Copy required: removeChild mutates this very set.
					for (const childId of [...orphanedChildren]) {
						removeChild(id, childId);
						addChild(null, childId);
						const childSnap = snapshot.get(childId);
						if (childSnap) {
							snapshot.set(childId, { ...childSnap, parentId: null });
						}
						clearPathsRecursive(childId);
						foldersToDisambiguate.add(null);
						idsNeedingPaths.add(childId);
						collectDescendantIds(childId, idsNeedingPaths);
					}
				}

				if (result.status === 'not_found') {
					snapshot.delete(id);
				} else if (result.status === 'valid') {
					snapshot.set(id, snapFrom(result.row));
				}

				displayName.delete(id);
				foldersToDisambiguate.add(prev.parentId);
				continue;
			}

			// wasActive && isActive — row is still active, check what changed.
			const row = (result as { status: 'valid'; row: FileRow }).row;

			const parentChanged = prev.parentId !== row.parentId;
			const nameChanged = prev.name !== row.name;

			if (!parentChanged && !nameChanged) {
				// TOUCHED — only size/updatedAt changed. No index work needed.
				continue;
			}

			if (parentChanged) {
				// MOVED
				removeChild(prev.parentId, id);
				addChild(row.parentId, id);
				foldersToDisambiguate.add(prev.parentId);
				foldersToDisambiguate.add(row.parentId);
			} else {
				// RENAMED (same parent, different name)
				foldersToDisambiguate.add(row.parentId);
			}

			clearPathsRecursive(id);
			snapshot.set(id, snapFrom(row));
			idsNeedingPaths.add(id);
			collectDescendantIds(id, idsNeedingPaths);
		}

		// Disambiguate affected folders
		for (const parentId of foldersToDisambiguate) {
			const childIds = childrenOf.get(parentId);
			if (!childIds) continue;
			const namesChanged = disambiguateFolder(childIds);

			// If any display name changed, those IDs need path recomputation
			for (const id of namesChanged) {
				clearPathsRecursive(id);
				idsNeedingPaths.add(id);
				collectDescendantIds(id, idsNeedingPaths);
			}
		}

		// Recompute paths for all affected IDs
		if (idsNeedingPaths.size > 0) {
			computePathsConvergent(idsNeedingPaths);
		}
	}

	// ═══════════════════════════════════════════════════════════════════════
	// INDEX HELPERS
	// ═══════════════════════════════════════════════════════════════════════

	function addChild(parentId: FileId | null, childId: FileId): void {
		let children = childrenOf.get(parentId);
		if (!children) {
			children = new Set();
			childrenOf.set(parentId, children);
		}
		children.add(childId);
	}

	function removeChild(parentId: FileId | null, childId: FileId): void {
		childrenOf.get(parentId)?.delete(childId);
	}

	/** Remove path entries for an ID and all its descendants. */
	function clearPathsRecursive(id: FileId): void {
		const oldPath = idToPath.get(id);
		if (oldPath) {
			pathToId.delete(oldPath);
			idToPath.delete(id);
		}
		const children = childrenOf.get(id);
		if (children) {
			for (const childId of children) {
				clearPathsRecursive(childId);
			}
		}
	}

	/** Collect all descendant IDs of a node into a set. */
	function collectDescendantIds(id: FileId, out: Set<FileId>): void {
		const children = childrenOf.get(id);
		if (!children) return;
		for (const childId of children) {
			out.add(childId);
			collectDescendantIds(childId, out);
		}
	}

	/**
	 * Run disambiguation for a folder's children. Updates the displayName map.
	 *
	 * @returns IDs whose display name changed (need path recomputation).
	 */
	function disambiguateFolder(childIds: Iterable<FileId>): FileId[] {
		const changed: FileId[] = [];
		const childRows: FileRow[] = [];

		for (const cid of childIds) {
			const result = filesTable.get(cid);
			if (result.status === 'valid' && result.row.trashedAt === null) {
				childRows.push(result.row);
			}
		}

		const names = disambiguateNames(childRows);

		for (const [id, newName] of names) {
			const fid = id as FileId;
			const oldName = displayName.get(fid);
			displayName.set(fid, newName);
			if (oldName !== undefined && oldName !== newName) {
				changed.push(fid);
			}
		}

		return changed;
	}

	/**
	 * Compute paths for a set of IDs using a convergent loop.
	 *
	 * Processes root-level nodes first (their parent path is known: ""),
	 * then their children become computable, and so on. Converges in
	 * O(maxDepth) iterations. Remaining IDs after convergence are orphans
	 * at the index level — placed at root.
	 */
	function computePathsConvergent(ids: Set<FileId>): void {
		const pending = new Set(ids);
		let progress = true;
		let iterations = 0;

		while (progress && pending.size > 0 && iterations < MAX_DEPTH) {
			progress = false;
			iterations++;

			for (const id of pending) {
				const snap = snapshot.get(id);
				if (!snap || snap.trashedAt !== null) {
					pending.delete(id);
					continue;
				}

				const name = displayName.get(id) ?? snap.name;

				if (snap.parentId === null) {
					// Root level — always computable
					const path = `/${name}`;
					pathToId.set(path, id);
					idToPath.set(id, path);
					pending.delete(id);
					progress = true;
				} else {
					const parentPath = idToPath.get(snap.parentId);
					if (parentPath !== undefined) {
						// Parent path known — compute child path
						const path = `${parentPath}/${name}`;
						pathToId.set(path, id);
						idToPath.set(id, path);
						pending.delete(id);
						progress = true;
					}
				}
			}
		}

		// Remaining IDs are orphans at the index level — place at root
		for (const id of pending) {
			const snap = snapshot.get(id);
			if (!snap || snap.trashedAt !== null) continue;
			const name = displayName.get(id) ?? snap.name;
			const path = `/${name}`;
			pathToId.set(path, id);
			idToPath.set(id, path);
		}
	}

	/**
	 * Build all paths from root downward using childrenOf and displayNames.
	 * Used by rebuild() after disambiguation.
	 */
	function buildPathsFromRoot(): void {
		const queue: Array<{ id: FileId; parentPath: string }> = [];

		// Start with root-level children
		const roots = childrenOf.get(null);
		if (roots) {
			for (const id of roots) {
				queue.push({ id, parentPath: '' });
			}
		}

		let depth = 0;
		while (queue.length > 0 && depth < MAX_DEPTH) {
			const batch = queue.splice(0, queue.length);
			depth++;

			for (const { id, parentPath } of batch) {
				const name = displayName.get(id);
				if (!name) continue;

				const path = `${parentPath}/${name}`;
				pathToId.set(path, id);
				idToPath.set(id, path);

				// Enqueue children of folders
				const children = childrenOf.get(id);
				if (children) {
					for (const childId of children) {
						queue.push({ id: childId, parentPath: path });
					}
				}
			}
		}
	}

	// ═══════════════════════════════════════════════════════════════════════
	// PUBLIC API (unchanged interface)
	// ═══════════════════════════════════════════════════════════════════════

	return {
		/** Look up the FileId for a resolved absolute path. */
		getIdByPath(path: string): FileId | undefined {
			return pathToId.get(path);
		},
		/** Check whether a path exists in the index. */
		hasPath(path: string): boolean {
			return pathToId.has(path);
		},
		/** Get all indexed paths. */
		allPaths(): string[] {
			return Array.from(pathToId.keys());
		},
		/** Number of indexed paths. */
		get pathCount(): number {
			return pathToId.size;
		},
		/** Get child IDs of a parent (null = root). Returns [] if none. */
		getChildIds(parentId: FileId | null): FileId[] {
			const children = childrenOf.get(parentId);
			return children ? Array.from(children) : [];
		},
		/** Stop observing the files table. */
		dispose: unobserve,
	};
}

/** Runtime indexes for O(1) path lookups (ephemeral, not stored in Yjs) */
export type FileSystemIndex = ReturnType<typeof createFileSystemIndex>;

// ═══════════════════════════════════════════════════════════════════════════
// REBUILD-ONLY HELPERS (circular refs + orphans — mutate the table)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Detect circular references in parentId chains.
 * If a cycle is found, break it by setting the later-timestamped node's parentId to null.
 *
 * @returns Set of IDs whose parentId was mutated to null.
 */
function fixCircularReferences(
	filesTable: Table<FileRow>,
	activeRows: FileRow[],
): Set<FileId> {
	const visited = new Set<FileId>();
	const inStack = new Set<FileId>();
	const mutated = new Set<FileId>();

	for (const row of activeRows) {
		if (visited.has(row.id)) continue;
		detectCycle(row.id, filesTable, visited, inStack, mutated);
	}

	return mutated;
}

function detectCycle(
	startId: FileId,
	filesTable: Table<FileRow>,
	visited: Set<FileId>,
	inStack: Set<FileId>,
	mutated: Set<FileId>,
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
			if (cycleIds.length === 0) return;

			let latestId = cycleIds[0];
			if (!latestId) return;
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
			mutated.add(latestId);
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
 *
 * Mutates childrenOf to reflect the reparenting.
 *
 * @returns Set of IDs whose parentId was mutated to null.
 */
function fixOrphans(
	filesTable: Table<FileRow>,
	activeRows: FileRow[],
	childrenOf: Map<FileId | null, Set<FileId>>,
): Set<FileId> {
	const activeIds = new Set(activeRows.map((r) => r.id));
	const mutated = new Set<FileId>();

	for (const row of activeRows) {
		if (row.parentId === null) continue;
		if (activeIds.has(row.parentId)) continue;

		// Parent doesn't exist among active rows — orphan
		filesTable.update(row.id, { parentId: null });
		mutated.add(row.id);

		// Update childrenOf: remove from ghost parent bucket, add to root
		childrenOf.get(row.parentId)?.delete(row.id);
		let rootChildren = childrenOf.get(null);
		if (!rootChildren) {
			rootChildren = new Set();
			childrenOf.set(null, rootChildren);
		}
		rootChildren.add(row.id);
	}

	return mutated;
}
