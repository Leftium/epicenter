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
