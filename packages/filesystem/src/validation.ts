import type { TableHelper } from '@epicenter/workspace';
import type { FileId, FileRow } from './types.js';

export type FsErrorCode =
	| 'ENOENT'
	| 'EISDIR'
	| 'EEXIST'
	| 'ENOSYS'
	| 'EINVAL'
	| 'ENOTEMPTY'
	| 'ENOTDIR';

/** Create an errno-style error with code property */
function fsError(
	code: FsErrorCode,
	message: string,
): Error & { code: FsErrorCode } {
	const err = new Error(`${code}: ${message}`) as Error & { code: FsErrorCode };
	err.code = code;
	return err;
}

/**
 * Namespace of errno-style error factories for the virtual filesystem.
 *
 * Each method creates an `Error` with a `.code` property and a message
 * formatted as `"CODE: message"`. Type `FS_ERRORS.` to browse all
 * available codes via dot-autocomplete.
 *
 * @example
 * ```typescript
 * throw FS_ERRORS.ENOENT('/missing.txt');
 * throw FS_ERRORS.EISDIR('/some/dir');
 * throw FS_ERRORS.ENOSYS('symlinks not supported');
 * ```
 */
export const FS_ERRORS = {
	ENOENT: (message: string) => fsError('ENOENT', message),
	EISDIR: (message: string) => fsError('EISDIR', message),
	EEXIST: (message: string) => fsError('EEXIST', message),
	ENOSYS: (message: string) => fsError('ENOSYS', message),
	EINVAL: (message: string) => fsError('EINVAL', message),
	ENOTEMPTY: (message: string) => fsError('ENOTEMPTY', message),
	ENOTDIR: (message: string) => fsError('ENOTDIR', message),
} satisfies Record<
	FsErrorCode,
	(message: string) => Error & { code: FsErrorCode }
>;

/** Validate a filename. Rejects path separators, null bytes, and reserved names. */
export function validateName(name: string): void {
	if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
		throw FS_ERRORS.EINVAL(`invalid filename: ${name}`);
	}
	if (name === '' || name === '.' || name === '..') {
		throw FS_ERRORS.EINVAL(`reserved filename: ${name}`);
	}
}

/**
 * Assert that no active (non-trashed) sibling has the same name.
 * Throws EEXIST if a duplicate exists.
 */
export function assertUniqueName(
	filesTable: TableHelper<FileRow>,
	siblingIds: FileId[],
	name: string,
	excludeId?: FileId,
): void {
	const duplicate = siblingIds.find((id) => {
		if (id === excludeId) return false;
		const result = filesTable.get(id);
		if (result.status !== 'valid') return false;
		return result.row.name === name && result.row.trashedAt === null;
	});
	if (duplicate) {
		throw FS_ERRORS.EEXIST(`${name} already exists in parent`);
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
