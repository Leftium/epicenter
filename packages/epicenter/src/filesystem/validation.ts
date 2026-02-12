import type { TableHelper } from '../static/types.js';
import type { FileId, FileRow } from './types.js';

type FsErrorCode =
	| 'ENOENT'
	| 'EISDIR'
	| 'EEXIST'
	| 'ENOSYS'
	| 'EINVAL'
	| 'ENOTEMPTY'
	| 'ENOTDIR';

/** Create an errno-style error with code property */
export function fsError(
	code: FsErrorCode,
	message: string,
): Error & { code: string } {
	const err = new Error(`${code}: ${message}`) as Error & { code: string };
	err.code = code;
	return err;
}

/** Validate a filename. Rejects path separators, null bytes, and reserved names. */
export function validateName(name: string): void {
	if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
		throw fsError('EINVAL', `invalid filename: ${name}`);
	}
	if (name === '' || name === '.' || name === '..') {
		throw fsError('EINVAL', `reserved filename: ${name}`);
	}
}

/**
 * Assert that no active (non-trashed) sibling has the same name.
 * Throws EEXIST if a duplicate exists.
 */
export function assertUniqueName(
	filesTable: TableHelper<FileRow>,
	childrenOf: Map<FileId | null, FileId[]>,
	parentId: FileId | null,
	name: string,
	excludeId?: FileId,
): void {
	const siblingIds = childrenOf.get(parentId) ?? [];
	const duplicate = siblingIds.find((id) => {
		if (id === excludeId) return false;
		const result = filesTable.get(id);
		if (result.status !== 'valid') return false;
		return result.row.name === name && result.row.trashedAt === null;
	});
	if (duplicate) {
		throw fsError('EEXIST', `${name} already exists in parent`);
	}
}

/**
 * Assign display names for a set of sibling rows, disambiguating CRDT conflicts.
 * Earliest createdAt keeps the clean name; later entries get suffixed.
 */
export function disambiguateNames(rows: FileRow[]): Map<string, string> {
	const result = new Map<string, string>();
	const byName = new Map<string, FileRow[]>();

	for (const row of rows) {
		const group = byName.get(row.name) ?? [];
		group.push(row);
		byName.set(row.name, group);
	}

	for (const [name, group] of byName) {
		if (group.length === 1) {
			result.set(group[0]!.id, name);
			continue;
		}
		// Sort by createdAt — earliest keeps clean name
		group.sort((a, b) => a.createdAt - b.createdAt);
		result.set(group[0]!.id, name);
		for (let i = 1; i < group.length; i++) {
			const row = group[i]!;
			const dotIndex = name.lastIndexOf('.');
			const hasExt = dotIndex > 0;
			const base = hasExt ? name.slice(0, dotIndex) : name;
			const ext = hasExt ? name.slice(dotIndex) : '';
			result.set(row.id, `${base} (${i})${ext}`);
		}
	}
	return result;
}
